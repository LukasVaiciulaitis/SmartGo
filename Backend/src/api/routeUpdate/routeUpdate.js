// routeUpdate — PUT /routes/update
// Updates an existing ROUTE# or SCHEDULE# record.
// routeId must be provided in the body to identify which route to update.
// Supports partial updates on route and schedule fields.
// Invalidates FORECAST# record when route or schedule fields change —
// prevents stale forecasts being shown until the next nightly batch run.
//
// Phase 2 API contract:
//   origin/destination carry { placeId, label, city, countryCode } — no location.latLng from client.
//   staticDuration, trafficDuration, distanceMeters, geometry are computed server-side
//   and are NOT accepted from the client. They are recalculated whenever a path field
//   (origin, destination, intermediates, travelMode) changes.
//
// Timezone handling:
//   arriveBy is the user's LOCAL time intent — stored as HH:MM, not UTC
//   timezone is the IANA identifier from Android's ZoneId.systemDefault().id
//   Both can be updated independently; updating either invalidates the forecast

const { DynamoDBClient, GetItemCommand, BatchGetItemCommand, TransactWriteItemsCommand, DeleteItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { parseDurationToMinutes, callWithRetry, response, VALID_DAYS, VALID_TRAVEL_MODES, isValidIANATimezone, computeArrivalUTC, validateWaypoint, validateAddressComponents, extractCityFromComponents, buildCityObject, normaliseWaypoint, UUID_REGEX, getRoutesApiKey, callRoutesApi } = require('/opt/nodejs/utils');

const dynamoClient = new DynamoDBClient({});
const TABLE = process.env.USER_ROUTE_TABLE;

// ─── Field lists ──────────────────────────────────────────────────────────────
// staticDuration, trafficDuration, distanceMeters, geometry are excluded —
// they are computed server-side when path fields change, not accepted from the client.
const ROUTE_FIELDS = ['title', 'origin', 'intermediates', 'destination', 'travelMode', 'userActive'];
const SCHEDULE_FIELDS = ['arriveBy', 'timezone', 'daysOfWeek'];

// Changing any of these triggers a Routes API call to recompute route geometry and durations.
const PATH_FIELDS = new Set(['origin', 'destination', 'intermediates', 'travelMode']);

// Fields whose values feed directly into the nightly forecast calculation.
const FORECAST_AFFECTING_ROUTE_FIELDS = new Set(['origin', 'destination', 'intermediates', 'travelMode']);

const buildUpdateExpression = (fields, values) => {
  const parts = fields.map(f => `#${f} = :${f}`);
  parts.push('#updatedAt = :updatedAt');
  const names = fields.reduce((acc, f) => ({ ...acc, [`#${f}`]: f }), { '#updatedAt': 'updatedAt' });
  return { expression: `SET ${parts.join(', ')}`, names, values };
};

// ─── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  console.log('routeUpdate invoked');

  const userId = event.requestContext?.authorizer?.claims?.sub;
  if (!userId) return response(401, { error: 'Unauthorised - no valid token' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return response(400, { error: 'Invalid JSON in request body' });
  }

  const { routeId } = body;
  if (!routeId) return response(400, { error: 'routeId is required in request body' });
  if (!UUID_REGEX.test(routeId)) return response(400, { error: 'routeId must be a valid UUID' });

  let routeFieldsToUpdate = Object.keys(body).filter(k => ROUTE_FIELDS.includes(k));
  const scheduleFieldsToUpdate = Object.keys(body).filter(k => SCHEDULE_FIELDS.includes(k));

  if (routeFieldsToUpdate.length === 0 && scheduleFieldsToUpdate.length === 0) {
    return response(400, {
      error: `No valid fields provided. Route fields: ${ROUTE_FIELDS.join(', ')}. Schedule fields: ${SCHEDULE_FIELDS.join(', ')}.`
    });
  }

  const needsRoutesApiCall = routeFieldsToUpdate.some(f => PATH_FIELDS.has(f));

  // ─── Validate client-supplied fields ─────────────────────────────────────────
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim() === '')
      return response(400, { error: 'title must be a non-empty string' });
    if (body.title.length > 48)
      return response(400, { error: 'title must not exceed 48 characters' });
  }

  if (body.arriveBy !== undefined) {
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(body.arriveBy))
      return response(400, { error: 'arriveBy must be in HH:MM format (local time)' });
  }

  if (body.timezone !== undefined) {
    if (!isValidIANATimezone(body.timezone))
      return response(400, { error: 'timezone must be a valid IANA timezone identifier e.g. "Europe/Dublin"' });
  }

  if (body.daysOfWeek !== undefined) {
    if (!Array.isArray(body.daysOfWeek))
      return response(400, { error: 'daysOfWeek must be an array' });
    const invalidDays = body.daysOfWeek.filter(d => !VALID_DAYS.includes(d));
    if (invalidDays.length > 0)
      return response(400, { error: `Invalid daysOfWeek: ${invalidDays.join(', ')}` });
  }

  if (body.travelMode !== undefined) {
    if (!VALID_TRAVEL_MODES.includes(body.travelMode))
      return response(400, { error: `Invalid travelMode: ${body.travelMode}. Must be one of ${VALID_TRAVEL_MODES.join(', ')}` });
  }

  // Validate Phase 2 waypoint format: { placeId, label, addressComponents }
  if (body.origin !== undefined) {
    const err = validateWaypoint(body.origin, 'origin');
    if (err) return response(400, { error: err });
    const cityErr = validateAddressComponents(body.origin, 'origin');
    if (cityErr) return response(400, { error: cityErr });
  }

  if (body.destination !== undefined) {
    const err = validateWaypoint(body.destination, 'destination');
    if (err) return response(400, { error: err });
    const cityErr = validateAddressComponents(body.destination, 'destination');
    if (cityErr) return response(400, { error: cityErr });
  }

  if (body.intermediates !== undefined) {
    if (!Array.isArray(body.intermediates))
      return response(400, { error: 'intermediates must be an array' });
    for (let i = 0; i < body.intermediates.length; i++) {
      const err = validateWaypoint(body.intermediates[i], `intermediates[${i}]`);
      if (err) return response(400, { error: err });
    }
  }

  try {
    // Verify route exists — when path fields change, batch-fetch ROUTE# and SCHEDULE# together
    // to save a round-trip over the two separate GetItem calls that would otherwise be needed.
    let stored, storedSchedule = {};

    if (needsRoutesApiCall) {
      const { Responses } = await dynamoClient.send(new BatchGetItemCommand({
        RequestItems: {
          [TABLE]: {
            Keys: [
              marshall({ userId, recordType: `ROUTE#${routeId}` }),
              marshall({ userId, recordType: `SCHEDULE#${routeId}` })
            ]
          }
        }
      }));
      const items = (Responses?.[TABLE] || []).map(i => unmarshall(i));
      stored = items.find(i => i.recordType === `ROUTE#${routeId}`) ?? null;
      storedSchedule = items.find(i => i.recordType === `SCHEDULE#${routeId}`) ?? {};
    } else {
      const result = await dynamoClient.send(new GetItemCommand({
        TableName: TABLE,
        Key: marshall({ userId, recordType: `ROUTE#${routeId}` })
      }));
      stored = result.Item ? unmarshall(result.Item) : null;
    }

    if (!stored) {
      return response(404, { error: `No route found with routeId: ${routeId}` });
    }

    // ─── Routes API call (conditional) ─────────────────────────────────────────
    // Required whenever path-affecting fields change — origin, destination, intermediates, travelMode.
    // Uses the incoming value when provided, falls back to the stored value otherwise.
    if (needsRoutesApiCall) {
      const originPlaceId = body.origin?.placeId ?? stored.origin.placeId;
      const destPlaceId = body.destination?.placeId ?? stored.destination.placeId;
      const effectiveIntermediates = body.intermediates ?? stored.intermediates ?? [];
      const effectiveTravelMode = body.travelMode ?? stored.travelMode;

      const effectiveArriveBy = body.arriveBy ?? storedSchedule.arriveBy;
      const effectiveTimezone = body.timezone ?? storedSchedule.timezone;
      const effectiveDaysOfWeek = body.daysOfWeek ?? storedSchedule.daysOfWeek;
      const targetTimeUTC = (effectiveArriveBy && effectiveTimezone && effectiveDaysOfWeek?.length)
        ? computeArrivalUTC(effectiveArriveBy, effectiveTimezone, effectiveDaysOfWeek)
        : null;

      let apiKey;
      try {
        apiKey = await getRoutesApiKey();
      } catch (err) {
        console.error('Failed to fetch Routes API key from SSM:', err);
        return response(500, { error: 'Internal server error' });
      }

      let routeData;
      try {
        routeData = await callWithRetry(
          () => callRoutesApi(originPlaceId, destPlaceId, effectiveIntermediates, effectiveTravelMode, apiKey, targetTimeUTC),
          3,
          500
        );
      } catch (err) {
        console.error('Routes API call failed:', err);
        if (err.retryable === false && (err.status === 400 || err.status === 404)) {
          return response(422, { error: 'Could not compute a route for the given waypoints. Check that the locations are valid and a route exists for the selected travel mode.' });
        }
        return response(503, { error: 'Route computation service unavailable. Please try again.' });
      }

      // Resolved coordinates from Routes API legs
      const originLatLng = routeData.legs[0].startLocation.latLng;
      const destinationLatLng = routeData.legs[routeData.legs.length - 1].endLocation.latLng;
      const intermediateLatLngs = routeData.legs.slice(0, -1).map(leg => leg.endLocation.latLng);

      // Normalise waypoints and build city objects — only for fields being updated
      if (body.origin !== undefined) {
        const originCityData = extractCityFromComponents(body.origin.addressComponents);
        body.origin = normaliseWaypoint(body.origin, originLatLng);
        body.cityOrigin = buildCityObject(originCityData.city, originCityData.countryCode, originLatLng.latitude, originLatLng.longitude, originCityData.subdivisionCode);
        routeFieldsToUpdate.push('cityOrigin');
      }
      if (body.destination !== undefined) {
        const destinationCityData = extractCityFromComponents(body.destination.addressComponents);
        body.destination = normaliseWaypoint(body.destination, destinationLatLng);
        body.cityDestination = buildCityObject(destinationCityData.city, destinationCityData.countryCode, destinationLatLng.latitude, destinationLatLng.longitude, destinationCityData.subdivisionCode);
        body.cityKey = body.cityDestination.cityKey;
        routeFieldsToUpdate.push('cityDestination', 'cityKey');
      }
      if (body.intermediates !== undefined) {
        body.intermediates = body.intermediates.map((w, i) => normaliseWaypoint(w, intermediateLatLngs[i]));
        // Intermediate city names are not available — Android provides city fields for origin/destination only.
        body.cityIntermediates = [];
        routeFieldsToUpdate.push('cityIntermediates');
      }

      // Merge computed fields into the update — always overwrite when path changes
      body.staticDuration = parseDurationToMinutes(routeData.staticDuration);
      body.trafficDuration = routeData.duration ? parseDurationToMinutes(routeData.duration) : null;
      body.distanceMeters = routeData.distanceMeters ?? null;
      body.geometry = { encodedPolyline: routeData.polyline.encodedPolyline };
      // Steps only populated for TRANSIT — other modes don't have transitDetails.
      body.steps = effectiveTravelMode === 'TRANSIT'
        ? routeData.legs.flatMap(leg => leg.steps || [])
        : [];
      routeFieldsToUpdate.push('staticDuration', 'trafficDuration', 'distanceMeters', 'geometry', 'steps');
    }

    const now = new Date().toISOString();
    const transactItems = [];
    const updates = [];

    // Build ROUTE# update if route fields provided
    if (routeFieldsToUpdate.length > 0) {
      const routeValues = routeFieldsToUpdate.reduce((acc, f) => ({ ...acc, [`:${f}`]: body[f] }), { ':updatedAt': now });
      const { expression, names, values } = buildUpdateExpression(routeFieldsToUpdate, routeValues);
      transactItems.push({
        Update: {
          TableName: TABLE,
          Key: marshall({ userId, recordType: `ROUTE#${routeId}` }),
          UpdateExpression: expression,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true })
        }
      });
      updates.push(`route fields: ${routeFieldsToUpdate.join(', ')}`);
    }

    // Build SCHEDULE# update if schedule fields provided
    if (scheduleFieldsToUpdate.length > 0) {
      const scheduleValues = scheduleFieldsToUpdate.reduce((acc, f) => ({ ...acc, [`:${f}`]: body[f] }), { ':updatedAt': now });
      const { expression, names, values } = buildUpdateExpression(scheduleFieldsToUpdate, scheduleValues);
      transactItems.push({
        Update: {
          TableName: TABLE,
          Key: marshall({ userId, recordType: `SCHEDULE#${routeId}` }),
          UpdateExpression: expression,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: marshall(values)
        }
      });
      updates.push(`schedule fields: ${scheduleFieldsToUpdate.join(', ')}`);
    }

    await dynamoClient.send(new TransactWriteItemsCommand({ TransactItems: transactItems }));

    // Invalidate FORECAST# when path-affecting route fields or any schedule fields change.
    // title and userActive updates do NOT invalidate — they don't affect route geometry or timing.
    // arriveBy/timezone/daysOfWeek affect when the forecast fires, so schedule changes always invalidate.
    const shouldInvalidateForecast =
      routeFieldsToUpdate.some(f => FORECAST_AFFECTING_ROUTE_FIELDS.has(f)) ||
      scheduleFieldsToUpdate.length > 0;

    if (shouldInvalidateForecast) {
      try {
        await dynamoClient.send(new DeleteItemCommand({
          TableName: TABLE,
          Key: marshall({ userId, recordType: `FORECAST#${routeId}` })
        }));
        console.log(`FORECAST# invalidated for routeId=${routeId}`);
      } catch (err) {
        // Non-fatal — if forecast doesn't exist yet, nothing to invalidate
        console.warn(`FORECAST# invalidation skipped for routeId=${routeId}:`, err.message);
      }
    }

    console.log(`Route updated: userId=${userId} routeId=${routeId} updates=${updates.join(' | ')}`);
    return response(200, { message: 'Route updated successfully', routeId, updates });

  } catch (err) {
    console.error('routeUpdate error:', err);
    return response(500, { error: 'Internal server error' });
  }
};
