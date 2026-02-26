// delayOrchestrator — triggered by EventBridge nightly at 00:00 GMT
// Scans all active SCHEDULE# records across all users.
// Groups them into chunks of 1,000 routes and enqueues each chunk to SQS.
// Worker Lambdas (delayWorker) process each chunk concurrently.
//
// Idempotency lock stored in SSM Parameter Store — not in userRouteDB.
// SSM is the correct home for system-level coordination state.
// Lock is a simple string parameter written at start, deleted on completion.
// Has a TTL-equivalent via a timestamp check — if the lock is older than
// LOCK_MAX_AGE_MS the orchestrator treats it as stale and overwrites it.
// A CloudWatch alarm on orchestrator errors covers the stuck-lock scenario.

const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { SQSClient, SendMessageBatchCommand } = require('@aws-sdk/client-sqs');
const { SSMClient, PutParameterCommand, DeleteParameterCommand, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { chunkArray } = require('/opt/nodejs/utils');

const dynamo = new DynamoDBClient({});
const sqs = new SQSClient({});
const ssm = new SSMClient({});

const USER_ROUTE_TABLE = process.env.USER_ROUTE_TABLE;
const DELAY_WORKER_QUEUE_URL = process.env.DELAY_WORKER_QUEUE_URL;
const CHUNK_SIZE = 1000;

const LOCK_PARAM = '/routeApp/orchestratorLock';
const LOCK_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour — treat lock as stale after this

// ─── SSM Idempotency Lock ─────────────────────────────────────────────────────
// Stored in SSM Parameter Store — system coordination state belongs here,
// not in userRouteDB alongside user data.
// Uses an overwrite-with-staleness-check pattern:
//   - Write lock with current timestamp
//   - If lock already exists and is recent, exit
//   - If lock is stale (> 1 hour old), overwrite — previous run likely crashed

const acquireLock = async () => {
  try {
    // Check if a lock already exists
    const existing = await ssm.send(new GetParameterCommand({ Name: LOCK_PARAM }));
    const lockedAt = parseInt(existing.Parameter.Value, 10);
    const age = Date.now() - lockedAt;

    if (age < LOCK_MAX_AGE_MS) {
      console.warn(`Lock exists and is ${Math.round(age / 1000)}s old — duplicate invocation detected, exiting`);
      return false;
    }

    console.warn(`Stale lock found (${Math.round(age / 1000)}s old) — previous run likely crashed, overwriting`);
  } catch (err) {
    if (err.name !== 'ParameterNotFound') throw err;
    // No lock exists — proceed to write
  }

  // Write lock with current timestamp as value
  await ssm.send(new PutParameterCommand({
    Name: LOCK_PARAM,
    Value: String(Date.now()),
    Type: 'String',
    Overwrite: true
  }));

  return true;
};

const releaseLock = async () => {
  try {
    await ssm.send(new DeleteParameterCommand({ Name: LOCK_PARAM }));
  } catch (err) {
    // Non-fatal — lock will be treated as stale after LOCK_MAX_AGE_MS
    console.warn('Failed to release SSM lock:', err.message);
  }
};

// ─── SQS ─────────────────────────────────────────────────────────────────────

// SendMessageBatch can partially fail — check Failed entries and retry up to MAX_ATTEMPTS
const enqueueBatch = async (messages, maxAttempts = 4) => {
  let toSend = messages;
  let attempts = 0;

  while (toSend.length > 0 && attempts < maxAttempts) {
    if (attempts > 0) {
      await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempts - 1)));
      console.warn(`Retrying ${toSend.length} failed SQS messages (attempt ${attempts + 1})`);
    }

    const failed = [];
    const batches = chunkArray(toSend, 10);

    for (const batch of batches) {
      const result = await sqs.send(new SendMessageBatchCommand({
        QueueUrl: DELAY_WORKER_QUEUE_URL,
        Entries: batch
      }));

      // Collect any failed entries by matching Id back to original message
      if (result.Failed?.length > 0) {
        const failedIds = new Set(result.Failed.map(f => f.Id));
        const retries = batch.filter(m => failedIds.has(m.Id));
        console.warn(`SQS batch had ${result.Failed.length} failures:`, result.Failed.map(f => `${f.Id}: ${f.Message}`));
        failed.push(...retries);
      }
    }

    toSend = failed;
    attempts++;
  }

  if (toSend.length > 0) {
    console.error(`Failed to enqueue ${toSend.length} SQS messages after ${maxAttempts} attempts — affected chunks will be missing from tonight's run`);
  }
};

// ─── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  console.log('delayOrchestrator invoked');

  const locked = await acquireLock();
  if (!locked) return;

  try {
    // Scan all SCHEDULE# records — presence of a SCHEDULE# record means the route is active.
    // routeDelete removes the SCHEDULE# record; TTL auto-expires stale ones.
    // userActive on ROUTE# is a user-facing display toggle and does not suppress forecasting.
    let allSchedules = [];
    let lastEvaluatedKey = undefined;

    do {
      const result = await dynamo.send(new ScanCommand({
        TableName: USER_ROUTE_TABLE,
        FilterExpression: 'begins_with(recordType, :prefix)',
        ExpressionAttributeValues: marshall({
          ':prefix': 'SCHEDULE#'
        }),
        ExclusiveStartKey: lastEvaluatedKey
      }));

      const page = (result.Items || []).map(i => unmarshall(i));
      allSchedules = allSchedules.concat(page);
      lastEvaluatedKey = result.LastEvaluatedKey;

    } while (lastEvaluatedKey);

    console.log(`Total active schedules found: ${allSchedules.length}`);

    if (allSchedules.length === 0) {
      console.log('No active schedules — nothing to enqueue');
      return;
    }

    // timezone is required by delayWorker to convert arriveBy from local time to UTC per forecast date
    const routeRefs = allSchedules.map(s => ({
      userId: s.userId,
      routeId: s.routeId,
      arriveBy: s.arriveBy,
      timezone: s.timezone,
      daysOfWeek: s.daysOfWeek
    }));

    const chunks = chunkArray(routeRefs, CHUNK_SIZE);
    console.log(`Enqueueing ${chunks.length} chunks of up to ${CHUNK_SIZE} routes each`);

    const sqsMessages = chunks.map((chunk, index) => ({
      Id: `chunk-${index}`,
      MessageBody: JSON.stringify({ routes: chunk }),
      MessageAttributes: {
        ChunkIndex: { DataType: 'Number', StringValue: String(index) },
        ChunkSize: { DataType: 'Number', StringValue: String(chunk.length) }
      }
    }));

    await enqueueBatch(sqsMessages);

    console.log(`delayOrchestrator complete — ${chunks.length} chunks enqueued covering ${allSchedules.length} routes`);

  } catch (err) {
    console.error('delayOrchestrator error:', err);
    throw err;
  } finally {
    await releaseLock();
  }
};
