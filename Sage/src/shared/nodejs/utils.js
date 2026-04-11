// shared/nodejs/utils.js
// Shared S3 and SSM helpers for the Sage pipeline Lambdas.
// Mirrors the structure and conventions of Backend/src/shared/nodejs/utils.js
// and Dagon/src/shared/nodejs/utils.js.

const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { SSMClient, PutParameterCommand } = require('@aws-sdk/client-ssm');

const s3  = new S3Client({});
const ssm = new SSMClient({});

// ─── S3 helpers ───────────────────────────────────────────────────────────────

// Download an S3 object and return its raw bytes as a Buffer.
async function s3GetBuffer(bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Download an S3 object and parse it as JSON.
async function s3GetJson(bucket, key) {
  return JSON.parse((await s3GetBuffer(bucket, key)).toString('utf-8'));
}

// Upload a body to S3 with the given content type.
async function s3Put(bucket, key, body, contentType = 'application/octet-stream') {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

// Append a record to a newline-delimited JSON (JSONL) file in S3.
// Reads the existing file if present, appends one serialised line, and writes it back.
// Used for history logs where each pipeline run appends one entry.
async function s3AppendJsonl(bucket, key, record) {
  let existing = '';
  try {
    existing = (await s3GetBuffer(bucket, key)).toString('utf-8');
  } catch (err) {
    if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) throw err;
    // File does not exist yet -- start empty
  }
  const updated = (existing.trimEnd() ? existing.trimEnd() + '\n' : '') + JSON.stringify(record) + '\n';
  await s3Put(bucket, key, updated, 'application/x-ndjson');
}

// Return true if an S3 object exists, false if it does not.
async function s3Exists(bucket, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

// List all object keys under a prefix, handling pagination automatically.
async function s3ListKeys(bucket, prefix) {
  const keys = [];
  let continuationToken;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket:            bucket,
      Prefix:            prefix,
      ContinuationToken: continuationToken,
    }));
    for (const obj of (res.Contents || [])) keys.push(obj.Key);
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

// Parse an s3://bucket/key URI into { bucket, key }.
function parseS3Uri(uri) {
  const withoutProto = uri.replace('s3://', '');
  const slashIdx = withoutProto.indexOf('/');
  return {
    bucket: withoutProto.substring(0, slashIdx),
    key:    withoutProto.substring(slashIdx + 1),
  };
}

// ─── SSM helpers ──────────────────────────────────────────────────────────────

// Write a String parameter to SSM, overwriting any existing value.
// description is optional — omit on routine metric updates.
async function ssmPut(name, value, description) {
  const params = { Name: name, Type: 'String', Value: value, Overwrite: true };
  if (description) params.Description = description;
  await ssm.send(new PutParameterCommand(params));
}

module.exports = { s3GetBuffer, s3GetJson, s3Put, s3AppendJsonl, s3Exists, s3ListKeys, parseS3Uri, ssmPut };
