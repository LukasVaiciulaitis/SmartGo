// transitInitializer — two DynamoDB stream triggers, branching on record type:
//
// 1. locationDB INSERT (existing path)
//    Triggered when routeCreate writes a new city to locationDB.
//    Searches Transitland operators by city name, probes each candidate feed for
//    ServiceAlerts availability, writes transitlandFeedIds + gtfsRtAvailable back to locationDB.
//    Cities without a GTFS-RT alerts feed receive transitlandFeedIds: [] and
//    gtfsRtAvailable: false; transitScraper skips them.
//
// 2. userRouteDB INSERT where travelMode = TRANSIT (new path)
//    Triggered when routeCreate writes a new TRANSIT route to userRouteDB.
//    For each TRANSIT step on the route, resolves the departure stop via a Transitland
//    coordinate search, fetches the full weekly departure schedule for that line, and
//    writes a TIMETABLE# record to delaysDB keyed by cityKey + line + coordinates.
//    Idempotent: skips any line+stop combination already present in delaysDB.
//    delayWorker reads TIMETABLE# records to snap adjustedDepartBy to real scheduled
//    departures rather than arithmetic midpoints between services.

const { DynamoDBClient, UpdateItemCommand, GetItemCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { getTransitlandApiKey, discoverTransitlandFeedIds, fetchTimetableForStop } = require('/opt/nodejs/utils');

const dynamoClient = new DynamoDBClient({});
const LOCATION_TABLE = process.env.LOCATION_DB_TABLE;
const DELAYS_TABLE   = process.env.DELAYS_TABLE;

// TTL for TIMETABLE# records: 30 days. GTFS static feeds rotate roughly monthly,
// so this ensures stale schedules are eventually replaced without constant re-fetching.
const TIMETABLE_TTL_SECS = 30 * 24 * 60 * 60;

// ─── Path 1: city feed ID discovery (locationDB stream) ──────────────────────
const handleCityInsert = async (city, apiKey) => {
  console.log(`${city.cityKey}: searching Transitland for GTFS-RT alert feeds`);

  const feedIds = await discoverTransitlandFeedIds([city.city], apiKey);
  const gtfsRtAvailable = feedIds.length > 0;
  console.log(`${city.cityKey}: discovery result: [${feedIds.join(', ') || 'none found'}] — gtfsRtAvailable=${gtfsRtAvailable}`);

  await dynamoClient.send(new UpdateItemCommand({
    TableName: LOCATION_TABLE,
    Key: marshall({ cityKey: city.cityKey }),
    UpdateExpression: 'SET transitlandFeedIds = :ids, gtfsRtAvailable = :avail',
    ExpressionAttributeValues: marshall({ ':ids': feedIds, ':avail': gtfsRtAvailable })
  }));

  console.log(`${city.cityKey}: wrote transitlandFeedIds and gtfsRtAvailable to locationDB`);
};

// ─── Path 2: TRANSIT route timetable population (userRouteDB stream) ─────────
const handleTransitRouteInsert = async (route, apiKey) => {
  console.log(`transitInitializer: timetable population for routeId=${route.routeId} cityKey=${route.cityKey}`);

  // Filter to steps that are TRANSIT legs with a named line and a departure location.
  // WALK steps within the route (travelMode !== 'TRANSIT' at step level) are skipped —
  // they have no timetable and their duration is weather-variable (Phase 2 concern).
  const transitSteps = (route.steps || []).filter(
    s => s.travelMode === 'TRANSIT'
      && s.transitDetails?.transitLine?.nameShort
      && s.startLocation?.latLng
  );

  if (transitSteps.length === 0) {
    console.log(`routeId=${route.routeId}: no TRANSIT steps with nameShort — skipping`);
    return;
  }

  // Deduplicate by timetableKey — a multi-leg route may use the same line+stop twice,
  // and multiple users' routes will converge on the same popular stops over time.
  const seen = new Set();
  const uniqueSteps = [];
  for (const step of transitSteps) {
    const { latitude: lat, longitude: lng } = step.startLocation.latLng;
    const lineShortName = step.transitDetails.transitLine.nameShort;
    // Key is derived purely from Google step data — both transitInitializer (write) and
    // delayWorker (read) derive this key identically, so no write-back is required.
    const timetableKey = `TIMETABLE#${lineShortName}#${lat.toFixed(4)}#${lng.toFixed(4)}`;
    if (!seen.has(timetableKey)) {
      seen.add(timetableKey);
      uniqueSteps.push({ lat, lng, lineShortName, timetableKey });
    }
  }

  const ttl = Math.floor(Date.now() / 1000) + TIMETABLE_TTL_SECS;

  for (const { lat, lng, lineShortName, timetableKey } of uniqueSteps) {
    // Idempotency: if a TIMETABLE# record already exists (written by a prior user on the
    // same line), skip the Transitland API call entirely — the shared record covers all users.
    const existing = await dynamoClient.send(new GetItemCommand({
      TableName: DELAYS_TABLE,
      Key: marshall({ cityKey: route.cityKey, typeDate: timetableKey }),
      ProjectionExpression: 'cityKey'
    }));

    if (existing.Item) {
      console.log(`${timetableKey}: record already exists — skipping fetch`);
      continue;
    }

    console.log(`${timetableKey}: fetching timetable from Transitland (${lineShortName} at ${lat.toFixed(4)},${lng.toFixed(4)})`);
    const result = await fetchTimetableForStop(lat, lng, lineShortName, apiKey);

    if (!result) {
      console.warn(`${timetableKey}: timetable fetch returned null — skipping`);
      continue;
    }

    const totalSlots = Object.values(result.schedule).reduce((n, arr) => n + arr.length, 0);
    console.log(`${timetableKey}: fetched ${totalSlots} departure slots across 7 days`);

    await dynamoClient.send(new PutItemCommand({
      TableName: DELAYS_TABLE,
      Item: marshall({
        cityKey:       route.cityKey,
        typeDate:      timetableKey,
        lineShortName,
        schedule:      result.schedule,
        ttl
      })
    }));

    console.log(`${timetableKey}: written to delaysDB (TTL ${TIMETABLE_TTL_SECS / 86400} days)`);
  }
};

// ─── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  console.log(`transitInitializer invoked — ${event.Records.length} stream record(s)`);

  // Fetch API key once — shared across all records in this invocation.
  const apiKey = await getTransitlandApiKey();

  for (const record of event.Records) {
    if (record.eventName !== 'INSERT') continue;

    const item = unmarshall(record.dynamodb.NewImage);

    try {
      if (item.recordType?.startsWith('ROUTE#')) {
        // userRouteDB stream — TRANSIT route: populate timetable records in delaysDB.
        // Stream filter guarantees travelMode === 'TRANSIT' at this point.
        await handleTransitRouteInsert(item, apiKey);
      } else {
        // locationDB stream — new city: discover and store Transitland feed IDs.
        await handleCityInsert(item, apiKey);
      }
    } catch (err) {
      console.error(`transitInitializer failed for record (eventName=${record.eventName}):`, err);
      throw err; // Re-throw to trigger Lambda retry
    }
  }
};
