// dagonWorker.js
// SQS-triggered, one invocation per commuter runner (BatchSize: 1).
// Reads the runner config from the SQS message body, calls the Google Routes API
// with a traffic-aware prediction for today at the runner's stored UTC departure time,
// enriches with Open-Meteo current weather for the origin coordinates, then writes a single
// CSV row directly to S3 under raw/date=YYYY-MM-DD/{runnerId}.csv.
//
// CSV schema (no header row -- header is written by dagonConsolidator):
//   runnerId, userId, persona, legType, pollDate, dayOfWeek, departureTimeUTC,
//   originLat, originLng, destLat, destLng,
//   distanceMeters, predictedDurationSeconds, staticDurationSeconds,
//   weatherCondition, weatherTempC, weatherPrecipMm, weatherWindKph

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { callWithRetry, fetchHttpJson, parseDurationSeconds, getRoutesApiKey, WMO_CONDITION } = require('/opt/nodejs/utils');

const s3 = new S3Client({});

const DATA_BUCKET = process.env.DATA_BUCKET;
const ROUTES_API_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

// ─── API Calls ────────────────────────────────────────────────────────────────

// Call Google Routes API with traffic-aware routing.
// departureTime is intentionally omitted -- Google uses live traffic conditions when
// the field is absent. Passing new Date().toISOString() causes a 400 INVALID_ARGUMENT
// because the timestamp is already in the past by the time Google's server receives it.
const fetchRoute = async (runner, googleKey) => {
  const body = {
    origin: {
      location: { latLng: { latitude: runner.originLat, longitude: runner.originLng } }
    },
    destination: {
      location: { latLng: { latitude: runner.destLat, longitude: runner.destLng } }
    },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE_OPTIMAL'
  };

  const res = await fetch(ROUTES_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': googleKey,
      // duration: traffic-aware predicted time
      // staticDuration: baseline with no traffic (free delta signal)
      // distanceMeters: route distance
      'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = new Error(`Routes API HTTP ${res.status}`);
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }

  const data = await res.json();
  const route = data.routes?.[0];
  if (!route) {
    const err = new Error(`Routes API returned no route for runner ${runner.runnerId}`);
    err.retryable = false;
    throw err;
  }

  return route;
};

// ─── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  try {
    const record = event.Records[0];
    const runner = JSON.parse(record.body);

    // Fetch Google Routes API key from SSM (cached for container lifetime).
    const googleKey = await getRoutesApiKey();

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${runner.originLat}&longitude=${runner.originLng}&current=temperature_2m,precipitation,wind_speed_10m,weather_code`;

    // Fire both API calls in parallel and retry each independently.
    const [route, weather] = await Promise.all([
      callWithRetry(() => fetchRoute(runner, googleKey), 3, 500),
      callWithRetry(() => fetchHttpJson(weatherUrl), 3, 500)
    ]);

    const now = new Date();
    const pollDate = now.toISOString().split('T')[0];
    const dayOfWeek = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][now.getUTCDay()];

    const predictedSeconds = parseDurationSeconds(route.duration);
    const staticSeconds = parseDurationSeconds(route.staticDuration);
    const current = weather.current ?? {};
    // Open-Meteo weather_code is a WMO code; map to a human-readable label.
    const weatherCondition = WMO_CONDITION[current.weather_code] ?? '';
    const tempC = current.temperature_2m ?? '';
    // Open-Meteo precipitation is mm; wind_speed_10m is already km/h.
    const precipMm = (current.precipitation ?? 0).toFixed(2);
    const windKph = (current.wind_speed_10m ?? 0).toFixed(2);

    const csvRow = [
      runner.runnerId,
      runner.userId,
      runner.persona,
      runner.legType,
      pollDate,
      dayOfWeek,
      runner.departureTimeUTC,
      runner.originLat,
      runner.originLng,
      runner.destLat,
      runner.destLng,
      route.distanceMeters ?? '',
      predictedSeconds,
      staticSeconds,
      weatherCondition,
      tempC,
      precipMm,
      windKph
    ].join(',') + '\n';

    await s3.send(new PutObjectCommand({
      Bucket: DATA_BUCKET,
      Key: `raw/date=${pollDate}/${runner.runnerId}.csv`,
      Body: csvRow,
      ContentType: 'text/csv'
    }));

    console.log(`runner=${runner.runnerId} date=${pollDate} predicted=${predictedSeconds}s static=${staticSeconds}s weather=${weatherCondition}`);

  } catch (err) {
    console.error('dagonWorker error:', err);
    throw err; // Re-throw -- no DLQ, message expires after visibility timeout retries
  }
};
