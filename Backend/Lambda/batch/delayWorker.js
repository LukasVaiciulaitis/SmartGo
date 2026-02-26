// delayWorker — triggered by SQS, MaximumConcurrency controlled via event source mapping
// Receives a chunk of up to 1,000 {userId, routeId, arriveBy, timezone, daysOfWeek} from delayOrchestrator.
//
// Timezone handling:
//   arriveBy is stored as the user's LOCAL time intent e.g. "08:45" — not UTC
//   timezone is the IANA identifier e.g. "Europe/Dublin" stored on SCHEDULE#
//   For each forecast date, arriveBy is converted to UTC using the IANA timezone rules
//   for that specific date — this means DST is handled automatically.
//   A user who sets 08:45 always gets a forecast for 08:45 local time, winter or summer.
//   All time comparisons within getRecommendation() operate in UTC.
//
// Recommendation engine is isolated in getRecommendation().
// Phase 1: hardcoded rules (+10 rain, +30 events)
// Phase 2: swap getRecommendation() for a Haiku API call
// Phase 3: swap getRecommendation() for a SageMaker endpoint invocation
//
// adjustedDepartBy is stored as a full ISO 8601 UTC timestamp e.g. "2026-03-30T07:45:00Z".
// Storing the date eliminates two problems for Android:
//   1. DST ambiguity — Android converts using Instant.parse() + ZoneId, no date guessing needed
//   2. Midnight crossings — departure naturally falls on the previous calendar day when
//      arriveBy UTC - staticDuration - buffer goes negative (no clamping to 00:00)

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { batchGet, batchWrite } = require('/opt/nodejs/utils');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

const client = new DynamoDBClient({});
const USER_ROUTE_TABLE = process.env.USER_ROUTE_TABLE;
const DELAYS_TABLE = process.env.DELAYS_TABLE;

// ─── Utility ─────────────────────────────────────────────────────────────────


// Get the next calendar date for a given day name (e.g. "MON" → "2026-02-23")
// Date logic lives here only — never persisted to userRouteDB
const getNextDateForDay = (dayName, today) => {
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const targetDay = days.indexOf(dayName);
  const todayDay = today.getDay();
  let daysAhead = targetDay - todayDay;
  if (daysAhead <= 0) daysAhead += 7;
  const next = new Date(today);
  next.setDate(today.getDate() + daysAhead);
  return next.toISOString().split('T')[0];
};

// Convert a local HH:MM time on a specific date to a UTC HH:MM string.
// Uses the IANA timezone rules for that exact date — correctly handles DST transitions.
// e.g. "08:45" + "Europe/Dublin" + "2026-03-29" (day clocks go forward) → "07:45"
//      "08:45" + "Europe/Dublin" + "2026-10-25" (day clocks go back)    → "08:45"
// Falls back to the original local time if the timezone is unrecognised.
const localTimeToUtcHHMM = (localHHMM, ianaTimezone, dateStr) => {
  try {
    const [localHour, localMin] = localHHMM.split(':').map(Number);
    // Build a full ISO local datetime string and ask Intl.DateTimeFormat to resolve the UTC offset
    // for this timezone on this specific date — respects DST rules
    const localDateTimeStr = `${dateStr}T${String(localHour).padStart(2, '0')}:${String(localMin).padStart(2, '0')}:00`;
    // Use Intl to get the UTC offset in effect on this date in this timezone
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: ianaTimezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZoneName: 'shortOffset'
    });
    // Format a Date constructed from the local time string treated as UTC, then extract offset
    // Strategy: construct the local time as a Date, then use the offset to calculate UTC
    const tempDate = new Date(`${localDateTimeStr}Z`); // treat as UTC temporarily
    const parts = formatter.formatToParts(tempDate);
    const offsetPart = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT+0';
    // Parse offset string like "GMT+1", "GMT-5:30", "GMT+0"
    const offsetMatch = offsetPart.match(/GMT([+-])(\d+)(?::(\d+))?/);
    let offsetMins = 0;
    if (offsetMatch) {
      const sign = offsetMatch[1] === '+' ? 1 : -1;
      offsetMins = sign * (parseInt(offsetMatch[2], 10) * 60 + parseInt(offsetMatch[3] || '0', 10));
    }
    // UTC minutes = local minutes - offset
    let utcTotalMins = (localHour * 60 + localMin) - offsetMins;
    // Normalise to 0–1439 range (wrap across midnight)
    utcTotalMins = ((utcTotalMins % 1440) + 1440) % 1440;
    return `${String(Math.floor(utcTotalMins / 60)).padStart(2, '0')}:${String(utcTotalMins % 60).padStart(2, '0')}`;
  } catch (err) {
    console.warn(`localTimeToUtcHHMM failed for tz=${ianaTimezone} date=${dateStr} — using local time as fallback:`, err.message);
    return localHHMM; // safe fallback — worst case forecast is off by DST offset
  }
};

// Calculate distance between two coordinates in km (Haversine)
const getDistanceKm = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// Filter events within 2km of the route origin, destination, or corridor midpoint.
// Checking all three anchors catches events near the start of the journey, end of the
// journey, and the middle — a long cross-city route (e.g. Celbridge → Grangegorman)
// would otherwise miss events clustered at either end.
const filterCorridorEvents = (events, route) => {
  // Coordinates stored in Google's nested latLng structure
  const originLat = route.origin.location.latLng.latitude;
  const originLng = route.origin.location.latLng.longitude;
  const destLat   = route.destination.location.latLng.latitude;
  const destLng   = route.destination.location.latLng.longitude;
  const midLat    = (originLat + destLat) / 2;
  const midLng    = (originLng + destLng) / 2;
  return (events || []).filter(ev => {
    if (!ev.lat || !ev.lng) return false; // Can't place event geographically — exclude from corridor
    return (
      getDistanceKm(originLat, originLng, ev.lat, ev.lng) <= 2.0 ||
      getDistanceKm(destLat,   destLng,   ev.lat, ev.lng) <= 2.0 ||
      getDistanceKm(midLat,    midLng,    ev.lat, ev.lng) <= 2.0
    );
  });
};

// ─── Recommendation Engine ───────────────────────────────────────────────────
// Phase 1: hardcoded deterministic rules.
// This function is the only thing that changes when moving to Haiku or SageMaker.
// Input contract: { hourly, corridorEvents, arriveBy, staticDuration, forecastDate }
//   arriveBy     — UTC HH:MM string for the forecast date
//   forecastDate — ISO date string "YYYY-MM-DD", anchors adjustedDepartBy as a full UTC timestamp
// Output contract: { adjustedDepartBy, extraBufferMins, reasoning }
//   adjustedDepartBy — ISO 8601 UTC timestamp e.g. "2026-03-30T07:45:00Z"
//   Departure may fall on the day before forecastDate when the commute crosses midnight UTC

// Extract total precipitation during the user's commute window
// Window spans from departure hour through arrival hour inclusive
const getCommuteWindowPrecipitation = (hourly, arriveBy, staticDuration) => {
  if (!hourly || hourly.length === 0) return 0;
  const [arriveHour, arriveMin] = arriveBy.split(':').map(Number);
  const departHour = Math.floor(((arriveHour * 60 + arriveMin) - staticDuration) / 60);
  return hourly
    .filter(h => {
      const hour = parseInt(h.hour, 10);
      return hour >= departHour && hour <= arriveHour;
    })
    .reduce((sum, h) => sum + h.precipitationMm, 0);
};

// Filter events that start at or before the user's arriveBy time
// These are events plausibly generating crowd impact during the commute
const filterCommuteEvents = (events, arriveBy) => {
  if (!events || events.length === 0) return [];
  const [arriveHour, arriveMin] = arriveBy.split(':').map(Number);
  const arriveTotal = arriveHour * 60 + arriveMin;
  return events.filter(ev => {
    if (!ev.startTime) return false;
    const [evHour, evMin] = ev.startTime.split(':').map(Number);
    return (evHour * 60 + evMin) <= arriveTotal;
  });
};

const getRecommendation = ({ hourly, corridorEvents, arriveBy, staticDuration, forecastDate }) => {
  const reasons = [];
  let extraBufferMins = 0;

  // staticDuration is required — throw rather than silently produce a wrong departure time
  if (staticDuration === undefined || staticDuration === null) {
    throw new Error(`staticDuration missing on route record — cannot calculate departure time`);
  }

  // Rule 1: any precipitation during commute window → +10 minutes
  const totalPrecipMm = getCommuteWindowPrecipitation(hourly, arriveBy, staticDuration);
  if (totalPrecipMm > 0.5) {
    extraBufferMins += 10;
    reasons.push('Rain expected during your commute window — allow extra time');
  }

  // Rule 2: each corridor event starting before or during commute → +30 minutes per event
  for (const ev of (corridorEvents || [])) {
    extraBufferMins += 30;
    reasons.push(`Event near your route: ${ev.name}`);
  }

  const [arriveHour, arriveMin] = arriveBy.split(':').map(Number);
  const departMins = (arriveHour * 60 + arriveMin) - staticDuration - extraBufferMins;

  // Anchor departure to the forecast date in UTC. departMins may be negative when the commute
  // crosses midnight — e.g. arriveBy "00:30" UTC with staticDuration 45 gives departMins -15,
  // which correctly resolves to "23:45:00Z" on the previous calendar day. No clamping needed.
  const base = new Date(`${forecastDate}T00:00:00Z`);
  const adjustedDepartBy = new Date(base.getTime() + departMins * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  return {
    adjustedDepartBy,
    extraBufferMins,
    reasoning: reasons.length > 0 ? reasons.join('. ') : 'Normal conditions — no disruptions expected.'
  };
};

// ─── DynamoDB Fetch Helpers ───────────────────────────────────────────────────

// Fetch WEATHER# and EVENTS# for all unique cityKey + date combinations using BatchGetItem
// Returns { weatherCache: { cityKey: { date: hourlyArray } }, eventsCache: { cityKey: { date: [] } }, dayDateMap }
const fetchDelaysCache = async (cityKeys, daysOfWeekSet, today) => {
  const weatherCache = {};
  const eventsCache = {};

  // Resolve the next UTC date for each unique day of week once
  const dayDateMap = {};
  for (const day of daysOfWeekSet) {
    dayDateMap[day] = getNextDateForDay(day, today);
  }

  // Initialise caches with empty defaults so missing records don't cause undefined lookups
  for (const cityKey of cityKeys) {
    weatherCache[cityKey] = {};
    eventsCache[cityKey] = {};
    for (const day of daysOfWeekSet) {
      const dateStr = dayDateMap[day];
      weatherCache[cityKey][dateStr] = [];
      eventsCache[cityKey][dateStr] = [];
    }
  }

  // Build all keys — WEATHER# and EVENTS# for every cityKey × day combination
  // e.g. 10 cities × 5 days × 2 types = 100 keys — fits in one BatchGetItem call
  const keys = [];
  for (const cityKey of cityKeys) {
    for (const day of daysOfWeekSet) {
      const dateStr = dayDateMap[day];
      keys.push(marshall({ cityKey, typeDate: `WEATHER#${dateStr}` }));
      keys.push(marshall({ cityKey, typeDate: `EVENTS#${dateStr}` }));
    }
  }

  const results = await batchGet(client, DELAYS_TABLE, keys, item => `${item.cityKey}|${item.typeDate}`, unmarshall);

  for (const item of Object.values(results)) {
    const [type] = item.typeDate.split('#');
    if (type === 'WEATHER') {
      weatherCache[item.cityKey][item.date] = item.hourly || [];
    } else if (type === 'EVENTS') {
      eventsCache[item.cityKey][item.date] = item.events || [];
    }
  }

  return { weatherCache, eventsCache, dayDateMap };
};


// ─── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  console.log('delayWorker invoked');

  try {
    // SQS delivers records array — we process one message at a time (BatchSize: 1)
    const sqsRecord = event.Records[0];
    const { routes: routeRefs } = JSON.parse(sqsRecord.body);

    console.log(`Processing chunk of ${routeRefs.length} routes`);

    const today = new Date();

    // ── Step 1: Fetch all ROUTE# records ─────────────────────────────────────
    const routeKeys = routeRefs.map(ref => marshall({ userId: ref.userId, recordType: `ROUTE#${ref.routeId}` }));
    const routeMap = await batchGet(client, USER_ROUTE_TABLE, routeKeys, item => item.routeId, unmarshall);
    console.log(`Fetched ${Object.keys(routeMap).length} route records`);

    // ── Step 2: Determine unique cityKeys and daysOfWeek across this chunk ────
    const cityKeySet = new Set();
    const daysOfWeekSet = new Set();

    for (const ref of routeRefs) {
      const route = routeMap[ref.routeId];
      if (!route) continue;
      if (route.cityKey) cityKeySet.add(route.cityKey);
      for (const day of ref.daysOfWeek) daysOfWeekSet.add(day);
    }

    // ── Step 3: Fetch weather + events once per cityKey per day ───────────────
    const { weatherCache, eventsCache, dayDateMap } = await fetchDelaysCache(
      [...cityKeySet],
      [...daysOfWeekSet],
      today
    );

    console.log(`Fetched delay data for ${cityKeySet.size} cities across ${daysOfWeekSet.size} days`);

    // ── Step 4: Build FORECAST# records for every route in the chunk ──────────
    const forecastItems = [];

    let skippedRoutes = 0;

    for (const ref of routeRefs) {
      // Per-route try/catch — one bad route must not kill the entire chunk.
      // Failed routes are logged and skipped; they will be retried on the next nightly run.
      try {
        const route = routeMap[ref.routeId];

        if (!route) {
          console.warn(`Route not found for userId=${ref.userId} routeId=${ref.routeId} — skipping`);
          skippedRoutes++;
          continue;
        }

        const days = {};

        for (const dayOfWeek of ref.daysOfWeek) {
          const dateStr = dayDateMap[dayOfWeek];
          const hourly = weatherCache[route.cityKey]?.[dateStr] ?? [];
          const allEvents = eventsCache[route.cityKey]?.[dateStr] ?? [];

          // Convert arriveBy from local time to UTC for this specific date
          // Uses IANA timezone rules so DST transitions are handled automatically:
          //   08:45 Europe/Dublin on a summer date  → 07:45 UTC
          //   08:45 Europe/Dublin on a winter date  → 08:45 UTC
          const arriveByUtc = localTimeToUtcHHMM(ref.arriveBy, ref.timezone, dateStr);

          // Filter events to user's commute window first, then to corridor.
          // Events use Ticketmaster's localTime (venue local time) — compare against the user's
          // local arriveBy so both sides are in the same timezone frame.
          // Weather comparisons use arriveByUtc — Open-Meteo data is in UTC.
          const commuteEvents = filterCommuteEvents(allEvents, ref.arriveBy);
          const corridorEvents = filterCorridorEvents(commuteEvents, route);

          const recommendation = getRecommendation({
            hourly,
            corridorEvents,
            arriveBy: arriveByUtc,
            staticDuration: route.staticDuration,
            forecastDate: dateStr
          });

          // forecastDate lets Android anchor the ISO adjustedDepartBy to the correct calendar date
          // for timezone conversion — no client-side date computation required
          days[dayOfWeek] = {
            forecastDate: dateStr,
            recommendation,
            hasWeatherData: hourly.length > 0,
            hasEventData: allEvents.length > 0
          };

          console.log(`${ref.userId} ${ref.routeId} ${dayOfWeek} [${dateStr}]: arriveBy=${ref.arriveBy} local → ${arriveByUtc} UTC, depart=${recommendation.adjustedDepartBy}, buffer=${recommendation.extraBufferMins}mins`);
        }

        forecastItems.push({
          userId: ref.userId,
          recordType: `FORECAST#${ref.routeId}`,
          routeId: ref.routeId,
          days,
          generatedAt: new Date().toISOString()
        });

      } catch (err) {
        console.error(`Failed to process route userId=${ref.userId} routeId=${ref.routeId} — skipping:`, err);
        skippedRoutes++;
      }
    }

    if (skippedRoutes > 0) {
      console.warn(`Chunk completed with ${skippedRoutes} skipped routes out of ${routeRefs.length}`);
    }

    // ── Step 5: Write all FORECAST# records ──────────────────────────────────
    const forecastRequests = forecastItems.map(item => ({ PutRequest: { Item: marshall(item) } }));
    await batchWrite(client, USER_ROUTE_TABLE, forecastRequests);

    console.log(`delayWorker complete — ${forecastItems.length} forecasts written`);

  } catch (err) {
    console.error('delayWorker error:', err);
    throw err; // Re-throw so SQS retries the message — after maxReceiveCount it goes to DLQ
  }
};
