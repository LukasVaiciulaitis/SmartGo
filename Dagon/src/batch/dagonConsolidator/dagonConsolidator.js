// dagonConsolidator.js
// Triggered by EventBridge at 18:10 UTC, after the evening commute window closes (17:55)
// and all workers have had time to complete (30s timeout + margin).
//
// Lists all raw CSV fragments written by dagonWorker for today under raw/date=TODAY/,
// concatenates them into a single daily CSV, writes to consolidated/date=TODAY/commutes.csv,
// then deletes the raw fragments.
//
// One consolidated CSV per day -- all morning and evening commute rows combined.
// Schema (header written here, data rows written by dagonWorker):
//   runnerId, userId, persona, legType, pollDate, dayOfWeek, departureTimeUTC,
//   originLat, originLng, destLat, destLng,
//   distanceMeters, predictedDurationSeconds, staticDurationSeconds,
//   weatherCondition, weatherTempC, weatherPrecipMm, weatherWindKph

const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({});
const DATA_BUCKET = process.env.DATA_BUCKET;

// Stream a GetObject response body to a UTF-8 string.
const streamToString = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
};

exports.handler = async (event) => {
  const today = new Date().toISOString().split('T')[0];
  const rawPrefix = `raw/date=${today}/`;
  const consolidatedKey = `consolidated/date=${today}/commutes.csv`;

  console.log(`dagonConsolidator invoked -- consolidating date=${today}`);

  try {
    // List all raw fragments for today
    const objects = [];
    let continuationToken;

    do {
      const result = await s3.send(new ListObjectsV2Command({
        Bucket: DATA_BUCKET,
        Prefix: rawPrefix,
        ContinuationToken: continuationToken
      }));
      objects.push(...(result.Contents || []));
      continuationToken = result.NextContinuationToken;
    } while (continuationToken);

    if (objects.length === 0) {
      console.log(`No raw fragments found for date=${today} -- nothing to consolidate`);
      return;
    }

    console.log(`Found ${objects.length} raw fragments -- reading and concatenating`);

    // Fetch all fragments in parallel and concatenate
    const parts = await Promise.all(
      objects.map(async (obj) => {
        const result = await s3.send(new GetObjectCommand({ Bucket: DATA_BUCKET, Key: obj.Key }));
        return streamToString(result.Body);
      })
    );

    const header = 'runnerId,userId,persona,legType,pollDate,dayOfWeek,departureTimeUTC,originLat,originLng,destLat,destLng,distanceMeters,predictedDurationSeconds,staticDurationSeconds,weatherCondition,weatherTempC,weatherPrecipMm,weatherWindKph\n';
    const consolidated = header + parts.join('');

    // Write single consolidated CSV
    await s3.send(new PutObjectCommand({
      Bucket: DATA_BUCKET,
      Key: consolidatedKey,
      Body: consolidated,
      ContentType: 'text/csv'
    }));

    console.log(`Written: ${consolidatedKey}`);

    // Delete raw fragments -- DeleteObjects accepts up to 1000 keys per call
    const deleteKeys = objects.map(obj => ({ Key: obj.Key }));
    for (let i = 0; i < deleteKeys.length; i += 1000) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: DATA_BUCKET,
        Delete: { Objects: deleteKeys.slice(i, i + 1000), Quiet: true }
      }));
    }

    console.log(`dagonConsolidator complete -- ${objects.length} raw fragments deleted`);

  } catch (err) {
    console.error('dagonConsolidator error:', err);
    throw err;
  }
};
