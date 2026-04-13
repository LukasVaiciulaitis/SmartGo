// delayWorker — triggered by SQS, MaximumConcurrency controlled via event source mapping
// Receives a chunk of up to 250 {userId, routeId, arriveBy, timezone, daysOfWeek} from delayOrchestrator.
//
// Timezone handling:
//   arriveBy is stored as the user's LOCAL time intent e.g. "08:45" — not UTC
//   timezone is the IANA identifier e.g. "Europe/Dublin" stored on SCHEDULE#
//   For each forecast date, arriveBy is converted to UTC using the IANA timezone rules
//   for that specific date — this means DST is handled automatically.
//   A user who sets 08:45 always gets a forecast for 08:45 local time, winter or summer.
//   All time comparisons operate in UTC.
//
// Recommendation engine:
// Phase 3 (current): SageMaker endpoint invocations for Sage-predicted trafficDeltaSeconds.
//   Two models: road (DRIVE/BUS/TRAM/WALK/etc.) and rail (RAIL/SUBWAY/COMMUTER_TRAIN/etc.).
//
//   TRANSIT routes: all road-type legs across all forecast days are batched into one road
//   model invocation; all rail-type legs across all forecast days into one rail invocation.
//   At most two SageMaker calls per route regardless of leg or day count.
//
//   Non-TRANSIT routes: all forecast days are batched into one road model invocation.
//   One SageMaker call per route.
//
//   TRANSIT routes: timetable cascade runs inline after SM predictions. TIMETABLE# records
//   are fetched in the same BatchGetItem as weather/events/roadworks data. For each step,
//   simulateCascadeBackwards snaps to the latest real scheduled departure and propagates
//   connection constraints backwards. Gracefully falls back to arithmetic per step when no
//   timetable data exists. FORECAST# is written once with the already-snapped departure.
//
// adjustedDepartBy is stored as a full ISO 8601 UTC timestamp e.g. "2026-03-30T07:45:00Z".
// Storing the date eliminates two problems for Android:
//   1. DST ambiguity — Android converts using Instant.parse() + ZoneId, no date guessing needed
//   2. Midnight crossings — departure naturally falls on the previous calendar day when
//      arriveBy UTC - staticDuration - buffer goes negative (no clamping to 00:00)

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { SageMakerRuntimeClient, InvokeEndpointCommand } = require('@aws-sdk/client-sagemaker-runtime');
// Phase 3: re-enable decodePolyline when switching corridor matching to polyline sampling (see ADR-004)
const { batchGet, batchWrite, getDistanceKm, WMO_CONDITION, RAIL_VEHICLE_TYPES, parseDurationToMinutes /*, decodePolyline */ } = require('/opt/nodejs/utils');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

const client    = new DynamoDBClient({});
const smRuntime = new SageMakerRuntimeClient({});

const USER_ROUTE_TABLE   = process.env.USER_ROUTE_TABLE;
const DELAYS_TABLE       = process.env.DELAYS_TABLE;
const ROAD_ENDPOINT_NAME = process.env.ROAD_ENDPOINT_NAME;
const RAIL_ENDPOINT_NAME = process.env.RAIL_ENDPOINT_NAME;

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
// the Sage model is trained and the userbase justifies the ~5x increase in compute cost.
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


// ─── Reasoning builder ───────────────────────────────────────────────────────
// Converts the reason codes returned by the Sage models into user-facing text.
// Codes that reference named entities (EVENT, ROADWORKS, SERVICE_ALERT, HOLIDAY) are
// enriched with names/descriptions from the corridor data already in scope.
const buildReasoningFromCodes = (reasonCodes, corridorEvents, corridorRoadworks, transitAlerts, holiday, travelMode) => {
  const parts = [];
  for (const code of reasonCodes) {
    switch (code) {
      case 'RAIN':
        parts.push('Rain expected during your commute — allow extra time');
        break;
      case 'SNOW':
        parts.push('Snow forecast on your route — allow extra time for icy conditions');
        break;
      case 'FOG':
        parts.push('Fog forecast during your commute — allow extra time for reduced visibility');
        break;
      case 'HIGH_WIND':
        parts.push('High winds forecast on your route — allow extra time');
        break;
      case 'CORRIDOR_TRAFFIC':
        parts.push('This route tends to be busier at this time — allow extra time');
        break;
      case 'SCHEDULE_PATTERN':
        parts.push('This service tends to run late at this time — allow extra time');
        break;
      case 'EVENT':
        for (const ev of (corridorEvents || [])) {
          const delayMins = getEventDelayMins(ev.capacity);
          parts.push(`Crowd congestion expected near your route: ${ev.name} — allow an extra ${delayMins} min`);
        }
        break;
      case 'ROADWORKS':
        for (const inc of (corridorRoadworks || [])) {
          parts.push(`Roadworks on your route${inc.description ? `: ${inc.description}` : ''}`);
        }
        break;
      case 'SERVICE_ALERT':
        for (const alert of (transitAlerts?.pointAlerts || [])) {
          parts.push(`Transit disruption at ${alert.stopName || 'a stop on your route'}: ${alert.header || 'service alert'}`);
        }
        for (const alert of (transitAlerts?.routeAlerts || [])) {
          parts.push(`Service disruption on ${alert.shortName || alert.longName || 'a line on your route'}: ${alert.header || 'service alert'}`);
        }
        break;
      case 'HOLIDAY':
        if (holiday) {
          if (travelMode === 'TRANSIT') {
            parts.push(`Public holiday (${holiday.name}) — reduced transit service expected, allow extra time`);
          } else {
            parts.push(`Public holiday (${holiday.name}) — check for road closures or altered services before you travel`);
          }
        }
        break;
    }
  }
  return parts;
};

// ─── Sage Inference ───────────────────────────────────────────────────────────
// Both callers accept an array of feature objects and return an array of predictions.
// The model endpoints handle both single-object and array input (see sageRoadModel.py /
// sageRailModel.py predict_fn); we always send arrays for batched throughput.
// Empty array input short-circuits without an API call.

const callRoadModelBatch = async (featuresArray) => {
  if (featuresArray.length === 0) return [];
  const res = await smRuntime.send(new InvokeEndpointCommand({
    EndpointName: ROAD_ENDPOINT_NAME,
    ContentType:  'application/json',
    Accept:       'application/json',
    Body:         JSON.stringify(featuresArray),
  }));
  const result = JSON.parse(Buffer.from(res.Body).toString('utf-8'));
  return Array.isArray(result) ? result : [result];
};

const callRailModelBatch = async (featuresArray) => {
  if (featuresArray.length === 0) return [];
  const res = await smRuntime.send(new InvokeEndpointCommand({
    EndpointName: RAIL_ENDPOINT_NAME,
    ContentType:  'application/json',
    Accept:       'application/json',
    Body:         JSON.stringify(featuresArray),
  }));
  const result = JSON.parse(Buffer.from(res.Body).toString('utf-8'));
  return Array.isArray(result) ? result : [result];
};

// ─── Road model features ──────────────────────────────────────────────────────
// Builds the feature payload for the road SageMaker model.
//
// Covers surface vehicles subject to traffic, roadworks, and events:
// BUS, TRAM, WALK, DRIVE, TWO_WHEELER, BICYCLE, FERRY, CABLE_CAR, etc.
//
// step:  null for whole-route non-TRANSIT journeys (DRIVE/WALK/TWO_WHEELER/BICYCLE);
//        or an individual step for road legs within a TRANSIT route (WALK/BUS/TRAM steps).
//        When step is provided, step.staticDuration and vehicle.type override route-level values.
//        Returns null when step is provided but lacks staticDuration (pre-Phase 2 record — skip).
// route: full route record for corridor context (distanceMeters, staticDuration, steps)
// ref:   schedule record — ref.arriveBy is local HH:MM used for departure time and legType
const buildRoadFeatures = (step, route, ref, hourly, corridorEvents, corridorRoadworks, holiday, dayOfWeek, arriveByUtc) => {
  // Duration — step-level when available, route-level for whole-route calls
  let staticDurationSecs;
  if (step !== null) {
    const parsed = parseInt(String(step.staticDuration ?? '').replace(/s$/, ''), 10);
    if (!step.staticDuration || isNaN(parsed) || parsed === 0) return null;
    staticDurationSecs = parsed;
  } else {
    staticDurationSecs = (route.staticDuration ?? 30) * 60;
  }
  const staticDurationMins = staticDurationSecs / 60;

  // Travel mode — step vehicle type for per-step calls, route travelMode for whole-route calls
  const travelMode = step !== null
    ? (step.travelMode === 'TRANSIT'
        ? (step.transitDetails?.transitLine?.vehicle?.type ?? 'BUS')
        : step.travelMode)
    : (route.travelMode ?? 'DRIVE');

  // Departure time — local HH:MM so the model sees the same time-of-day patterns it was trained on
  const [localArrH, localArrM] = ref.arriveBy.split(':').map(Number);
  const localArrMins = localArrH * 60 + localArrM;
  const localDepMins = ((localArrMins - staticDurationMins) % 1440 + 1440) % 1440;
  const localDepH = Math.floor(localDepMins / 60);
  const localDepM = localDepMins % 60;
  const departureTimeLocal = `${String(localDepH).padStart(2, '0')}:${String(localDepM).padStart(2, '0')}`;

  const legType = localArrH >= 5 && localArrH <= 11 ? 'morningCommute' : 'eveningReturn';

  // Weather — UTC departure hour (Open-Meteo hourly records are UTC-keyed)
  const [utcArrH, utcArrM] = arriveByUtc.split(':').map(Number);
  const utcArrMins = utcArrH * 60 + utcArrM;
  const utcDepMins = ((utcArrMins - staticDurationMins) % 1440 + 1440) % 1440;
  const utcDepH    = Math.floor(utcDepMins / 60);
  const depHourWeather = hourly.find(h => h.hour === utcDepH) ?? hourly[0] ?? {};
  const weatherCode    = depHourWeather.weatherCode ?? 0;
  const weatherCondition = WMO_CONDITION[weatherCode] ?? 'Clear';

  // Events and roadworks — corridor-level signals for road delay prediction
  const eventCount     = corridorEvents.length;
  const maxEventCap    = eventCount > 0 ? Math.max(...corridorEvents.map(e => e.capacity ?? 0)) : 0;
  const corridorPoints = getRouteCorridorPoints(route);
  const nearestEventKm = eventCount > 0
    ? Math.min(...corridorEvents.map(ev =>
        Math.min(...corridorPoints.map(cp => getDistanceKm(cp.lat, cp.lng, ev.lat, ev.lng)))
      ))
    : 99.0;
  const roadworksCount    = corridorRoadworks.length;
  const roadworksFraction = Math.min(roadworksCount * 0.10, 1.0); // ~10% of leg per incident, capped at 100%

  return {
    departureTimeLocal,
    dayOfWeek,
    legType,
    travelMode,
    distanceMeters:        route.distanceMeters ?? 10000,
    staticDurationSeconds: staticDurationSecs,
    weatherTempC:          depHourWeather.temperatureC  ?? 10.0,
    weatherPrecipMm:       depHourWeather.precipitationMm ?? 0.0,
    weatherWindKph:        depHourWeather.windspeedKph  ?? 15.0,
    weatherCondition,
    eventCount,
    maxEventCapacity:      maxEventCap,
    nearestEventKm,
    roadworksCount,
    roadworksFraction,
    isHoliday:             holiday ? 1 : 0,
  };
};

// ─── Rail model features ──────────────────────────────────────────────────────
// Builds the feature payload for the rail SageMaker model.
//
// Covers dedicated right-of-way vehicles with timetable-driven delay patterns:
// RAIL, SUBWAY, COMMUTER_TRAIN, HIGH_SPEED_TRAIN, LONG_DISTANCE_TRAIN, MONORAIL, etc.
//
// Roadworks are excluded — road construction does not affect rail infrastructure.
// Events are included — stadium/concert crowds increase train occupancy and cause delays.
// isHoliday is included — holiday patterns affect both service frequency and passenger demand.
// hasServiceAlert and lineShortName are the primary signals for rail schedule adherence.
//
// Returns null when step lacks staticDuration (pre-Phase 2 record — skip).
const buildRailFeatures = (step, route, ref, hourly, corridorEvents, transitAlerts, holiday, dayOfWeek, arriveByUtc) => {
  const parsed = parseInt(String(step.staticDuration ?? '').replace(/s$/, ''), 10);
  if (!step.staticDuration || isNaN(parsed) || parsed === 0) return null;
  const staticDurationSecs = parsed;
  const staticDurationMins = staticDurationSecs / 60;

  const travelMode = step.transitDetails?.transitLine?.vehicle?.type ?? 'RAIL';

  // Departure time — local HH:MM so the model sees the same time-of-day patterns it was trained on
  const [localArrH, localArrM] = ref.arriveBy.split(':').map(Number);
  const localArrMins = localArrH * 60 + localArrM;
  const localDepMins = ((localArrMins - staticDurationMins) % 1440 + 1440) % 1440;
  const localDepH = Math.floor(localDepMins / 60);
  const localDepM = localDepMins % 60;
  const departureTimeLocal = `${String(localDepH).padStart(2, '0')}:${String(localDepM).padStart(2, '0')}`;

  const legType = localArrH >= 5 && localArrH <= 11 ? 'morningCommute' : 'eveningReturn';

  // Weather — UTC departure hour (Open-Meteo hourly records are UTC-keyed)
  const [utcArrH, utcArrM] = arriveByUtc.split(':').map(Number);
  const utcArrMins = utcArrH * 60 + utcArrM;
  const utcDepMins = ((utcArrMins - staticDurationMins) % 1440 + 1440) % 1440;
  const utcDepH    = Math.floor(utcDepMins / 60);
  const depHourWeather = hourly.find(h => h.hour === utcDepH) ?? hourly[0] ?? {};
  const weatherCode    = depHourWeather.weatherCode ?? 0;
  const weatherCondition = WMO_CONDITION[weatherCode] ?? 'Clear';

  // Events — stadium/concert crowds increase train occupancy and cause platform/service delays
  const eventCount     = corridorEvents.length;
  const maxEventCap    = eventCount > 0 ? Math.max(...corridorEvents.map(e => e.capacity ?? 0)) : 0;
  const corridorPoints = getRouteCorridorPoints(route);
  const nearestEventKm = eventCount > 0
    ? Math.min(...corridorEvents.map(ev =>
        Math.min(...corridorPoints.map(cp => getDistanceKm(cp.lat, cp.lng, ev.lat, ev.lng)))
      ))
    : 99.0;

  // Service alert — primary signal for rail punctuality and schedule adherence
  const lineShortName = step.transitDetails?.transitLine?.nameShort ?? null;
  const hasServiceAlert = lineShortName
    ? ((transitAlerts?.routeAlerts || []).some(a => a.shortName === lineShortName) ? 1 : 0)
    : 0;

  return {
    departureTimeLocal,
    dayOfWeek,
    legType,
    travelMode,
    distanceMeters:        route.distanceMeters ?? 10000,
    staticDurationSeconds: staticDurationSecs,
    weatherTempC:          depHourWeather.temperatureC  ?? 10.0,
    weatherPrecipMm:       depHourWeather.precipitationMm ?? 0.0,
    weatherWindKph:        depHourWeather.windspeedKph  ?? 15.0,
    weatherCondition,
    eventCount,
    maxEventCapacity:      maxEventCap,
    nearestEventKm,
    isHoliday:             holiday ? 1 : 0,
    lineShortName:         lineShortName ?? '',
    hasServiceAlert,
  };
};

// ─── Timetable helpers ────────────────────────────────────────────────────────

// Returns the total minutes of the latest scheduled departure at or before targetMins,
// or null if no such departure exists in the sorted 'HH:MM' departures array.
const snapToScheduledDeparture = (departures, targetMins) => {
  let best = null;
  for (const dep of departures) {
    const [h, m] = dep.split(':').map(Number);
    const depTotal = h * 60 + m;
    if (depTotal <= targetMins && (best === null || depTotal > best)) best = depTotal;
  }
  return best;
};

// Walk backwards through route steps, subtracting each step's effective duration
// (staticDuration + SageMaker-predicted delay) from the current target arrival.
// For TRANSIT steps with a timetable, snaps to the latest real departure that fits.
// A snapped departure earlier than the arithmetic required time cascades backwards —
// the preceding step must finish earlier to make the connection.
//
// steps:          route.steps array
// timetableCache: { [typeDate]: { schedule: { MON: ['HH:MM', ...], ... } } }
// dayOfWeek:      e.g. 'MON'
// arriveByMins:   arriveBy in total minutes from midnight (UTC)
// stepDelays:     Map<stepIndex, delaySeconds> from SageMaker predictions
//
// Returns { departMins, cascadeReasons }
const simulateCascadeBackwards = (steps, timetableCache, dayOfWeek, arriveByMins, stepDelays) => {
  const cascadeReasons = [];
  let currentTarget = arriveByMins;

  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const stepMins = parseDurationToMinutes(step.staticDuration);
    if (stepMins === null) continue; // pre-Phase 2 route — no per-step duration stored

    const stepDelayMins = Math.round((stepDelays.get(i) ?? 0) / 60);
    const effectiveMins = stepMins + stepDelayMins;

    if (step.travelMode === 'WALK') {
      currentTarget -= effectiveMins;

    } else if (step.travelMode === 'TRANSIT' && step.startLocation?.latLng) {
      const requiredDeparture = currentTarget - effectiveMins;
      const lineShortName     = step.transitDetails?.transitLine?.nameShort;

      if (lineShortName) {
        const { latitude: lat, longitude: lng } = step.startLocation.latLng;
        const timetableKey = `TIMETABLE#${lineShortName}#${lat.toFixed(4)}#${lng.toFixed(4)}`;
        const timetable    = timetableCache[timetableKey];

        if (timetable?.schedule) {
          const dayDepartures = timetable.schedule[dayOfWeek] || [];
          const snapped = snapToScheduledDeparture(dayDepartures, requiredDeparture);
          if (snapped !== null) {
            if (snapped < requiredDeparture - 1) {
              const h = String(Math.floor(snapped / 60)).padStart(2, '0');
              const m = String(snapped % 60).padStart(2, '0');
              cascadeReasons.push(`Catch the ${h}:${m} ${lineShortName} service`);
            }
            currentTarget = snapped;
          } else {
            currentTarget = requiredDeparture; // no prior service found — fall back to arithmetic
          }
        } else {
          currentTarget = requiredDeparture; // no timetable yet — graceful fallback
        }
      } else {
        currentTarget = requiredDeparture;
      }
    }
  }

  return { departMins: currentTarget, cascadeReasons };
};

// ─── DynamoDB Fetch Helpers ───────────────────────────────────────────────────

// Fetch WEATHER#, EVENTS#, ROADWORKS#, TRANSIT#, HOLIDAY#, and TIMETABLE# records
// in a single BatchGetItem. Date-scoped records keyed by cityKey × date; TIMETABLE#
// records keyed by cityKey × timetable key (static, updated weekly by timetable pipeline).
// Returns { weatherCache, eventsCache, roadworksCache, transitCache, holidayCache, timetableCache, dayDateMap }
const fetchDelaysCache = async (cityKeys, daysOfWeekSet, today, timetableKeys = []) => {
  const weatherCache   = {};
  const eventsCache    = {};
  const roadworksCache = {};
  const transitCache   = {};
  const holidayCache   = {};
  const timetableCache = {}; // { [typeDate]: { schedule: { MON: ['HH:MM', ...], ... } } }

  // Resolve the next UTC date for each unique day of week once
  const dayDateMap = {};
  for (const day of daysOfWeekSet) {
    dayDateMap[day] = getNextDateForDay(day, today);
  }

  // Initialise caches with empty defaults so missing records don't cause undefined lookups
  for (const cityKey of cityKeys) {
    weatherCache[cityKey]   = {};
    eventsCache[cityKey]    = {};
    roadworksCache[cityKey] = {};
    transitCache[cityKey]   = {};
    holidayCache[cityKey]   = {};
    for (const day of daysOfWeekSet) {
      const dateStr = dayDateMap[day];
      weatherCache[cityKey][dateStr]   = [];
      eventsCache[cityKey][dateStr]    = [];
      roadworksCache[cityKey][dateStr] = null; // null = no ROADWORKS# record written for this date
      transitCache[cityKey][dateStr]   = null; // null = no TRANSIT# record written for this date
      holidayCache[cityKey][dateStr]   = null; // null = not a public holiday
    }
  }

  // Build all keys — 5 date-scoped record types per cityKey × day, plus static TIMETABLE# keys
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
  // TIMETABLE# keys are static (not date-scoped) — appended to the same batch
  for (const key of timetableKeys) keys.push(key);

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
      const date = item.typeDate.slice('HOLIDAY#'.length);
      holidayCache[item.cityKey][date] = { name: item.name, types: item.types || [] };
    } else if (type === 'TIMETABLE') {
      timetableCache[item.typeDate] = { schedule: item.schedule || {} };
    }
  }

  return { weatherCache, eventsCache, roadworksCache, transitCache, holidayCache, timetableCache, dayDateMap };
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

    // ── Step 2: Determine unique cityKeys, daysOfWeek, and TIMETABLE# keys ──
    const cityKeySet       = new Set();
    const daysOfWeekSet    = new Set();
    const timetableKeysSeen = new Set(); // dedupe: cityKey|typeDate
    const timetableKeys    = [];         // DDB-marshalled keys for fetchDelaysCache

    for (const ref of routeRefs) {
      const route = routeMap[ref.routeId];
      if (!route) continue;
      if (route.cityKey) cityKeySet.add(route.cityKey);
      for (const day of ref.daysOfWeek) daysOfWeekSet.add(day);

      // Collect unique TIMETABLE# keys for TRANSIT steps that have schedule data
      if (route.travelMode === 'TRANSIT' && route.steps?.length > 0) {
        for (const step of route.steps) {
          if (step.travelMode === 'TRANSIT'
              && step.transitDetails?.transitLine?.nameShort
              && step.startLocation?.latLng) {
            const { latitude: lat, longitude: lng } = step.startLocation.latLng;
            const lineShortName = step.transitDetails.transitLine.nameShort;
            const typeDate      = `TIMETABLE#${lineShortName}#${lat.toFixed(4)}#${lng.toFixed(4)}`;
            const dedupeKey     = `${route.cityKey}|${typeDate}`;
            if (!timetableKeysSeen.has(dedupeKey)) {
              timetableKeysSeen.add(dedupeKey);
              timetableKeys.push(marshall({ cityKey: route.cityKey, typeDate }));
            }
          }
        }
      }
    }

    // ── Step 3: Fetch delay data and timetable records in one batch ──────────
    const { weatherCache, eventsCache, roadworksCache, transitCache, holidayCache, timetableCache, dayDateMap } =
      await fetchDelaysCache([...cityKeySet], [...daysOfWeekSet], today, timetableKeys);

    console.log(`Fetched delay data for ${cityKeySet.size} cities across ${daysOfWeekSet.size} days, ${timetableKeys.length} timetable records`);

    // ── Step 4: Collect all feature vectors from every route (no SM calls yet) ─
    // Feature collection is fully synchronous. Each valid route appends its vectors
    // to the chunk-level road/rail arrays tagged with a routeIdx so results can be
    // mapped back after the single pair of SM calls in Step 5.
    //
    // TRANSIT routes: one road entry + one rail entry per (step, day) combination.
    //   stepIndex is the step array index — used to accumulate per-step delays.
    // Non-TRANSIT routes: one road entry per day, stepIndex null signals whole-route.
    let   skippedRoutes   = 0;
    const validRoutes     = []; // routes that survived feature collection
    const routeDayData    = []; // dayData per valid route, parallel to validRoutes

    const chunkRoadInputs = []; // all road feature vectors across all routes/days/steps
    const chunkRoadKeys   = []; // { routeIdx, stepIndex, dayOfWeek } — parallel to chunkRoadInputs
    const chunkRailInputs = []; // all rail feature vectors across all routes/days/steps
    const chunkRailKeys   = []; // { routeIdx, stepIndex, dayOfWeek } — parallel to chunkRailInputs

    for (const ref of routeRefs) {
      try {
        const route = routeMap[ref.routeId];
        if (!route) {
          console.warn(`Route not found for userId=${ref.userId} routeId=${ref.routeId} — skipping`);
          skippedRoutes++;
          continue;
        }

        // Precompute per-day corridor context — all filtering done once per day
        // so the inner step loop only reads pre-filtered arrays.
        const dayData = {};
        for (const dayOfWeek of ref.daysOfWeek) {
          const dateStr       = dayDateMap[dayOfWeek];
          const hourly        = weatherCache[route.cityKey]?.[dateStr] ?? [];
          const allEvents     = eventsCache[route.cityKey]?.[dateStr] ?? [];
          const allRoadworks  = roadworksCache[route.cityKey]?.[dateStr] ?? null;
          const transitRecord = transitCache[route.cityKey]?.[dateStr] ?? null;
          const holiday       = holidayCache[route.cityKey]?.[dateStr] ?? null;
          const arriveByUtc   = localTimeToUtcHHMM(ref.arriveBy, ref.timezone, dateStr);

          const commuteEvents     = filterCommuteEvents(allEvents, ref.arriveBy, route.staticDuration);
          const corridorEvents    = filterCorridorEvents(commuteEvents, route);
          const commuteRoadworks  = filterCommuteWindowRoadworks(allRoadworks ?? [], arriveByUtc, route.staticDuration, dateStr);
          const corridorRoadworks = filterCorridorRoadworks(commuteRoadworks, route);
          const commuteTransit    = filterCommuteWindowTransitAlerts(transitRecord, arriveByUtc, route.staticDuration, dateStr);
          const transitAlerts     = filterCorridorTransitAlerts(commuteTransit, route);

          dayData[dayOfWeek] = {
            dateStr, hourly, allEvents, allRoadworks, transitRecord,
            holiday, arriveByUtc, corridorEvents, corridorRoadworks, transitAlerts,
          };
        }

        const routeIdx = validRoutes.length;
        validRoutes.push({ ref, route });
        routeDayData.push(dayData);

        if (route.travelMode === 'TRANSIT' && route.steps?.length > 0) {
          for (const dayOfWeek of ref.daysOfWeek) {
            const { hourly, corridorEvents, corridorRoadworks, transitAlerts, holiday, arriveByUtc } = dayData[dayOfWeek];
            for (const [i, step] of route.steps.entries()) {
              const vehicleType = step.travelMode === 'TRANSIT'
                ? (step.transitDetails?.transitLine?.vehicle?.type ?? 'BUS')
                : step.travelMode;
              if (RAIL_VEHICLE_TYPES.has(vehicleType)) {
                const features = buildRailFeatures(step, route, ref, hourly, corridorEvents, transitAlerts, holiday, dayOfWeek, arriveByUtc);
                if (features) { chunkRailInputs.push(features); chunkRailKeys.push({ routeIdx, stepIndex: i, dayOfWeek }); }
              } else {
                const features = buildRoadFeatures(step, route, ref, hourly, corridorEvents, corridorRoadworks, holiday, dayOfWeek, arriveByUtc);
                if (features) { chunkRoadInputs.push(features); chunkRoadKeys.push({ routeIdx, stepIndex: i, dayOfWeek }); }
              }
            }
          }
        } else {
          // Non-TRANSIT: one whole-route feature vector per day; stepIndex null distinguishes
          // these from TRANSIT step entries when mapping results back in Step 5.
          for (const dayOfWeek of ref.daysOfWeek) {
            const { hourly, corridorEvents, corridorRoadworks, holiday, arriveByUtc } = dayData[dayOfWeek];
            const features = buildRoadFeatures(null, route, ref, hourly, corridorEvents, corridorRoadworks, holiday, dayOfWeek, arriveByUtc);
            if (features) { chunkRoadInputs.push(features); chunkRoadKeys.push({ routeIdx, stepIndex: null, dayOfWeek }); }
          }
        }

      } catch (err) {
        console.error(`Feature collection failed for userId=${ref.userId} routeId=${ref.routeId} — skipping:`, err);
        skippedRoutes++;
      }
    }

    // ── Step 5: Two SM calls for the entire chunk ─────────────────────────────
    // One road call and one rail call cover all routes, all days, all steps.
    // Per-model catch is independent — rail failure does not zero road results.
    console.log(`SM batch: ${chunkRoadInputs.length} road vectors + ${chunkRailInputs.length} rail vectors across ${validRoutes.length} routes`);

    const [allRoadResults, allRailResults] = await Promise.all([
      (chunkRoadInputs.length > 0 ? callRoadModelBatch(chunkRoadInputs) : Promise.resolve([]))
        .catch(err => {
          console.warn(`Road SM batch failed for chunk — using 0 delays: ${err.message}`);
          return chunkRoadInputs.map(() => ({ trafficDeltaSeconds: 0, lo: null, hi: null, reasonCodes: [] }));
        }),
      (chunkRailInputs.length > 0 ? callRailModelBatch(chunkRailInputs) : Promise.resolve([]))
        .catch(err => {
          console.warn(`Rail SM batch failed for chunk — using 0 delays: ${err.message}`);
          return chunkRailInputs.map(() => ({ trafficDeltaSeconds: 0, lo: null, hi: null, reasonCodes: [] }));
        }),
    ]);

    // Map results back into per-route per-day accumulators using the parallel key arrays.
    // TRANSIT step entries (stepIndex set) go into stepDelaysPerRoute.
    // Non-TRANSIT whole-route entries (stepIndex null) go into dayResultsPerRoute.
    const stepDelaysPerRoute      = validRoutes.map(({ ref }) =>
      Object.fromEntries(ref.daysOfWeek.map(d => [d, new Map()])));
    const stepReasonCodesPerRoute = validRoutes.map(({ ref }) =>
      Object.fromEntries(ref.daysOfWeek.map(d => [d, new Set()])));
    const dayResultsPerRoute      = validRoutes.map(({ ref }) =>
      Object.fromEntries(ref.daysOfWeek.map(d => [d, null])));

    allRoadResults.forEach((result, j) => {
      const { routeIdx, stepIndex, dayOfWeek } = chunkRoadKeys[j];
      if (stepIndex !== null) {
        stepDelaysPerRoute[routeIdx][dayOfWeek].set(stepIndex, result.trafficDeltaSeconds ?? 0);
        for (const code of (result.reasonCodes ?? [])) stepReasonCodesPerRoute[routeIdx][dayOfWeek].add(code);
      } else {
        dayResultsPerRoute[routeIdx][dayOfWeek] = result;
      }
    });
    allRailResults.forEach((result, j) => {
      const { routeIdx, stepIndex, dayOfWeek } = chunkRailKeys[j];
      stepDelaysPerRoute[routeIdx][dayOfWeek].set(stepIndex, result.trafficDeltaSeconds ?? 0);
      for (const code of (result.reasonCodes ?? [])) stepReasonCodesPerRoute[routeIdx][dayOfWeek].add(code);
    });

    // ── Step 6: Build FORECAST# items ────────────────────────────────────────
    const forecastItems = [];

    for (let routeIdx = 0; routeIdx < validRoutes.length; routeIdx++) {
      try {
        const { ref, route } = validRoutes[routeIdx];
        const dayData = routeDayData[routeIdx];
        const days    = {};

        if (route.travelMode === 'TRANSIT' && route.steps?.length > 0) {
          for (const dayOfWeek of ref.daysOfWeek) {
            const { dateStr, hourly, allEvents, allRoadworks, transitRecord,
                    corridorEvents, corridorRoadworks, transitAlerts, holiday, arriveByUtc } = dayData[dayOfWeek];

            const stepDelays      = stepDelaysPerRoute[routeIdx][dayOfWeek];
            const mlReasonCodes   = [...stepReasonCodesPerRoute[routeIdx][dayOfWeek]];
            const totalDeltaSecs  = [...stepDelays.values()].reduce((s, v) => s + v, 0);
            const extraBufferMins = Math.max(0, Math.round(totalDeltaSecs / 60));

            const [arriveHour, arriveMin] = arriveByUtc.split(':').map(Number);
            const arriveByMins = arriveHour * 60 + arriveMin;

            // Run timetable cascade inline — snaps to real scheduled departures and propagates
            // connection constraints backwards. Falls back gracefully per step when no timetable
            // data exists (new lines, data not yet populated). No separate Lambda needed.
            const { departMins, cascadeReasons } = simulateCascadeBackwards(
              route.steps, timetableCache, dayOfWeek, arriveByMins, stepDelays
            );

            const base             = new Date(`${dateStr}T00:00:00Z`);
            const adjustedDepartBy = new Date(base.getTime() + departMins * 60_000)
              .toISOString().replace(/\.\d{3}Z$/, 'Z');

            const reasonParts = buildReasoningFromCodes(
              mlReasonCodes, corridorEvents, corridorRoadworks, transitAlerts, holiday, route.travelMode
            );
            if (holiday) {
              const hasRailStep = route.steps.some(s =>
                RAIL_VEHICLE_TYPES.has(s.transitDetails?.transitLine?.vehicle?.type ?? '')
              );
              if (hasRailStep) reasonParts.push(`Public holiday (${holiday.name}) — verify rail timetables before travel`);
            }

            let reasoning = reasonParts.length > 0
              ? reasonParts.join('. ')
              : 'Normal conditions — no disruptions expected.';

            // Append timetable connection reasons (e.g. "Catch the 08:10 X service")
            if (cascadeReasons.length > 0) {
              const base = reasoning === 'Normal conditions — no disruptions expected.' ? '' : reasoning;
              reasoning  = base ? `${base}. ${cascadeReasons.join('. ')}` : cascadeReasons.join('. ');
            }

            days[dayOfWeek] = {
              forecastDate: dateStr,
              recommendation: { adjustedDepartBy, extraBufferMins, reasoning, mlLo: null, mlHi: null },
              hasWeatherData:   hourly.length > 0,
              hasEventData:     allEvents.length > 0,
              hasRoadworksData: allRoadworks !== null,
              hasTransitData:   transitRecord !== null,
              hasHolidayData:   holiday !== null,
            };

            const corridorSummary  = corridorEvents.map(ev => `${ev.name}(r=${getEventRadius(ev.capacity).toFixed(1)}km)`).join(', ') || 'none';
            const roadworksSummary = corridorRoadworks.map(inc => inc.description || 'unnamed').join(', ') || 'none';
            console.log(`${ref.userId} ${ref.routeId} ${dayOfWeek} [${dateStr}]: arriveBy=${ref.arriveBy} local → ${arriveByUtc} UTC, depart=${adjustedDepartBy}, buffer=${extraBufferMins}mins${cascadeReasons.length > 0 ? ` cascade=[${cascadeReasons.join(', ')}]` : ''}, corridorEvents=[${corridorSummary}], roadworks=[${roadworksSummary}], holiday=${holiday?.name ?? 'none'}`);
          }

        } else {
          for (const dayOfWeek of ref.daysOfWeek) {
            const { dateStr, hourly, allEvents, allRoadworks, transitRecord,
                    corridorEvents, corridorRoadworks, transitAlerts, holiday, arriveByUtc } = dayData[dayOfWeek];

            const mlResult        = dayResultsPerRoute[routeIdx][dayOfWeek] ?? { trafficDeltaSeconds: 0, lo: null, hi: null, reasonCodes: [] };
            const extraBufferMins = Math.max(0, Math.round(mlResult.trafficDeltaSeconds / 60));
            const mlLo            = mlResult.lo  ?? null;
            const mlHi            = mlResult.hi  ?? null;
            const mlReasonCodes   = mlResult.reasonCodes ?? [];

            const [arriveHour, arriveMin] = arriveByUtc.split(':').map(Number);
            const arriveByMins = arriveHour * 60 + arriveMin;
            const departMins   = arriveByMins - route.staticDuration - extraBufferMins;

            const base             = new Date(`${dateStr}T00:00:00Z`);
            const adjustedDepartBy = new Date(base.getTime() + departMins * 60_000)
              .toISOString().replace(/\.\d{3}Z$/, 'Z');

            const reasonParts = buildReasoningFromCodes(
              mlReasonCodes, corridorEvents, corridorRoadworks, transitAlerts, holiday, route.travelMode
            );
            const reasoning = reasonParts.length > 0
              ? reasonParts.join('. ')
              : 'Normal conditions — no disruptions expected.';

            days[dayOfWeek] = {
              forecastDate: dateStr,
              recommendation: { adjustedDepartBy, extraBufferMins, reasoning, mlLo, mlHi },
              hasWeatherData:   hourly.length > 0,
              hasEventData:     allEvents.length > 0,
              hasRoadworksData: allRoadworks !== null,
              hasTransitData:   transitRecord !== null,
              hasHolidayData:   holiday !== null,
            };

            const corridorSummary  = corridorEvents.map(ev => `${ev.name}(r=${getEventRadius(ev.capacity).toFixed(1)}km)`).join(', ') || 'none';
            const roadworksSummary = corridorRoadworks.map(inc => inc.description || 'unnamed').join(', ') || 'none';
            console.log(`${ref.userId} ${ref.routeId} ${dayOfWeek} [${dateStr}]: arriveBy=${ref.arriveBy} local → ${arriveByUtc} UTC, depart=${adjustedDepartBy}, buffer=${extraBufferMins}mins, corridorEvents=[${corridorSummary}], roadworks=[${roadworksSummary}], holiday=${holiday?.name ?? 'none'}`);
          }
        }

        forecastItems.push({
          userId:      ref.userId,
          recordType:  `FORECAST#${ref.routeId}`,
          routeId:     ref.routeId,
          days,
          generatedAt: new Date().toISOString(),
        });

      } catch (err) {
        const { ref } = validRoutes[routeIdx];
        console.error(`Failed to build forecast for userId=${ref.userId} routeId=${ref.routeId} — skipping:`, err);
        skippedRoutes++;
      }
    }

    if (skippedRoutes > 0) {
      console.warn(`Chunk completed with ${skippedRoutes} skipped routes out of ${routeRefs.length}`);
    }

    // ── Step 7: Write all FORECAST# records ──────────────────────────────────
    const forecastRequests = forecastItems.map(item => ({ PutRequest: { Item: marshall(item) } }));
    await batchWrite(client, USER_ROUTE_TABLE, forecastRequests);

    console.log(`delayWorker complete — ${forecastItems.length} forecasts written`);

  } catch (err) {
    console.error('delayWorker error:', err);
    throw err; // Re-throw so SQS retries the message — after maxReceiveCount it goes to DLQ
  }
};
