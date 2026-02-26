// routeFetch — GET /routes/fetch
// Returns all routes, schedules, and forecasts for the authenticated user.
// FORECAST# records are day-keyed (MON/TUE etc.) not date-keyed.
// userId from Cognito token.

const { DynamoDBClient, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

const client = new DynamoDBClient({});
const USER_ROUTE_TABLE = process.env.USER_ROUTE_TABLE;
const MAX_ROUTES_PER_USER = 20;

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  console.log('routeFetch invoked');

  const userId = event.requestContext?.authorizer?.claims?.sub;
  if (!userId) return response(401, { error: 'Unauthorised - no valid token' });

  try {
    // Fetch all records for this user — paginate in case the 1MB page limit is ever reached
    let allItems = [];
    let lastEvaluatedKey = undefined;

    do {
      const result = await client.send(new QueryCommand({
        TableName: USER_ROUTE_TABLE,
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: marshall({ ':uid': userId }),
        ExclusiveStartKey: lastEvaluatedKey
      }));

      allItems = allItems.concat((result.Items || []).map(i => unmarshall(i)));
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    const rawProfile = allItems.find(i => i.recordType === 'PROFILE') || null;
    const profile = rawProfile ? {
      email: rawProfile.email,
      createdAt: rawProfile.createdAt
    } : null;
    const routes = allItems.filter(i => i.recordType.startsWith('ROUTE#'));
    const schedules = allItems.filter(i => i.recordType.startsWith('SCHEDULE#'));
    const forecasts = allItems.filter(i => i.recordType.startsWith('FORECAST#'));

    // Build response — one entry per route with schedule and forecast attached
    const routeData = routes.map(route => {
      const schedule = schedules.find(s => s.routeId === route.routeId) || null;
      const forecast = forecasts.find(f => f.routeId === route.routeId) || null;

      // forecastStatus communicates forecast state to Android:
      //   active  — forecast present and up to date
      //   pending — route active with days selected but no forecast yet (new route or just updated)
      //   empty   — no days selected, nothing to forecast
      const hasDays = schedule && schedule.daysOfWeek && schedule.daysOfWeek.length > 0;
      const forecastStatus = forecast ? 'active' : hasDays ? 'pending' : 'empty';

      return {
        routeId: route.routeId,
        title: route.title,
        city: route.city,
        countryCode: route.countryCode,
        userActive: route.userActive ?? true,
        origin: route.origin,
        intermediates: route.intermediates || [],
        destination: route.destination,
        geometry: route.geometry || null,
        travelMode: route.travelMode,
        staticDuration: route.staticDuration,
        trafficDuration: route.trafficDuration ?? null,
        distanceMeters: route.distanceMeters || null,
        createdAt: route.createdAt,
        updatedAt: route.updatedAt,
        schedule: schedule ? {
          arriveBy: schedule.arriveBy,
          timezone: schedule.timezone,
          daysOfWeek: schedule.daysOfWeek,
          updatedAt: schedule.updatedAt
        } : null,
        forecastStatus,
        forecast: forecast ? {
          // Day-keyed recommendations e.g. { MON: {...}, TUE: {...} }
          days: forecast.days || {},
          generatedAt: forecast.generatedAt
        } : null
      };
    });

    const activeRouteCount = routeData.filter(r => r.userActive !== false).length;

    return response(200, {
      userId,
      profile,
      routeCount: routes.length,
      activeRouteCount,
      maxRoutes: MAX_ROUTES_PER_USER,
      routes: routeData
    });

  } catch (err) {
    console.error('routeFetch error:', err);
    return response(500, { error: 'Internal server error' });
  }
};
