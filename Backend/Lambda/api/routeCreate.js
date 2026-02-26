// routeCreate — POST /routes/create
// Creates ROUTE# and SCHEDULE# atomically with locationDB update in a single transaction.
// City metadata (city, countryCode) supplied by Android from Google Places SDK.
// cityLat/cityLng derived from origin coordinates — sufficient for city-level scraping.
// userId from Cognito token — never from request body.
// Max 20 routes per user enforced before creation.
//
// Request contract mirrors Google Maps Routes API structures to minimise Android-side mapping:
//   origin/destination use Google's nested { location: { latLng: { latitude, longitude } } }
//   intermediates mirrors Google's intermediates array (same name and structure)
//   travelMode mirrors Google's travelMode field and values (DRIVE, TRANSIT, WALK, TWO_WHEELER, BICYCLE)
//   distanceMeters mirrors Google's distanceMeters field name
//   staticDuration mirrors Google's staticDuration field — baseline without traffic, e.g. "1320s" or plain integer seconds
//   duration maps to trafficDuration internally — Google's traffic-aware duration, e.g. "1440s" — optional (omit for WALK/TRANSIT where values are identical)
//   geometry accepts a scoped subset of Google's route response — encodedPolyline + legs
//
// Timezone handling:
//   arriveBy is stored as the user's LOCAL time intent e.g. "08:45" — NOT UTC
//   timezone is the IANA timezone identifier from Android's ZoneId.systemDefault().id e.g. "Europe/Dublin"
//   delayWorker converts arriveBy + timezone → UTC at pipeline execution time for each forecast date
//   This means forecasts are always correct regardless of DST transitions —
//   a user who sets 08:45 always gets a forecast for 08:45 local, winter or summer

const { DynamoDBClient, TransactWriteItemsCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const { randomUUID } = require('crypto');
const { parseDurationToMinutes } = require('/opt/nodejs/utils');

const client = new DynamoDBClient({});
const USER_ROUTE_TABLE = process.env.USER_ROUTE_TABLE;
const LOCATION_DB_TABLE = process.env.LOCATION_DB_TABLE;
const MAX_ROUTES_PER_USER = 20;

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

// Validate a waypoint using Google's nested location structure
// { location: { latLng: { latitude, longitude } }, label, placeId? }
const validateWaypoint = (waypoint, name) => {
  if (!waypoint || typeof waypoint !== 'object')
    return `${name} is required`;

  const latLng = waypoint?.location?.latLng;
  if (!latLng)
    return `${name} must include location.latLng`;
  if (typeof latLng.latitude !== 'number' || typeof latLng.longitude !== 'number')
    return `${name}.location.latLng latitude and longitude must be numbers`;
  if (!waypoint.label || typeof waypoint.label !== 'string' || waypoint.label.trim() === '')
    return `${name} must include a label`;

  return null;
};

// Basic IANA timezone format check — e.g. "Europe/Dublin", "America/New_York", "UTC"
// Full validation happens implicitly in delayWorker when the timezone is used for conversion
const isValidIANATimezone = (tz) => {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  // IANA identifiers are Region/City or fixed UTC offsets — reject obviously malformed values
  return /^[A-Za-z]+([/_+-][A-Za-z0-9_+-]+)*$/.test(tz);
};

// Returns { error: string } on failure, or { error: null, staticDuration, trafficDuration } on success.
// Parsed duration values are returned directly to avoid re-parsing in the handler.
const validateRequest = (body) => {
  const required = ['title', 'origin', 'destination', 'arriveBy', 'timezone', 'daysOfWeek', 'travelMode', 'staticDuration', 'city', 'countryCode'];
  const missing = required.filter(f => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length > 0) return { error: `Missing required fields: ${missing.join(', ')}` };

  if (body.title.length > 48) return { error: 'title must not exceed 48 characters' };

  const originError = validateWaypoint(body.origin, 'origin');
  if (originError) return { error: originError };

  const destinationError = validateWaypoint(body.destination, 'destination');
  if (destinationError) return { error: destinationError };

  if (body.intermediates) {
    if (!Array.isArray(body.intermediates)) return { error: 'intermediates must be an array' };
    for (let i = 0; i < body.intermediates.length; i++) {
      const err = validateWaypoint(body.intermediates[i], `intermediates[${i}]`);
      if (err) return { error: err };
    }
  }

  const validDays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  if (!Array.isArray(body.daysOfWeek)) return { error: 'daysOfWeek must be an array' };
  const invalidDays = body.daysOfWeek.filter(d => !validDays.includes(d));
  if (invalidDays.length > 0) return { error: `Invalid daysOfWeek: ${invalidDays.join(', ')}` };

  const validModes = ['DRIVE', 'TRANSIT', 'WALK', 'TWO_WHEELER', 'BICYCLE'];
  if (!validModes.includes(body.travelMode))
    return { error: `Invalid travelMode: ${body.travelMode}. Must be one of ${validModes.join(', ')}` };

  const staticDuration = parseDurationToMinutes(body.staticDuration);
  if (staticDuration === null || staticDuration <= 0)
    return { error: 'staticDuration must be a positive duration e.g. "1320s" or integer seconds' };

  let trafficDuration;
  if (body.duration !== undefined) {
    trafficDuration = parseDurationToMinutes(body.duration);
    if (trafficDuration === null || trafficDuration <= 0)
      return { error: 'duration must be a positive duration e.g. "1320s" or integer seconds' };
  }

  // arriveBy is the user's LOCAL time intent — HH:MM in their timezone, not UTC
  const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!timeRegex.test(body.arriveBy)) return { error: 'arriveBy must be in HH:MM format (local time)' };

  if (!isValidIANATimezone(body.timezone))
    return { error: 'timezone must be a valid IANA timezone identifier e.g. "Europe/Dublin"' };

  if (typeof body.city !== 'string' || body.city.trim() === '')
    return { error: 'city must be a non-empty string' };
  if (typeof body.countryCode !== 'string' || body.countryCode.trim() === '')
    return { error: 'countryCode must be a non-empty string' };

  return { error: null, staticDuration, trafficDuration };
};

// Normalise a waypoint for storage — preserve Google's latLng structure, add label and placeId
const normaliseWaypoint = (w) => ({
  location: {
    latLng: {
      latitude: w.location.latLng.latitude,
      longitude: w.location.latLng.longitude
    }
  },
  label: w.label,
  ...(w.placeId ? { placeId: w.placeId } : {})
});

// Build the locationDB Update transact item — atomic with ROUTE# and SCHEDULE# writes.
// activeRouteCount incremented via ADD — no separate call, no drift.
// cityLat/cityLng are origin coordinates — sufficient for city-level weather/event scraping.
const buildLocationDBTransactItem = (cityKey, city, countryCode, cityLat, cityLng) => ({
  Update: {
    TableName: LOCATION_DB_TABLE,
    Key: marshall({ cityKey }),
    UpdateExpression: `
      SET city = :city,
          countryCode = :cc,
          cityLat = :lat,
          cityLng = :lng,
          active = :active,
          lastActiveAt = :ts,
          firstRegisteredAt = if_not_exists(firstRegisteredAt, :ts)
      ADD activeRouteCount :inc
    `,
    ExpressionAttributeValues: marshall({
      ':city': city,
      ':cc': countryCode,
      ':lat': cityLat,
      ':lng': cityLng,
      ':active': true,
      ':ts': new Date().toISOString(),
      ':inc': 1
    })
  }
});

exports.handler = async (event) => {
  console.log('routeCreate invoked');

  const userId = event.requestContext?.authorizer?.claims?.sub;
  if (!userId) return response(401, { error: 'Unauthorised - no valid token' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return response(400, { error: 'Invalid JSON in request body' });
  }

  const validation = validateRequest(body);
  if (validation.error) return response(400, { error: validation.error });
  const { staticDuration, trafficDuration } = validation;

  // City metadata from Android Places SDK — normalised for consistent cityKey format
  const city = body.city.trim().toUpperCase().replace(/\s+/g, '_');
  const countryCode = body.countryCode.trim().toUpperCase();
  const cityKey = `${countryCode}#${city}`;

  // Origin coordinates used as city centroid — no reverse geocoding needed
  const cityLat = body.origin.location.latLng.latitude;
  const cityLng = body.origin.location.latLng.longitude;

  const routeId = randomUUID();
  const now = new Date().toISOString();
  const scheduleTtl = Math.floor(Date.now() / 1000) + (14 * 24 * 60 * 60);

  const routeItem = {
    userId,
    recordType: `ROUTE#${routeId}`,
    routeId,
    title: body.title,
    city,
    countryCode,
    cityKey,
    cityLat,
    cityLng,
    origin: normaliseWaypoint(body.origin),
    intermediates: (body.intermediates || []).map(normaliseWaypoint),
    destination: normaliseWaypoint(body.destination),
    // geometry stores a scoped subset of Google's route response for map rendering and future ML:
    // { encodedPolyline: string, legs: [...] }
    // Stored as-is from Android, not consumed by the pipeline.
    geometry: body.geometry || null,
    travelMode: body.travelMode,
    staticDuration,
    trafficDuration,
    distanceMeters: body.distanceMeters || null,
    userActive: true,
    createdAt: now,
    updatedAt: now
  };

  const scheduleItem = {
    userId,
    recordType: `SCHEDULE#${routeId}`,
    routeId,
    // arriveBy is stored as LOCAL time intent e.g. "08:45" — not UTC
    // delayWorker converts to UTC using timezone at pipeline execution time
    arriveBy: body.arriveBy,
    // IANA timezone identifier from Android's ZoneId.systemDefault().id
    // Stored here so delayWorker always uses the timezone active when the route was created/updated
    timezone: body.timezone,
    daysOfWeek: body.daysOfWeek,
    updatedAt: now,
    ttl: scheduleTtl
  };

  try {
    await client.send(new TransactWriteItemsCommand({
      TransactItems: [
        // Item 0: atomically increment routeCount on PROFILE, enforcing the cap.
        // ConditionExpression is checked and ADD applied in a single atomic operation —
        // no TOCTOU gap between the count check and the write.
        // attribute_not_exists branch handles PROFILE records written before this counter was added.
        {
          Update: {
            TableName: USER_ROUTE_TABLE,
            Key: marshall({ userId, recordType: 'PROFILE' }),
            UpdateExpression: 'ADD routeCount :one',
            ConditionExpression: 'attribute_not_exists(routeCount) OR routeCount < :max',
            ExpressionAttributeValues: marshall({ ':one': 1, ':max': MAX_ROUTES_PER_USER })
          }
        },
        { Put: { TableName: USER_ROUTE_TABLE, Item: marshall(routeItem, { removeUndefinedValues: true }) } },
        { Put: { TableName: USER_ROUTE_TABLE, Item: marshall(scheduleItem) } },
        buildLocationDBTransactItem(cityKey, city, countryCode, cityLat, cityLng)
      ]
    }));

    console.log(`Route created: userId=${userId} routeId=${routeId} city=${cityKey} tz=${body.timezone} arriveBy=${body.arriveBy} staticDuration=${staticDuration}mins`);

    // Return full route shape — Android renders the card immediately without a second fetch
    return response(201, {
      message: 'Route created successfully',
      route: {
        routeId,
        title: routeItem.title,
        city,
        countryCode,
        userActive: true,
        origin: routeItem.origin,
        intermediates: routeItem.intermediates,
        destination: routeItem.destination,
        geometry: routeItem.geometry,
        travelMode: routeItem.travelMode,
        staticDuration,
        trafficDuration: trafficDuration ?? null,
        distanceMeters: routeItem.distanceMeters,
        createdAt: now,
        updatedAt: now,
        schedule: {
          arriveBy: body.arriveBy,
          timezone: body.timezone,
          daysOfWeek: body.daysOfWeek,
          updatedAt: now
        },
        forecastStatus: body.daysOfWeek.length > 0 ? 'pending' : 'empty',
        forecast: null
      }
    });

  } catch (err) {
    if (err.name === 'TransactionCanceledException') {
      const reasons = err.CancellationReasons || [];
      // Index 0 is the PROFILE Update — condition fails when routeCount >= MAX_ROUTES_PER_USER
      if (reasons[0]?.Code === 'ConditionalCheckFailed') {
        return response(400, {
          error: `Maximum of ${MAX_ROUTES_PER_USER} routes allowed per user. Delete an existing route to create a new one.`
        });
      }
    }
    console.error('routeCreate error:', err);
    return response(500, { error: 'Internal server error' });
  }
};
