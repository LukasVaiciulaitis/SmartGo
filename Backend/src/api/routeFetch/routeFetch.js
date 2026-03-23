// routeFetch — GET /routes/fetch
// Returns all routes, schedules, and forecasts for the authenticated user.
// FORECAST# records are day-keyed (MON/TUE etc.) not date-keyed.
// userId from Cognito token.

const { DynamoDBClient, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { response, getUserId, MAX_ROUTES_PER_USER } = require('/opt/nodejs/utils');

const dynamoClient = new DynamoDBClient({});
const USER_ROUTE_TABLE = process.env.USER_ROUTE_TABLE;

exports.handler = async (event) => {
  console.log('routeFetch invoked');

  const userId = getUserId(event);
  if (!userId) return response(401, { error: 'Unauthorised - no valid token' });

  try {
    // Fetch all records for this user — paginate in case the 1MB page limit is ever reached
    let allItems = [];
    let lastEvaluatedKey = undefined;

    do {
      const result = await dynamoClient.send(new QueryCommand({
        TableName: USER_ROUTE_TABLE,
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: marshall({ ':uid': userId }),
        ExpressionAttributeNames: { '#timezone': 'timezone' },
        // Exclude `steps` — large TRANSIT stop data only needed by delayWorker, not this response
        ProjectionExpression: 'userId, recordType, routeId, title, cityOrigin, cityDestination, cityIntermediates, userActive, origin, intermediates, destination, geometry, travelMode, staticDuration, trafficDuration, distanceMeters, createdAt, updatedAt, arriveBy, #timezone, daysOfWeek, days, generatedAt, email',
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

    // Build lookup maps — O(n) vs O(n²) for the find() calls inside routes.map()
    const scheduleMap = new Map(
      allItems.filter(i => i.recordType.startsWith('SCHEDULE#')).map(s => [s.routeId, s])
    );
    const forecastMap = new Map(
      allItems.filter(i => i.recordType.startsWith('FORECAST#')).map(f => [f.routeId, f])
    );

    // Build response — one entry per route with schedule and forecast attached
    const routeData = routes.map(route => {
      const schedule = scheduleMap.get(route.routeId) || null;
      const forecast = forecastMap.get(route.routeId) || null;

      // forecastStatus communicates forecast state to Android:
      //   active  — forecast present and up to date
      //   pending — route active with days selected but no forecast yet (new route or just updated)
      //   empty   — no days selected, nothing to forecast
      const hasDays = schedule && schedule.daysOfWeek && schedule.daysOfWeek.length > 0;
      const forecastStatus = forecast ? 'active' : hasDays ? 'pending' : 'empty';

      return {
        routeId: route.routeId,
        title: route.title,
        cityOrigin: route.cityOrigin,
        cityDestination: route.cityDestination,
        cityIntermediates: route.cityIntermediates || [],
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
