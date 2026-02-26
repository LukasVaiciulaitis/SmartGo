// routeUpdate — PUT /routes/update
// Updates an existing ROUTE# or SCHEDULE# record.
// routeId must be provided in the body to identify which route to update.
// Supports partial updates on both route and schedule fields.
// Invalidates FORECAST# record when route or schedule fields change —
// prevents stale forecasts being shown until the next nightly batch run.
//
// API contract aligns with Google Maps Routes API:
//   origin/destination use Google's nested { location: { latLng: { latitude, longitude } } }
//   staticDuration mirrors Google's staticDuration field — baseline without traffic, e.g. "1320s"
//   duration maps to trafficDuration internally — Google's traffic-aware duration, optional
//
// Timezone handling:
//   arriveBy is the user's LOCAL time intent — stored as HH:MM, not UTC
//   timezone is the IANA identifier from Android's ZoneId.systemDefault().id
//   Both can be updated independently; updating either invalidates the forecast

const { DynamoDBClient, GetItemCommand, TransactWriteItemsCommand, DeleteItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const { parseDurationToMinutes } = require('/opt/nodejs/utils');

const client = new DynamoDBClient({});
const TABLE = process.env.USER_ROUTE_TABLE;

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

const ROUTE_FIELDS = ['title', 'origin', 'intermediates', 'destination', 'geometry', 'travelMode', 'staticDuration', 'trafficDuration', 'distanceMeters', 'userActive'];
const SCHEDULE_FIELDS = ['arriveBy', 'timezone', 'daysOfWeek'];
// Fields whose values feed directly into the nightly forecast calculation
const FORECAST_AFFECTING_ROUTE_FIELDS = new Set(['origin', 'destination', 'intermediates', 'travelMode', 'staticDuration', 'trafficDuration']);

const buildUpdateExpression = (fields, values) => {
  const parts = fields.map(f => `#${f} = :${f}`);
  parts.push('#updatedAt = :updatedAt');
  const names = fields.reduce((acc, f) => ({ ...acc, [`#${f}`]: f }), { '#updatedAt': 'updatedAt' });
  return { expression: `SET ${parts.join(', ')}`, names, values };
};

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

  // Accept Google's duration field name and remap to trafficDuration for storage
  if (body.duration !== undefined) {
    body.trafficDuration = body.duration;
    delete body.duration;
  }

  const routeFieldsToUpdate = Object.keys(body).filter(k => ROUTE_FIELDS.includes(k));
  const scheduleFieldsToUpdate = Object.keys(body).filter(k => SCHEDULE_FIELDS.includes(k));

  if (routeFieldsToUpdate.length === 0 && scheduleFieldsToUpdate.length === 0) {
    return response(400, {
      error: `No valid fields provided. Route fields: ${ROUTE_FIELDS.map(f => f === 'trafficDuration' ? 'duration' : f).join(', ')}. Schedule fields: ${SCHEDULE_FIELDS.join(', ')}.`
    });
  }

  // Validate title if being updated
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim() === '')
      return response(400, { error: 'title must be a non-empty string' });
    if (body.title.length > 48)
      return response(400, { error: 'title must not exceed 48 characters' });
  }

  // Validate arriveBy format if being updated - stored as LOCAL time intent, not UTC
  if (body.arriveBy !== undefined) {
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(body.arriveBy)) {
      return response(400, { error: 'arriveBy must be in HH:MM format (local time)' });
    }
  }

  // Validate timezone if being updated — must be a valid IANA identifier
  if (body.timezone !== undefined) {
    if (typeof body.timezone !== 'string' || body.timezone.trim() === '' ||
        !/^[A-Za-z]+([/_+-][A-Za-z0-9_+-]+)*$/.test(body.timezone)) {
      return response(400, { error: 'timezone must be a valid IANA timezone identifier e.g. "Europe/Dublin"' });
    }
  }

  // Validate and convert staticDuration if being updated
  if (body.staticDuration !== undefined) {
    const parsed = parseDurationToMinutes(body.staticDuration);
    if (parsed === null || parsed <= 0) {
      return response(400, { error: 'staticDuration must be a positive duration string in Google format e.g. "1200s"' });
    }
    body.staticDuration = parsed;
  }

  // Validate daysOfWeek if being updated — must be an array of valid day strings
  if (body.daysOfWeek !== undefined) {
    if (!Array.isArray(body.daysOfWeek))
      return response(400, { error: 'daysOfWeek must be an array' });
    const validDays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
    const invalidDays = body.daysOfWeek.filter(d => !validDays.includes(d));
    if (invalidDays.length > 0)
      return response(400, { error: `Invalid daysOfWeek: ${invalidDays.join(', ')}` });
  }

  // Validate and convert duration (remapped from Google's duration field to trafficDuration)
  if (body.trafficDuration !== undefined) {
    const parsed = parseDurationToMinutes(body.trafficDuration);
    if (parsed === null || parsed <= 0) {
      return response(400, { error: 'duration must be a positive duration string in Google format e.g. "1320s"' });
    }
    body.trafficDuration = parsed;
  }

  // Validate and normalise origin if being updated — Google nested latLng structure
  if (body.origin !== undefined) {
    const latLng = body.origin?.location?.latLng;
    if (!latLng || typeof latLng.latitude !== 'number' || typeof latLng.longitude !== 'number')
      return response(400, { error: 'origin must include location.latLng with latitude and longitude' });
    if (!body.origin.label || typeof body.origin.label !== 'string' || body.origin.label.trim() === '')
      return response(400, { error: 'origin must include a label' });
    body.origin = {
      location: { latLng: { latitude: latLng.latitude, longitude: latLng.longitude } },
      label: body.origin.label,
      ...(body.origin.placeId ? { placeId: body.origin.placeId } : {})
    };
  }

  // Validate and normalise destination if being updated — Google nested latLng structure
  if (body.destination !== undefined) {
    const latLng = body.destination?.location?.latLng;
    if (!latLng || typeof latLng.latitude !== 'number' || typeof latLng.longitude !== 'number')
      return response(400, { error: 'destination must include location.latLng with latitude and longitude' });
    if (!body.destination.label || typeof body.destination.label !== 'string' || body.destination.label.trim() === '')
      return response(400, { error: 'destination must include a label' });
    body.destination = {
      location: { latLng: { latitude: latLng.latitude, longitude: latLng.longitude } },
      label: body.destination.label,
      ...(body.destination.placeId ? { placeId: body.destination.placeId } : {})
    };
  }

  // Validate and normalise intermediates if being updated — preserve Google's nested latLng structure
  if (body.intermediates !== undefined) {
    if (!Array.isArray(body.intermediates))
      return response(400, { error: 'intermediates must be an array' });
    for (let i = 0; i < body.intermediates.length; i++) {
      const w = body.intermediates[i];
      const latLng = w?.location?.latLng;
      if (!latLng || typeof latLng.latitude !== 'number' || typeof latLng.longitude !== 'number')
        return response(400, { error: `intermediates[${i}] must include location.latLng with latitude and longitude` });
      if (!w.label || typeof w.label !== 'string' || w.label.trim() === '')
        return response(400, { error: `intermediates[${i}] must include a label` });
    }
    body.intermediates = body.intermediates.map(w => ({
      location: {
        latLng: {
          latitude: w.location.latLng.latitude,
          longitude: w.location.latLng.longitude
        }
      },
      ...(w.placeId && { placeId: w.placeId }),
      label: w.label
    }));
  }

  try {
    // Verify route exists for this user
    const existing = await client.send(new GetItemCommand({
      TableName: TABLE,
      Key: marshall({ userId, recordType: `ROUTE#${routeId}` })
    }));

    if (!existing.Item) {
      return response(404, { error: `No route found with routeId: ${routeId}` });
    }

    const updates = [];
    const now = new Date().toISOString();
    const transactItems = [];

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
          ExpressionAttributeValues: marshall(values)
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

    // Commit ROUTE# and SCHEDULE# updates atomically
    await client.send(new TransactWriteItemsCommand({ TransactItems: transactItems }));

    // Invalidate FORECAST# only when fields that feed the calculation have changed.
    // Title, geometry, distanceMeters, and userActive do not affect the forecast.
    const shouldInvalidateForecast =
      routeFieldsToUpdate.some(f => FORECAST_AFFECTING_ROUTE_FIELDS.has(f)) ||
      scheduleFieldsToUpdate.length > 0;

    if (shouldInvalidateForecast) {
      try {
        await client.send(new DeleteItemCommand({
          TableName: TABLE,
          Key: marshall({ userId, recordType: `FORECAST#${routeId}` })
        }));
        console.log(`FORECAST# invalidated for routeId=${routeId}`);
      } catch (err) {
        // Non-fatal - if forecast doesn't exist yet, nothing to invalidate
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
