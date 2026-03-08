// routeCreate — POST /routes/create
// Creates ROUTE# and SCHEDULE# atomically with locationDB update in a single transaction.
// City metadata (city, countryCode) supplied by Android from Google Places SDK per waypoint.
// cityLat/cityLng derived from resolved coordinates returned by the Routes API.
// userId from Cognito token — never from request body.
// Max 20 routes per user enforced before creation.
//
// Phase 2 request contract:
//   origin/destination carry { placeId, label, addressComponents } — no location.latLng from client.
//   addressComponents is the raw Google Places SDK addressComponents array for the selected place.
//   city/countryCode are extracted server-side via extractCityFromComponents, handling locality,
//   postal_town (strips district number e.g. "Dublin 7" → "Dublin"), and admin_area_level_1 fallback.
//   travelMode mirrors Google's travelMode field and values (DRIVE, TRANSIT, WALK, TWO_WHEELER, BICYCLE)
//
// Timezone handling:
//   arriveBy is stored as the user's LOCAL time intent e.g. "08:45" — NOT UTC
//   timezone is the IANA timezone identifier from Android's ZoneId.systemDefault().id e.g. "Europe/Dublin"
//   delayWorker converts arriveBy + timezone → UTC at pipeline execution time for each forecast date
//   This means forecasts are always correct regardless of DST transitions —
//   a user who sets 08:45 always gets a forecast for 08:45 local, winter or summer

const { DynamoDBClient, GetItemCommand, TransactWriteItemsCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { randomUUID } = require('crypto');
const { parseDurationToMinutes, response, getUserId, parseBody, MAX_ROUTES_PER_USER, VALID_DAYS, VALID_TRAVEL_MODES, isValidIANATimezone, computeArrivalUTC, ARRIVE_BY_REGEX, validateWaypoint, validateAddressComponents, extractCityFromComponents, buildCityObject, normaliseWaypoint, computeRoute } = require('/opt/nodejs/utils');

const dynamoClient = new DynamoDBClient({});
const USER_ROUTE_TABLE = process.env.USER_ROUTE_TABLE;
const LOCATION_DB_TABLE = process.env.LOCATION_DB_TABLE;

// ─── Validation ───────────────────────────────────────────────────────────────
// Returns { error: string } on failure, null error on success.
// Phase 2: staticDuration, duration, distanceMeters, geometry removed — computed server-side.
const validateRequest = (body) => {
  const required = ['title', 'origin', 'destination', 'arriveBy', 'timezone', 'daysOfWeek', 'travelMode'];
  const missing = required.filter(f => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length > 0) return { error: `Missing required fields: ${missing.join(', ')}` };

  if (typeof body.title !== 'string') return { error: 'title must be a string' };
  if (body.title.length > 48) return { error: 'title must not exceed 48 characters' };

  const originError = validateWaypoint(body.origin, 'origin');
  if (originError) return { error: originError };
  const originCityError = validateAddressComponents(body.origin, 'origin');
  if (originCityError) return { error: originCityError };

  const destinationError = validateWaypoint(body.destination, 'destination');
  if (destinationError) return { error: destinationError };
  const destinationCityError = validateAddressComponents(body.destination, 'destination');
  if (destinationCityError) return { error: destinationCityError };

  if (body.intermediates) {
    if (!Array.isArray(body.intermediates)) return { error: 'intermediates must be an array' };
    if (body.intermediates.length > 25) return { error: 'Maximum 25 intermediates allowed' }; // matches Google Routes API hard limit
    for (let i = 0; i < body.intermediates.length; i++) {
      const err = validateWaypoint(body.intermediates[i], `intermediates[${i}]`);
      if (err) return { error: err };
    }
  }

  if (!Array.isArray(body.daysOfWeek)) return { error: 'daysOfWeek must be an array' };
  const invalidDays = body.daysOfWeek.filter(d => !VALID_DAYS.includes(d));
  if (invalidDays.length > 0) return { error: `Invalid daysOfWeek: ${invalidDays.join(', ')}` };
  if (new Set(body.daysOfWeek).size !== body.daysOfWeek.length) return { error: 'daysOfWeek must not contain duplicate entries' };

  if (!VALID_TRAVEL_MODES.includes(body.travelMode))
    return { error: `Invalid travelMode: ${body.travelMode}. Must be one of ${VALID_TRAVEL_MODES.join(', ')}` };

  if (!ARRIVE_BY_REGEX.test(body.arriveBy)) return { error: 'arriveBy must be in HH:MM format (local time)' };

  if (!isValidIANATimezone(body.timezone))
    return { error: 'timezone must be a valid IANA timezone identifier e.g. "Europe/Dublin"' };

  return { error: null };
};

// ─── locationDB helper ────────────────────────────────────────────────────────
// subdivisionCode is optional (ISO 3166-2 e.g. "IE-L") — only written when present.
// Transitland feed discovery (transitlandFeedIds, gtfsRtAvailable) is owned entirely
// by transitInitializer, which fires on the locationDB INSERT stream event.
const buildLocationDBTransactItem = (cityKey, city, countryCode, subdivisionCode, cityLat, cityLng, now) => {
  const setFields = [
    'city = :city',
    'countryCode = :cc',
    ...(subdivisionCode ? ['subdivisionCode = :sc'] : []),
    'cityLat = :lat',
    'cityLng = :lng',
    'active = :active',
    'lastActiveAt = :ts',
    'firstRegisteredAt = if_not_exists(firstRegisteredAt, :ts)'
  ];
  const exprValues = {
    ':city': city,
    ':cc': countryCode,
    ...(subdivisionCode ? { ':sc': subdivisionCode } : {}),
    ':lat': cityLat,
    ':lng': cityLng,
    ':active': true,
    ':ts': now,
    ':inc': 1
  };
  return {
    Update: {
      TableName: LOCATION_DB_TABLE,
      Key: marshall({ cityKey }),
      UpdateExpression: `SET ${setFields.join(', ')} ADD activeRouteCount :inc`,
      ExpressionAttributeValues: marshall(exprValues)
    }
  };
};

// ─── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  console.log('routeCreate invoked');

  const userId = getUserId(event);
  if (!userId) return response(401, { error: 'Unauthorised - no valid token' });

  const { body, parseError } = parseBody(event);
  if (parseError) return parseError;

  const validation = validateRequest(body);
  if (validation.error) return response(400, { error: validation.error });

  // ─── Pre-flight limit check ───────────────────────────────────────────────
  // Read routeCount before the expensive Routes API call — avoids a wasted external
  // round-trip when the user is already at the cap. The atomic transaction below is
  // still the authoritative enforcement; this is just an early-exit optimisation.
  try {
    const profileResult = await dynamoClient.send(new GetItemCommand({
      TableName: USER_ROUTE_TABLE,
      Key: marshall({ userId, recordType: 'PROFILE' }),
      ProjectionExpression: 'routeCount'
    }));
    const currentCount = profileResult.Item ? (unmarshall(profileResult.Item).routeCount ?? 0) : 0;
    if (currentCount >= MAX_ROUTES_PER_USER) {
      return response(400, { error: `Maximum of ${MAX_ROUTES_PER_USER} routes allowed per user. Delete an existing route to create a new one.` });
    }
  } catch (err) {
    // Non-fatal — proceed and let the transaction enforce the cap atomically
    console.warn('Pre-flight routeCount check failed, proceeding to transaction:', err.message);
  }

  // ─── Routes API ─────────────────────────────────────────────────────────────
  // Compute the target arrival UTC timestamp from the user's arriveBy intent.
  // Passed to Google Routes API so it returns the correct service at the user's intended time:
  // TRANSIT uses arrivalTime (latest departure meeting the constraint); others use departureTime.
  const targetTimeUTC = computeArrivalUTC(body.arriveBy, body.timezone, body.daysOfWeek);

  const { data: routeData, errorResponse } = await computeRoute(
    body.origin.placeId, body.destination.placeId, body.intermediates || [], body.travelMode, targetTimeUTC
  );
  if (errorResponse) return errorResponse;

  // Extract computed fields from Routes API response
  const staticDuration = parseDurationToMinutes(routeData.staticDuration);
  const trafficDuration = routeData.duration ? parseDurationToMinutes(routeData.duration) : undefined;
  const distanceMeters = routeData.distanceMeters ?? null;
  const geometry = { encodedPolyline: routeData.polyline.encodedPolyline };
  // Steps are only requested and populated for TRANSIT routes.
  // Other modes don't have transitDetails; the route-level polyline covers corridor matching.
  const steps = body.travelMode === 'TRANSIT'
    ? routeData.legs.flatMap(leg => leg.steps || [])
    : [];

  // Resolved coordinates from Routes API legs
  const originLatLng = routeData.legs[0].startLocation.latLng;
  const destinationLatLng = routeData.legs[routeData.legs.length - 1].endLocation.latLng;
  const intermediateLatLngs = routeData.legs.slice(0, -1).map(leg => leg.endLocation.latLng);

  // ─── Build city objects ──────────────────────────────────────────────────────
  const originCityData = extractCityFromComponents(body.origin.addressComponents);
  const cityOrigin = buildCityObject(originCityData.city, originCityData.countryCode, originLatLng.latitude, originLatLng.longitude, originCityData.subdivisionCode);
  const destinationCityData = extractCityFromComponents(body.destination.addressComponents);
  const cityDestination = buildCityObject(destinationCityData.city, destinationCityData.countryCode, destinationLatLng.latitude, destinationLatLng.longitude, destinationCityData.subdivisionCode);

  // Intermediate city names are not available — Android provides city fields for origin/destination only.
  // Intermediate coordinates are stored in the intermediates array via normaliseWaypoint.
  const cityIntermediates = [];

  const routeId = randomUUID();
  const now = new Date().toISOString();

  const routeItem = {
    userId,
    recordType: `ROUTE#${routeId}`,
    routeId,
    title: body.title,
    cityOrigin,
    cityDestination,
    cityIntermediates,
    cityKey: cityDestination.cityKey,
    origin: normaliseWaypoint(body.origin, originLatLng),
    intermediates: (body.intermediates || []).map((w, i) => normaliseWaypoint(w, intermediateLatLngs[i])),
    destination: normaliseWaypoint(body.destination, destinationLatLng),
    // geometry: encodedPolyline from Routes API for map rendering and future ML use.
    // Stored as-is, not consumed by the delay pipeline.
    geometry,
    // steps: flattened across all legs. Used by delayWorker for transit line matching
    // and roadworks corridor matching at step granularity.
    steps,
    travelMode: body.travelMode,
    staticDuration,
    trafficDuration,
    distanceMeters,
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
    updatedAt: now
  };

  // ─── DynamoDB transaction ────────────────────────────────────────────────────
  try {
    await dynamoClient.send(new TransactWriteItemsCommand({
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
        buildLocationDBTransactItem(cityDestination.cityKey, cityDestination.city, cityDestination.countryCode, cityDestination.subdivisionCode, cityDestination.lat, cityDestination.lng, now)
      ]
    }));

    console.log(`Route created: userId=${userId} routeId=${routeId} city=${cityDestination.cityKey} tz=${body.timezone} arriveBy=${body.arriveBy} targetTimeUTC=${targetTimeUTC} staticDuration=${staticDuration}mins`);

    // Return full route shape — Android renders the card immediately without a second fetch
    return response(201, {
      message: 'Route created successfully',
      route: {
        routeId,
        title: routeItem.title,
        cityOrigin: routeItem.cityOrigin,
        cityDestination: routeItem.cityDestination,
        cityIntermediates: routeItem.cityIntermediates,
        userActive: true,
        origin: routeItem.origin,
        intermediates: routeItem.intermediates,
        destination: routeItem.destination,
        geometry: routeItem.geometry,
        steps: routeItem.steps,
        travelMode: routeItem.travelMode,
        staticDuration,
        trafficDuration: trafficDuration ?? null,
        distanceMeters,
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
