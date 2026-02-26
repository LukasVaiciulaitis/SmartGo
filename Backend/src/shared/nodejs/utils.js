// shared/utils.js
// Local utility module — required directly by each Lambda.
// Bundled into each deployment package at sam build time.
// No network calls, no latency. Changes here affect all Lambdas on next deploy.

// ─── Array ────────────────────────────────────────────────────────────────────

// Split an array into chunks of a given size
const chunkArray = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
};

// ─── Duration ─────────────────────────────────────────────────────────────────

// Parse Google Maps Routes API duration string ("165s") to whole minutes.
// Rounds up to avoid underestimating journey time.
// Accepts a plain number as a passthrough for safety.
const parseDurationToMinutes = (duration) => {
  if (typeof duration === 'number') return duration;
  const match = String(duration).match(/^(\d+)s$/);
  if (!match) return null;
  return Math.ceil(parseInt(match[1], 10) / 60);
};

// ─── DynamoDB Batch Helpers ───────────────────────────────────────────────────

const { BatchGetItemCommand, BatchWriteItemCommand } = require('@aws-sdk/client-dynamodb');

// BatchGetItem with exponential backoff retry on unprocessed keys.
// Returns a map of results keyed by the provided keyFn.
// keyFn: (unmarshalled item) => string key for the result map
const batchGet = async (client, tableName, keys, keyFn, unmarshall, maxAttempts = 4) => {
  const results = {};
  let keysToFetch = keys;
  let attempts = 0;

  while (keysToFetch.length > 0 && attempts < maxAttempts) {
    if (attempts > 0) {
      await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempts - 1)));
      console.warn(`Retrying ${keysToFetch.length} unprocessed keys for ${tableName} (attempt ${attempts + 1})`);
    }

    const unprocessed = [];
    const batches = chunkArray(keysToFetch, 100);

    await Promise.all(
      batches.map(async (batch) => {
        const result = await client.send(new BatchGetItemCommand({
          RequestItems: { [tableName]: { Keys: batch } }
        }));

        const items = (result.Responses?.[tableName] || []).map(i => unmarshall(i));
        for (const item of items) {
          results[keyFn(item)] = item;
        }

        const unprocKeys = result.UnprocessedKeys?.[tableName]?.Keys || [];
        if (unprocKeys.length > 0) unprocessed.push(...unprocKeys);
      })
    );

    keysToFetch = unprocessed;
    attempts++;
  }

  if (keysToFetch.length > 0) {
    console.error(`Failed to fetch ${keysToFetch.length} keys from ${tableName} after ${maxAttempts} attempts`);
  }

  return results;
};

// BatchWriteItem with exponential backoff retry on unprocessed items.
const batchWrite = async (client, tableName, requests, maxAttempts = 4) => {
  let requestsToWrite = requests;
  let attempts = 0;

  while (requestsToWrite.length > 0 && attempts < maxAttempts) {
    if (attempts > 0) {
      await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempts - 1)));
      console.warn(`Retrying ${requestsToWrite.length} unprocessed writes to ${tableName} (attempt ${attempts + 1})`);
    }

    const unprocessed = [];
    const batches = chunkArray(requestsToWrite, 25);

    await Promise.all(
      batches.map(async (batch) => {
        const result = await client.send(new BatchWriteItemCommand({
          RequestItems: { [tableName]: batch }
        }));

        const unprocItems = result.UnprocessedItems?.[tableName] || [];
        if (unprocItems.length > 0) unprocessed.push(...unprocItems);
      })
    );

    requestsToWrite = unprocessed;
    attempts++;
  }

  if (requestsToWrite.length > 0) {
    console.error(`Failed to write ${requestsToWrite.length} items to ${tableName} after ${maxAttempts} attempts`);
  }
};

module.exports = { chunkArray, parseDurationToMinutes, batchGet, batchWrite };
