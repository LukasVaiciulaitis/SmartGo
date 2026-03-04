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

// ─── HTTP ──────────────────────────────────────────────────────────────────────

const https = require('https');

// Fetch a URL and return the parsed JSON response body.
// Rejects with err.statusCode set for HTTP errors.
// err.retryable is set to false for non-transient 4xx errors (except 429 rate limit) —
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

// ─── API Response ─────────────────────────────────────────────────────────────

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

// ─── Route Constants ──────────────────────────────────────────────────────────

const MAX_ROUTES_PER_USER = 20;
const VALID_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const VALID_TRAVEL_MODES = ['DRIVE', 'TRANSIT', 'WALK', 'TWO_WHEELER', 'BICYCLE'];
// Maps JS Date.getDay() (0=Sun) to day abbreviation — used by scrapers for DynamoDB dayOfWeek field
const DAY_MAP = { 0: 'SUN', 1: 'MON', 2: 'TUE', 3: 'WED', 4: 'THU', 5: 'FRI', 6: 'SAT' };

// ─── Validation ───────────────────────────────────────────────────────────────

// Basic IANA timezone format check — e.g. "Europe/Dublin", "America/New_York", "UTC"
// Full validation happens implicitly in delayWorker when the timezone is used for conversion
const isValidIANATimezone = (tz) => {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  return /^[A-Za-z]+([/_+-][A-Za-z0-9_+-]+)*$/.test(tz);
};

// Computes the UTC ISO timestamp for the next matching weekday at the given local HH:MM time.
// Used to pass arrivalTime (TRANSIT) or departureTime (other modes) to Google Routes API
// so the returned route and duration reflect real-world conditions at the user's intended time.
// Always picks the next future occurrence (never today) to avoid wall-clock race conditions.
const computeArrivalUTC = (arriveBy, timezone, daysOfWeek) => {
  const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const now = new Date();

  // Get today's abbreviated day name in the target timezone (e.g. "Mon" -> "MON")
  const todayName = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' })
    .format(now).toUpperCase().slice(0, 3);
  const todayIdx = DAY_NAMES.indexOf(todayName);

  // Find the soonest matching weekday (minimum daysAhead, always >= 1)
  let minDaysAhead = 8;
  for (const day of daysOfWeek) {
    const dayIdx = DAY_NAMES.indexOf(day);
    let daysAhead = dayIdx - todayIdx;
    if (daysAhead <= 0) daysAhead += 7; // always future; today maps to +7
    if (daysAhead < minDaysAhead) minDaysAhead = daysAhead;
  }

  // Build target date string from UTC (close enough for weekday selection purposes)
  const targetDate = new Date(now);
  targetDate.setDate(now.getDate() + minDaysAhead);
  const dateStr = targetDate.toISOString().split('T')[0]; // "YYYY-MM-DD"

  // Convert local HH:MM on dateStr to a UTC ISO string using the Intl timezone offset.
  // Same offset-extraction approach as localTimeToUtcHHMM in delayWorker.js.
  const [localHour, localMin] = arriveBy.split(':').map(Number);
  const probeUTC = new Date(`${dateStr}T${String(localHour).padStart(2, '0')}:${String(localMin).padStart(2, '0')}:00Z`);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZoneName: 'shortOffset'
  }).formatToParts(probeUTC);
  const offsetPart = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT+0';
  const offsetMatch = offsetPart.match(/GMT([+-])(\d+)(?::(\d+))?/);
  let offsetMins = 0;
  if (offsetMatch) {
    const sign = offsetMatch[1] === '+' ? 1 : -1;
    offsetMins = sign * (parseInt(offsetMatch[2], 10) * 60 + parseInt(offsetMatch[3] || '0', 10));
  }
  const utcTotalMins = (((localHour * 60 + localMin) - offsetMins) % 1440 + 1440) % 1440;
  const utcH = Math.floor(utcTotalMins / 60);
  const utcM = utcTotalMins % 60;
  return `${dateStr}T${String(utcH).padStart(2, '0')}:${String(utcM).padStart(2, '0')}:00Z`;
};

// Validate a waypoint in Phase 2 format: { placeId, label }.
// latLng is no longer sent by the client — it is resolved server-side from the Routes API.
// Returns an error string on failure, null on success.
const validateWaypoint = (waypoint, name) => {
  if (!waypoint || typeof waypoint !== 'object')
    return `${name} is required`;
  if (!waypoint.placeId || typeof waypoint.placeId !== 'string' || !waypoint.placeId.trim())
    return `${name} must include a placeId`;
  if (!waypoint.label || typeof waypoint.label !== 'string' || waypoint.label.trim() === '')
    return `${name} must include a label`;
  return null;
};

// Validate that a waypoint carries a valid addressComponents array and that city/countryCode
// can be successfully extracted from it. Replaces the old city/countryCode string validation.
// Returns an error string on failure, null on success.
const validateAddressComponents = (waypoint, name) => {
  if (!Array.isArray(waypoint.addressComponents) || waypoint.addressComponents.length === 0)
    return `${name}.addressComponents must be a non-empty array`;
  for (const c of waypoint.addressComponents) {
    if (!Array.isArray(c.types) || c.types.length === 0)
      return `${name}.addressComponents entries must each include a non-empty types array`;
  }
  const extracted = extractCityFromComponents(waypoint.addressComponents);
  if (!extracted || !extracted.city || !extracted.countryCode)
    return `${name}.addressComponents must contain a recognisable city (locality/postal_town/admin_area) and a country component`;
  return null;
};

// ─── City helpers ─────────────────────────────────────────────────────────────

// Extract { city, countryCode, subdivisionCode } from a Google Places addressComponents array.
// Accepts both Android Places SDK serialisation (shortName/name) and Places API REST (shortText/longText).
// Precedence: locality → postal_town (strips trailing district number e.g. "Dublin 7" → "Dublin")
//             → administrative_area_level_1 (strips leading "County " e.g. "County Kildare" → "Kildare")
// subdivisionCode: ISO 3166-2 code built from countryCode + admin1 short code (e.g. "IE-L", "US-CA").
//   Only the shortText/shortName form of admin1 is used — longText is a human-readable name, not a code.
//   null when admin1 is absent or has no short code.
// Returns { city, countryCode, subdivisionCode } or null if no city can be determined.
const extractCityFromComponents = (components) => {
  const getShort = (c) => c.shortText ?? c.shortName ?? c.longText ?? c.name ?? null;
  const get = (type) => components.find(c => c.types.includes(type));

  const country = get('country');
  const countryCode = country ? getShort(country) : null;

  const admin1 = get('administrative_area_level_1');
  // Use only the short code form for the ISO 3166-2 subdivision identifier (not longText/name)
  const admin1Short = admin1 ? (admin1.shortText ?? admin1.shortName ?? null) : null;
  const subdivisionCode = (countryCode && admin1Short)
    ? `${countryCode.toUpperCase()}-${admin1Short.toUpperCase()}`
    : null;

  const locality = get('locality');
  if (locality) return { city: getShort(locality), countryCode, subdivisionCode };

  const postalTown = get('postal_town');
  if (postalTown) return { city: getShort(postalTown).replace(/\s+\d+$/, ''), countryCode, subdivisionCode };

  if (admin1) return { city: getShort(admin1).replace(/^County\s+/i, ''), countryCode, subdivisionCode };

  return null;
};

// Build a normalised city object for storage.
// city/countryCode are upper-cased; spaces replaced with underscores for cityKey construction.
// lat/lng are the resolved coordinates from the Routes API for this waypoint.
// subdivisionCode is the ISO 3166-2 code from extractCityFromComponents (e.g. "IE-L"), or null.
const buildCityObject = (city, countryCode, lat, lng, subdivisionCode = null) => {
  const normCity = city.trim().toUpperCase().replace(/\s+/g, '_');
  const normCC = countryCode.trim().toUpperCase();
  return { city: normCity, countryCode: normCC, cityKey: `${normCC}#${normCity}`, lat, lng, subdivisionCode };
};

// ─── Geometry ─────────────────────────────────────────────────────────────────

// Haversine distance between two lat/lng coordinates in km
const getDistanceKm = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// Decode a Google encoded polyline string into an array of { lat, lng } points.
// Uses Google's polyline encoding algorithm (1e-5 precision).
const decodePolyline = (encoded) => {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : result >> 1;
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
};

// ─── UUID ─────────────────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Routes API ───────────────────────────────────────────────────────────────

const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const ROUTES_API_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const TRAFFIC_MODES = new Set(['DRIVE', 'TWO_WHEELER']);
const FIELD_MASK_BASE = [
  'routes.staticDuration',
  'routes.duration',
  'routes.distanceMeters',
  'routes.polyline.encodedPolyline',
  'routes.legs.startLocation',
  'routes.legs.endLocation'
].join(',');
// TRANSIT routes additionally request step-level fields for transit line matching.
// Non-TRANSIT modes don't have transitDetails and the route-level polyline suffices.
const FIELD_MASK_TRANSIT = [
  FIELD_MASK_BASE,
  'routes.legs.steps.startLocation',
  'routes.legs.steps.endLocation',
  'routes.legs.steps.polyline.encodedPolyline',
  'routes.legs.steps.travelMode',
  'routes.legs.steps.transitDetails.stopDetails.arrivalStop',
  'routes.legs.steps.transitDetails.stopDetails.departureStop',
  'routes.legs.steps.transitDetails.transitLine.name',
  'routes.legs.steps.transitDetails.transitLine.nameShort',
  'routes.legs.steps.transitDetails.transitLine.vehicle.type',
  'routes.legs.steps.transitDetails.transitLine.agencies'
].join(',');

const ssmClient = new SSMClient({});
let googleRoutesApiKey = null;
let cachedTransitlandApiKey = null;

// Fetches the Google Routes API key from SSM on first call; cached for the lifetime of the container.
const getRoutesApiKey = async () => {
  if (!googleRoutesApiKey) {
    const result = await ssmClient.send(new GetParameterCommand({
      Name: '/routeApp/googleRoutesApiKey',
      WithDecryption: false
    }));
    googleRoutesApiKey = result.Parameter.Value;
  }
  return googleRoutesApiKey;
};

// Fetches the Transitland API key from SSM on first call; cached for the lifetime of the container.
const getTransitlandApiKey = async () => {
  if (!cachedTransitlandApiKey) {
    const result = await ssmClient.send(new GetParameterCommand({
      Name: '/routeApp/transitlandApiKey',
      WithDecryption: false
    }));
    cachedTransitlandApiKey = result.Parameter.Value;
  }
  return cachedTransitlandApiKey;
};

// Searches Transitland for GTFS-RT alert feed IDs matching the given search terms.
// searchTerms: array of agency names (from Google Routes API steps) or a city name (fallback).
// For each term, queries the Transitland operators endpoint, collects GTFS-RT feed candidates
// (identified by '~rt' in their onestop_id), then probes each for alerts availability.
// Returns a deduplicated array of feed onestop_ids that serve ServiceAlerts.
const discoverTransitlandFeedIds = async (searchTerms, apiKey) => {
  const candidateFeedIds = new Set();

  await Promise.all(searchTerms.map(async (term) => {
    try {
      const res = await fetch(
        `https://transit.land/api/v2/rest/operators?search=${encodeURIComponent(term)}&per_page=5&apikey=${apiKey}`
      );
      if (!res.ok) return;
      const data = await res.json();
      for (const operator of (data.operators || [])) {
        for (const feed of (operator.feeds || [])) {
          // Transitland GTFS-RT onestop_ids contain '~rt'; static GTFS feeds use '-' separators.
          const id = typeof feed === 'string' ? feed : (feed.onestop_id || feed.id);
          if (id && id.includes('~rt')) candidateFeedIds.add(id);
        }
      }
    } catch (err) {
      console.warn(`Transitland operator lookup failed for "${term}":`, err.message);
    }
  }));

  if (candidateFeedIds.size === 0) return [];

  // Probe each candidate: 200 means the feed publishes ServiceAlerts; 404 means it does not.
  const probeResults = await Promise.all([...candidateFeedIds].map(async (feedId) => {
    try {
      const res = await fetch(
        `https://transit.land/api/v2/rest/feeds/${feedId}/download_latest_rt/alerts.json?apikey=${apiKey}`
      );
      return res.ok ? feedId : null;
    } catch { return null; }
  }));

  return probeResults.filter(Boolean);
};

// Calls Google Routes API computeRoutes with placeId-based waypoints.
// originPlaceId / destinationPlaceId: plain place ID strings.
// intermediates: array of objects with .placeId (client waypoints or stored normalised waypoints).
// Returns routes[0] from the response.
// Throws with err.retryable = false for non-transient errors (4xx except 429).
const callRoutesApi = async (originPlaceId, destinationPlaceId, intermediates, travelMode, apiKey, targetTimeUTC = null) => {
  const body = {
    origin: { placeId: originPlaceId },
    destination: { placeId: destinationPlaceId },
    travelMode,
    ...(intermediates.length > 0
      ? { intermediates: intermediates.map(w => ({ placeId: w.placeId })) }
      : {}),
    // Pass arrival/departure time so Google returns the correct service at the user's intended time.
    // TRANSIT uses arrivalTime (finds latest departure meeting the constraint).
    // All other modes use departureTime (traffic-aware duration at the right time of day).
    ...(targetTimeUTC
      ? travelMode === 'TRANSIT' ? { arrivalTime: targetTimeUTC } : { departureTime: targetTimeUTC }
      : {}),
    ...(TRAFFIC_MODES.has(travelMode) ? { routingPreference: 'TRAFFIC_AWARE' } : {})
  };

  const res = await fetch(ROUTES_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': travelMode === 'TRANSIT' ? FIELD_MASK_TRANSIT : FIELD_MASK_BASE
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = new Error(`Routes API HTTP ${res.status}`);
    err.status = res.status;
    // 4xx (except 429) are not transient — retrying the same request will not help
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }

  const data = await res.json();
  const route = data.routes?.[0];
  if (!route) {
    const err = new Error('Routes API returned no routes for the given waypoints');
    err.retryable = false;
    throw err;
  }

  return route;
};

// ─── Waypoint ─────────────────────────────────────────────────────────────────

// Normalise a waypoint for storage.
// w is the client-sent waypoint { placeId, label }.
// resolvedLatLng is { latitude, longitude } from the Routes API response.
// Stored shape is unchanged from Phase 1 — delayWorker reads location.latLng from ROUTE# records.
const normaliseWaypoint = (w, resolvedLatLng) => ({
  location: {
    latLng: {
      latitude: resolvedLatLng.latitude,
      longitude: resolvedLatLng.longitude
    }
  },
  label: w.label,
  placeId: w.placeId
});

module.exports = { chunkArray, parseDurationToMinutes, batchGet, batchWrite, callWithRetry, fetchHttpJson, response, MAX_ROUTES_PER_USER, VALID_DAYS, VALID_TRAVEL_MODES, DAY_MAP, isValidIANATimezone, computeArrivalUTC, validateWaypoint, validateAddressComponents, extractCityFromComponents, buildCityObject, normaliseWaypoint, getDistanceKm, decodePolyline, UUID_REGEX, getRoutesApiKey, callRoutesApi, getTransitlandApiKey, discoverTransitlandFeedIds };
