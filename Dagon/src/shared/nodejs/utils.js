// dagon/shared/utils.js
// Shared utilities for the Dagon data pipeline.
// Mirrors the structure and conventions of Backend/src/shared/nodejs/utils.js.

// ─── Array ────────────────────────────────────────────────────────────────────

// Split an array into chunks of a given size.
// Used by dagonOrchestrator to batch SQS SendMessageBatch calls (max 10 per call).
const chunkArray = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
};

// ─── Duration ─────────────────────────────────────────────────────────────────

// Parse Google Routes API duration string ("165s") to whole seconds.
// Stored as seconds (not minutes) for full precision in the CSV output.
// Returns empty string on parse failure so the CSV cell is blank rather than corrupt.
const parseDurationSeconds = (durationStr) => {
  const match = String(durationStr ?? '').match(/^(\d+)s$/);
  return match ? parseInt(match[1], 10) : '';
};

// ─── HTTP Retry ───────────────────────────────────────────────────────────────

// Retry an async fn up to maxAttempts times with exponential backoff.
// Set err.retryable = false on a thrown error to abort immediately without further attempts.
const callWithRetry = async (fn, maxAttempts = 3, baseDelayMs = 500) => {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
      console.warn(`callWithRetry: attempt ${attempt + 1}/${maxAttempts} after ${delay}ms delay`);
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (err.retryable === false) throw err;
    }
  }
  throw lastError;
};

// ─── HTTP ─────────────────────────────────────────────────────────────────────

const https = require('https');

// Fetch a URL and return the parsed JSON response body.
// Rejects with err.statusCode set for HTTP errors.
// err.retryable is set to false for non-transient 4xx errors (except 429 rate limit) --
// callWithRetry respects this flag so transient 5xx and 429s are retried automatically.
const fetchHttpJson = (url, timeoutMs = 10000) => {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (res.statusCode !== 200) {
          const err = new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`);
          err.statusCode = res.statusCode;
          err.retryable = res.statusCode === 429 || res.statusCode >= 500;
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          const parseErr = new Error(`Failed to parse JSON response from ${url}`);
          parseErr.retryable = false;
          reject(parseErr);
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
    });
  });
};

// ─── SSM API Keys ─────────────────────────────────────────────────────────────

const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const ssm = new SSMClient({});
let cachedRoutesApiKey = null;

// Fetches the Google Routes API key from SSM on first call; cached for the lifetime of the container.
const getRoutesApiKey = async () => {
  if (!cachedRoutesApiKey) {
    const result = await ssm.send(new GetParameterCommand({
      Name: '/dagon/googleRoutesApiKey',
      WithDecryption: false
    }));
    cachedRoutesApiKey = result.Parameter.Value;
  }
  return cachedRoutesApiKey;
};

// ─── WMO Weather Codes ────────────────────────────────────────────────────────

// Maps Open-Meteo WMO weather interpretation codes to human-readable condition labels.
// Used by dagonWorker to populate the weatherCondition CSV column.
// Reference: https://open-meteo.com/en/docs#weathervariables
const WMO_CONDITION = {
  0:  'Clear',
  1:  'Mostly Clear', 2: 'Partly Cloudy', 3: 'Overcast',
  45: 'Fog',          48: 'Icy Fog',
  51: 'Light Drizzle', 53: 'Drizzle',     55: 'Heavy Drizzle',
  56: 'Light Freezing Drizzle',           57: 'Freezing Drizzle',
  61: 'Light Rain',   63: 'Rain',         65: 'Heavy Rain',
  66: 'Light Freezing Rain',              67: 'Freezing Rain',
  71: 'Light Snow',   73: 'Snow',         75: 'Heavy Snow',
  77: 'Snow Grains',
  80: 'Light Showers', 81: 'Showers',    82: 'Heavy Showers',
  85: 'Light Snow Showers',              86: 'Snow Showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with Hail',          99: 'Thunderstorm with Heavy Hail',
};

module.exports = { chunkArray, parseDurationSeconds, callWithRetry, fetchHttpJson, getRoutesApiKey, WMO_CONDITION };
