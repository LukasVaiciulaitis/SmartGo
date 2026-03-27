// dagonOrchestrator.js
// Triggered by EventBridge every 5 minutes within the morning (06:00-09:55 UTC)
// and evening (15:00-18:55 UTC) windows. Windows cover both Dublin GMT (UTC+0) and
// IST (UTC+1) so DST transitions never drop boundary slots.
// Firings with no matching runners are a no-op.
//
// Each firing converts the current UTC time to Europe/Dublin local time via Intl,
// then queries runnerConfigDB via the departureTimeLocal GSI to retrieve only the
// runners assigned to this slot, then fans them out to SQS for dagonWorker.

const { DynamoDBClient, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { SQSClient, SendMessageBatchCommand } = require('@aws-sdk/client-sqs');
const { chunkArray } = require('/opt/nodejs/utils');

const dynamo = new DynamoDBClient({});
const sqs = new SQSClient({});

const RUNNER_CONFIG_TABLE = process.env.RUNNER_CONFIG_TABLE;
const DAGON_WORKER_QUEUE_URL = process.env.DAGON_WORKER_QUEUE_URL;

// ─── Slot Calculation ─────────────────────────────────────────────────────────

// Derive the current 5-minute departure slot in Dublin local time.
// Converts the EventBridge scheduled time (UTC) to Europe/Dublin via Intl so that
// DST transitions (UTC+0 in winter, UTC+1 in summer) are handled automatically.
// Falls back to Date.now() when event.time is absent -- this happens when EventBridge
// uses a custom Input override, which replaces the default event payload entirely.
const getSlotFromEvent = (eventTime) => {
  const scheduled = new Date(eventTime ?? Date.now());
  const parts = new Intl.DateTimeFormat('en-IE', {
    timeZone: 'Europe/Dublin',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(scheduled);
  const hh = parts.find(p => p.type === 'hour').value.padStart(2, '0');
  const rawMin = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const mm = String(Math.floor(rawMin / 5) * 5).padStart(2, '0');
  return `${hh}:${mm}`;
};

// ─── SQS ─────────────────────────────────────────────────────────────────────

// SendMessageBatch can partially fail -- check Failed entries and retry up to maxAttempts.
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
        QueueUrl: DAGON_WORKER_QUEUE_URL,
        Entries: batch
      }));

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
    console.error(`Failed to enqueue ${toSend.length} SQS messages after ${maxAttempts} attempts -- runners for this slot will be skipped`);
  }
};

// ─── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const { legType } = event;
  if (!legType) {
    console.error('No legType in event -- expected {"legType": "morningCommute"|"eveningReturn"}');
    return;
  }

  // Derive slot from the EventBridge scheduled time, not the Lambda invocation time.
  const currentSlot = getSlotFromEvent(event.time);
  console.log(`dagonOrchestrator invoked -- legType="${legType}" slot="${currentSlot}"`);

  try {
    // Query the departureTimeLocal GSI to retrieve only runners for this exact slot.
    // Avoids a full table scan every 5 minutes.
    let runners = [];
    let lastEvaluatedKey = undefined;

    do {
      const result = await dynamo.send(new QueryCommand({
        TableName: RUNNER_CONFIG_TABLE,
        IndexName: 'departureTimeLocal-index',
        KeyConditionExpression: 'departureTimeLocal = :slot',
        ExpressionAttributeValues: marshall({ ':slot': currentSlot }),
        ExclusiveStartKey: lastEvaluatedKey
      }));

      const page = (result.Items || []).map(i => unmarshall(i));
      runners = runners.concat(page);
      lastEvaluatedKey = result.LastEvaluatedKey;

    } while (lastEvaluatedKey);

    if (runners.length === 0) {
      console.log(`No runners for slot="${currentSlot}" -- slot may be sparsely populated`);
      return;
    }

    console.log(`Enqueueing ${runners.length} runners for slot="${currentSlot}"`);

    const sqsMessages = runners.map((runner, index) => ({
      Id: `runner-${index}`,
      MessageBody: JSON.stringify(runner),
      MessageAttributes: {
        RunnerId: { DataType: 'String', StringValue: runner.runnerId },
        LegType: { DataType: 'String', StringValue: runner.legType }
      }
    }));

    await enqueueBatch(sqsMessages);

    console.log(`dagonOrchestrator complete -- ${runners.length} runners enqueued for slot="${currentSlot}"`);

  } catch (err) {
    console.error('dagonOrchestrator error:', err);
    throw err;
  }
};
