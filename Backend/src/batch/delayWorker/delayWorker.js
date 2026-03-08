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
// Phase 3: re-enable decodePolyline when switching corridor matching to polyline sampling (see ADR-004)
const { batchGet, batchWrite, getDistanceKm /*, decodePolyline */ } = require('/opt/nodejs/utils');
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

// Build corridor points for incident proximity matching.
//
// Phase 2 (current): step locations are the primary strategy — start of each step +
// final destination. Covers all transit stops and walk segment boundaries without
// the Haversine overhead of dense polyline sampling. See ADR-004.
//
// Phase 3: replace with decoded polyline sampling for richer spatial coverage once
// the ML model is trained and the userbase justifies the ~5x increase in compute cost.
// Re-enable the commented block below and restore the decodePolyline import.
const getRouteCorridorPoints = (route) => {
  // --- Phase 3: decoded polyline sampling (commented out — see ADR-004) ---
  // if (route.geometry?.encodedPolyline) {
  //   try {
  //     const points = decodePolyline(route.geometry.encodedPolyline);
  //     return points.filter((_, i) => i % 5 === 0);
  //   } catch {
  //     // Malformed polyline — fall through to step anchor fallback
  //   }
  // }
  // ------------------------------------------------------------------------

  // Primary (Phase 2): step locations — start of each step + final destination
  if (route.steps?.length > 0) {
    const points = route.steps.map(s => ({
      lat: s.startLocation.latLng.latitude,
      lng: s.startLocation.latLng.longitude
    }));
    const last = route.steps[route.steps.length - 1];
    points.push({ lat: last.endLocation.latLng.latitude, lng: last.endLocation.latLng.longitude });
    return points;
  }

  // Fallback: origin + destination only (non-TRANSIT routes or legacy records without steps)
  return [
    { lat: route.origin.location.latLng.latitude, lng: route.origin.location.latLng.longitude },
    { lat: route.destination.location.latLng.latitude, lng: route.destination.location.latLng.longitude }
  ];
};

// Check whether an incident falls within thresholdKm of any corridor point.
// Handles both point incidents { lat, lng } and linestring incidents { path: [{lat,lng},...] }.
// Linestring geometry is used by roadworks and traffic feeds — Ticketmaster events are points.
const isNearCorridor = (incident, corridorPoints, thresholdKm) => {
  const incidentPoints = incident.path ?? [{ lat: incident.lat, lng: incident.lng }];
  return corridorPoints.some(cp =>
    incidentPoints.some(ip => getDistanceKm(cp.lat, cp.lng, ip.lat, ip.lng) <= thresholdKm)
  );
};

// Compute corridor impact radius from estimated event capacity.
// Linear scale: 500 people → 0.1km (effectively at-venue only), 50,000 → 5km.
// Falls back to 0.35km when capacity is unknown (null) — conservative unknown-event radius.
// Capacity values are estimates derived from Ticketmaster segment/genre in eventScraper.
const getEventRadius = (capacity) => {
  if (!capacity || capacity <= 0) return 0.35;
  const clamped = Math.min(Math.max(capacity, 500), 50000);
  return 0.1 + (clamped - 500) / (50000 - 500) * 4.9;
};

// Compute how many minutes before showtime crowds start building for an event.
// Linear scale: 500 people → 25 min (small venue, minimal street impact),
//               50,000 → 90 min (stadium event, congestion an hour before kick-off).
// Examples: 1,500-seat theatre ≈ 26 min, 12k arena ≈ 40 min, 30k stadium ≈ 64 min.
// Falls back to 30 min when capacity is unknown — conservative default.
const getEventPreCrowdMins = (capacity) => {
  if (!capacity || capacity <= 0) return 30;
  const clamped = Math.min(Math.max(capacity, 500), 50000);
  return Math.round(25 + (clamped - 500) / (50000 - 500) * 65);
};

// Compute extra departure buffer to add per corridor event based on estimated attendance.
// Linear scale: 500 people → 10 min, 50,000 → 45 min.
// Examples: 1,500-seat theatre ≈ 11 min, 12k arena ≈ 18 min, 30k stadium ≈ 31 min.
// Falls back to 15 min when capacity is unknown.
const getEventDelayMins = (capacity) => {
  if (!capacity || capacity <= 0) return 15;
  const clamped = Math.min(Math.max(capacity, 500), 50000);
  return Math.round(10 + (clamped - 500) / (50000 - 500) * 35);
};

// Filter incidents to those within the corridor, using a per-event dynamic radius for
// capacity-bearing events. Accepts both point and linestring incident geometry.
// For Ticketmaster events: radius scales with estimated capacity via getEventRadius().
// For future incidents without capacity (roadworks, traffic): falls back to 2km default.
const filterCorridorEvents = (events, route) => {
  const corridorPoints = getRouteCorridorPoints(route);
  return (events || []).filter(ev => {
    if (ev.lat == null && !ev.path) return false; // No geometry — exclude from corridor
    const radiusKm = getEventRadius(ev.capacity);
    return isNearCorridor(ev, corridorPoints, radiusKm);
  });
};

// Corridor filter for roadworks incidents — fixed 2km spatial radius (not crowd-based).
const ROADWORKS_RADIUS_KM = 2.0;
const filterCorridorRoadworks = (incidents, route) => {
  const corridorPoints = getRouteCorridorPoints(route);
  return (incidents || []).filter(inc => {
    if (inc.lat == null && !inc.path) return false;
    return isNearCorridor(inc, corridorPoints, ROADWORKS_RADIUS_KM);
  });
};

// Soft commute-window filter for roadworks incidents.
// TomTom startTime/endTime are ISO 8601 UTC strings — compared against arriveByUtc.
// Applies a 15-minute buffer on each end so incidents starting just after arriveBy
// (or ending just before departBy) are still included.
// Incidents with no time fields at all are conservatively included.
const COMMUTE_WINDOW_BUFFER_MINS = 15;
const filterCommuteWindowRoadworks = (incidents, arriveByUtc, staticDuration, forecastDate) => {
  if (!incidents || incidents.length === 0) return [];
  const [arriveHour, arriveMin] = arriveByUtc.split(':').map(Number);
  const arriveMins = arriveHour * 60 + arriveMin;
  const windowStart = arriveMins - staticDuration - COMMUTE_WINDOW_BUFFER_MINS;
  const windowEnd = arriveMins + COMMUTE_WINDOW_BUFFER_MINS;

  return incidents.filter(inc => {
    if (!inc.startTime && !inc.endTime) return true; // no timing info — include conservatively

    // Resolve minute-of-day bounds for this incident on forecastDate (UTC)
    let incStartMins = 0;    // default: already underway at start of day
    let incEndMins = 1440;   // default: runs through end of day

    if (inc.startTime) {
      const startDateStr = inc.startTime.slice(0, 10);
      if (startDateStr === forecastDate) {
        const t = new Date(inc.startTime);
        incStartMins = t.getUTCHours() * 60 + t.getUTCMinutes();
      } else if (startDateStr > forecastDate) {
        incStartMins = 1440; // starts after this day — no overlap possible
      }
      // startDateStr < forecastDate → 0 (already underway)
    }

    if (inc.endTime) {
      const endDateStr = inc.endTime.slice(0, 10);
      if (endDateStr === forecastDate) {
        const t = new Date(inc.endTime);
        incEndMins = t.getUTCHours() * 60 + t.getUTCMinutes();
      } else if (endDateStr < forecastDate) {
        incEndMins = -1; // ended before this day — no overlap possible
      }
      // endDateStr > forecastDate → 1440 (still running)
    }

    // Include if incident period [incStartMins, incEndMins] overlaps buffered window
    return incStartMins <= windowEnd && incEndMins >= windowStart;
  });
};

// Corridor filter for transit alerts.
// Point alerts (stop-level): Haversine within 0.5km of any corridor point.
// Route alerts (line-level): matched against transit line shortNames in the route's steps.
const TRANSIT_POINT_RADIUS_KM = 0.5;
const filterCorridorTransitAlerts = (transitRecord, route) => {
  if (!transitRecord) return { pointAlerts: [], routeAlerts: [] };
  const { pointAlerts = [], routeAlerts = [] } = transitRecord;
  const corridorPoints = getRouteCorridorPoints(route);

  const corridorPointAlerts = pointAlerts.filter(alert =>
    alert.lat != null && isNearCorridor({ lat: alert.lat, lng: alert.lng }, corridorPoints, TRANSIT_POINT_RADIUS_KM)
  );

  // Match route-level alerts against transit lines used in this route's steps
  const routeLineShortNames = new Set(
    (route.steps || []).map(s => s.transitDetails?.transitLine?.nameShort).filter(Boolean)
  );
  const affectedRouteAlerts = routeAlerts.filter(alert =>
    alert.shortName && routeLineShortNames.has(alert.shortName)
  );

  return { pointAlerts: corridorPointAlerts, routeAlerts: affectedRouteAlerts };
};

// Soft commute-window filter for transit alerts.
// GTFS-RT activePeriods are stored as [{start, end}] Unix seconds on each alert.
// Applies the same COMMUTE_WINDOW_BUFFER_MINS buffer as roadworks for consistency.
// Alerts with no activePeriods (indefinite/feed-wide alerts) are conservatively included.
const filterCommuteWindowTransitAlerts = (transitRecord, arriveByUtc, staticDuration, forecastDate) => {
  if (!transitRecord) return { pointAlerts: [], routeAlerts: [] };
  const { pointAlerts = [], routeAlerts = [] } = transitRecord;

  const [arriveHour, arriveMin] = arriveByUtc.split(':').map(Number);
  const arriveMins = arriveHour * 60 + arriveMin;
  const dayStartSecs = Math.floor(new Date(`${forecastDate}T00:00:00Z`).getTime() / 1000);
  const windowStartSecs = dayStartSecs + (arriveMins - staticDuration - COMMUTE_WINDOW_BUFFER_MINS) * 60;
  const windowEndSecs   = dayStartSecs + (arriveMins + COMMUTE_WINDOW_BUFFER_MINS) * 60;

  const isInWindow = (alert) => {
    const periods = alert.activePeriods;
    if (!periods || periods.length === 0) return true; // no timing info — include conservatively
    return periods.some(p => {
      const start = p.start ?? 0;
      const end   = p.end  ?? Infinity;
      return start <= windowEndSecs && end >= windowStartSecs;
    });
  };

  return {
    pointAlerts: pointAlerts.filter(isInWindow),
    routeAlerts: routeAlerts.filter(isInWindow)
  };
};

// ─── Recommendation Engine ───────────────────────────────────────────────────
// Phase 1: hardcoded deterministic rules.
// This function is the only thing that changes when moving to Haiku or SageMaker.
// Input contract: { hourly, corridorEvents, corridorRoadworks, transitAlerts, arriveBy, staticDuration, forecastDate }
//   arriveBy     — UTC HH:MM string for the forecast date
//   forecastDate — ISO date string "YYYY-MM-DD", anchors adjustedDepartBy as a full UTC timestamp
// Output contract: { adjustedDepartBy, extraBufferMins, reasoning }
//   adjustedDepartBy — ISO 8601 UTC timestamp e.g. "2026-03-30T07:45:00Z"
//   Departure may fall on the day before forecastDate when the commute crosses midnight UTC

// Return the hourly records that fall within the user's commute window [departHour, arriveHour].
// All weather rules operate on this slice — computed once, shared across all Rule 1 checks.
const getCommuteWindowHours = (hourly, arriveBy, staticDuration) => {
  if (!hourly || hourly.length === 0) return [];
  const [arriveHour, arriveMin] = arriveBy.split(':').map(Number);
  const departHour = Math.floor(((arriveHour * 60 + arriveMin) - staticDuration) / 60);
  return hourly.filter(h => {
    const hour = parseInt(h.hour, 10);
    return hour >= departHour && hour <= arriveHour;
  });
};

// Filter events whose pre-crowd phase overlaps with the user's commute window.
// Both sides use local time: Ticketmaster's localTime vs. user's local arriveBy.
//
// Crowds travel to a venue in the getEventPreCrowdMins(capacity) window BEFORE showtime —
// a 9:00 arena event (12k) draws crowds from ~08:20, impacting an 08:45 commuter even though
// the event starts after they arrive. We include the event if that pre-crowd window overlaps
// with the commute window [departTotal, arriveTotal].
//
// Overlap condition:
//   eventStart - preCrowdMins < arriveTotal   → crowd is still building when commuter arrives
//   eventStart >= departTotal                 → event hasn't already started before commuter sets off
//                                               (post-start, streets are clearing not filling)
// Examples:
//   09:00 event (12k), 08:45 arrive, 30 min trip → preCrowdMins≈40, crowd from 08:20
//     08:20 < 08:45 ✓  AND  09:00 >= 08:15 ✓ → INCLUDED
//   00:00 concert, 08:45 arrive, 30 min trip → preCrowdMins≈30
//     -30 < 08:45 ✓  but  00:00 >= 08:15 ✗  → EXCLUDED (event long over before commute)
const filterCommuteEvents = (events, arriveBy, staticDuration) => {
  if (!events || events.length === 0) return [];
  const [arriveHour, arriveMin] = arriveBy.split(':').map(Number);
  const arriveTotal = arriveHour * 60 + arriveMin;
  const departTotal = arriveTotal - staticDuration;
  return events.filter(ev => {
    if (!ev.startTime) return false;
    const [evHour, evMin] = ev.startTime.split(':').map(Number);
    const evTotal = evHour * 60 + evMin;
    const preCrowdMins = getEventPreCrowdMins(ev.capacity);
    return evTotal - preCrowdMins < arriveTotal && evTotal >= departTotal;
  });
};

const getRecommendation = ({ hourly, corridorEvents, corridorRoadworks, transitAlerts, holiday, travelMode, arriveBy, staticDuration, forecastDate }) => {
  const reasons = [];
  let extraBufferMins = 0;

  // staticDuration is required — throw rather than silently produce a wrong departure time
  if (staticDuration === undefined || staticDuration === null) {
    throw new Error(`staticDuration missing on route record — cannot calculate departure time`);
  }

  const windowHours = getCommuteWindowHours(hourly, arriveBy, staticDuration);

  // Rule 1a: any precipitation during commute window → +10 minutes
  // precipitationMm includes rain, showers, and snowfall (total wet output) — catches all wet conditions
  const totalPrecipMm = windowHours.reduce((sum, h) => sum + (h.precipitationMm || 0), 0);
  if (totalPrecipMm > 0.5) {
    extraBufferMins += 10;
    reasons.push('Rain expected during your commute window — allow extra time');
  }

  // Rule 1b: snowfall during commute window → +10 minutes
  // Snowfall is a subset of precipitation but warrants a separate buffer — icy roads and
  // reduced visibility cause delays beyond what wet roads alone produce.
  // Falls back gracefully if snowfallCm is absent (records written before this field was added).
  const totalSnowfallCm = windowHours.reduce((sum, h) => sum + (h.snowfallCm || 0), 0);
  if (totalSnowfallCm > 0.1) {
    extraBufferMins += 10;
    reasons.push('Snow forecast during your commute — allow extra time for icy conditions');
  }

  // Rule 1c: high wind during commute window → +10 minutes
  // Threshold: 50 km/h (Beaufort 7 — near gale). Affects cyclists and pedestrians significantly;
  // also slows traffic on exposed roads and bridges.
  const maxWindKph = windowHours.reduce((max, h) => Math.max(max, h.windspeedKph || 0), 0);
  if (maxWindKph >= 50) {
    extraBufferMins += 10;
    reasons.push(`Strong winds forecast (${Math.round(maxWindKph)} km/h) — allow extra time`);
  }

  // Rule 1d: fog during commute window → +10 minutes
  // WMO weather codes 45 (fog) and 48 (depositing rime fog) indicate near-zero visibility.
  // Falls back gracefully if weatherCode is absent on older records.
  const FOG_CODES = new Set([45, 48]);
  const hasFog = windowHours.some(h => FOG_CODES.has(h.weatherCode));
  if (hasFog) {
    extraBufferMins += 10;
    reasons.push('Fog forecast during your commute — allow extra time for reduced visibility');
  }

  // Rule 2: each corridor event with overlapping pre-crowd window → capacity-scaled buffer
  // Small venues (1,500) add ~11 min; large arenas (12k) ~18 min; stadiums (30k) ~31 min.
  for (const ev of (corridorEvents || [])) {
    const delayMins = getEventDelayMins(ev.capacity);
    extraBufferMins += delayMins;
    reasons.push(`Crowd congestion expected near your route: ${ev.name} — allow an extra ${delayMins} min`);
  }

  // Rule 3: each roadworks incident on the corridor → +10 minutes
  for (const inc of (corridorRoadworks || [])) {
    extraBufferMins += 10;
    reasons.push(`Roadworks on your route${inc.description ? `: ${inc.description}` : ''}`);
  }

  // Rule 4: transit disruptions affecting stops or lines on the route → +10 minutes each
  for (const alert of (transitAlerts?.pointAlerts || [])) {
    extraBufferMins += 10;
    reasons.push(`Transit disruption at ${alert.stopName || 'a stop on your route'}: ${alert.header || 'service alert'}`);
  }
  for (const alert of (transitAlerts?.routeAlerts || [])) {
    extraBufferMins += 10;
    reasons.push(`Service disruption on ${alert.shortName || alert.longName || 'a line on your route'}: ${alert.header || 'service alert'}`);
  }

  // Rule 5: public holiday
  // TRANSIT routes add +10 min — reduced frequency and crowding on public holidays.
  // DRIVE and other modes are informational only — roads are quieter but closures may apply.
  if (holiday) {
    if (travelMode === 'TRANSIT') {
      extraBufferMins += 10;
      reasons.push(`Public holiday (${holiday.name}) — reduced transit service expected, allow extra time`);
    } else {
      reasons.push(`Public holiday (${holiday.name}) — check for road closures or altered services before you travel`);
    }
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

// Fetch WEATHER#, EVENTS#, ROADWORKS#, TRANSIT#, and HOLIDAY# for all unique cityKey + date
// combinations using BatchGetItem.
// Returns { weatherCache, eventsCache, roadworksCache, transitCache, holidayCache, dayDateMap }
const fetchDelaysCache = async (cityKeys, daysOfWeekSet, today) => {
  const weatherCache = {};
  const eventsCache = {};
  const roadworksCache = {};
  const transitCache = {};
  const holidayCache = {};

  // Resolve the next UTC date for each unique day of week once
  const dayDateMap = {};
  for (const day of daysOfWeekSet) {
    dayDateMap[day] = getNextDateForDay(day, today);
  }

  // Initialise caches with empty defaults so missing records don't cause undefined lookups
  for (const cityKey of cityKeys) {
    weatherCache[cityKey] = {};
    eventsCache[cityKey] = {};
    roadworksCache[cityKey] = {};
    transitCache[cityKey] = {};
    holidayCache[cityKey] = {};
    for (const day of daysOfWeekSet) {
      const dateStr = dayDateMap[day];
      weatherCache[cityKey][dateStr] = [];
      eventsCache[cityKey][dateStr] = [];
      roadworksCache[cityKey][dateStr] = null; // null = no ROADWORKS# record written for this date
      transitCache[cityKey][dateStr] = null; // null = no TRANSIT# record written for this date
      holidayCache[cityKey][dateStr] = null; // null = not a public holiday
    }
  }

  // Build all keys — all 5 record types for every cityKey × day combination
  const keys = [];
  for (const cityKey of cityKeys) {
    for (const day of daysOfWeekSet) {
      const dateStr = dayDateMap[day];
      keys.push(marshall({ cityKey, typeDate: `WEATHER#${dateStr}` }));
      keys.push(marshall({ cityKey, typeDate: `EVENTS#${dateStr}` }));
      keys.push(marshall({ cityKey, typeDate: `ROADWORKS#${dateStr}` }));
      keys.push(marshall({ cityKey, typeDate: `TRANSIT#${dateStr}` }));
      keys.push(marshall({ cityKey, typeDate: `HOLIDAY#${dateStr}` }));
    }
  }

  const results = await batchGet(client, DELAYS_TABLE, keys, item => `${item.cityKey}|${item.typeDate}`, unmarshall);

  for (const item of Object.values(results)) {
    const [type] = item.typeDate.split('#');
    if (type === 'WEATHER') {
      weatherCache[item.cityKey][item.date] = item.hourly || [];
    } else if (type === 'EVENTS') {
      eventsCache[item.cityKey][item.date] = item.events || [];
    } else if (type === 'ROADWORKS') {
      roadworksCache[item.cityKey][item.date] = item.incidents ?? [];
    } else if (type === 'TRANSIT') {
      transitCache[item.cityKey][item.date] = {
        pointAlerts: item.pointAlerts || [],
        routeAlerts: item.routeAlerts || []
      };
    } else if (type === 'HOLIDAY') {
      // SK is HOLIDAY#YYYY-MM-DD — extract the date portion after the first '#'
      const date = item.typeDate.slice('HOLIDAY#'.length);
      holidayCache[item.cityKey][date] = { name: item.name, types: item.types || [] };
    }
  }

  return { weatherCache, eventsCache, roadworksCache, transitCache, holidayCache, dayDateMap };
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
    const { weatherCache, eventsCache, roadworksCache, transitCache, holidayCache, dayDateMap } = await fetchDelaysCache(
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
          const allRoadworks = roadworksCache[route.cityKey]?.[dateStr] ?? null;
          const transitRecord = transitCache[route.cityKey]?.[dateStr] ?? null;

          // Convert arriveBy from local time to UTC for this specific date
          // Uses IANA timezone rules so DST transitions are handled automatically:
          //   08:45 Europe/Dublin on a summer date  → 07:45 UTC
          //   08:45 Europe/Dublin on a winter date  → 08:45 UTC
          const arriveByUtc = localTimeToUtcHHMM(ref.arriveBy, ref.timezone, dateStr);

          // Filter events to user's commute window [departTime, arriveBy], then to corridor.
          // Events use Ticketmaster's localTime (venue local time) — compare against the user's
          // local arriveBy so both sides are in the same timezone frame.
          // Weather comparisons use arriveByUtc — Open-Meteo data is in UTC.
          const commuteEvents = filterCommuteEvents(allEvents, ref.arriveBy, route.staticDuration);
          const corridorEvents = filterCorridorEvents(commuteEvents, route);
          const commuteRoadworks = filterCommuteWindowRoadworks(allRoadworks ?? [], arriveByUtc, route.staticDuration, dateStr);
          const corridorRoadworks = filterCorridorRoadworks(commuteRoadworks, route);
          const commuteTransitRecord = filterCommuteWindowTransitAlerts(transitRecord, arriveByUtc, route.staticDuration, dateStr);
          const transitAlerts = filterCorridorTransitAlerts(commuteTransitRecord, route);
          const holiday = holidayCache[route.cityKey]?.[dateStr] ?? null;

          const recommendation = getRecommendation({
            hourly,
            corridorEvents,
            corridorRoadworks,
            transitAlerts,
            holiday,
            travelMode: route.travelMode,
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
            hasEventData: allEvents.length > 0,
            hasRoadworksData: allRoadworks !== null,
            hasTransitData: transitRecord !== null,
            hasHolidayData: holiday !== null
          };

          const corridorSummary = corridorEvents.map(ev => `${ev.name}(r=${getEventRadius(ev.capacity).toFixed(1)}km)`).join(', ') || 'none';
          const roadworksSummary = corridorRoadworks.map(inc => inc.description || 'unnamed').join(', ') || 'none';
          console.log(`${ref.userId} ${ref.routeId} ${dayOfWeek} [${dateStr}]: arriveBy=${ref.arriveBy} local → ${arriveByUtc} UTC, depart=${recommendation.adjustedDepartBy}, buffer=${recommendation.extraBufferMins}mins, corridorEvents=[${corridorSummary}], roadworks=[${roadworksSummary}], holiday=${holiday?.name ?? 'none'}`);
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
