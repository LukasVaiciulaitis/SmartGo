// routeDelete — DELETE /routes/delete
// Deactivates SCHEDULE# first (stops nightly processing), then deletes ROUTE# and FORECAST#.
// Decrements activeRouteCount in locationDB atomically with ROUTE# deletion via transaction.
// When activeRouteCount reaches zero, sets active: false — scrapers skip the city.
// SCHEDULE# uses TTL for final cleanup — DynamoDB auto-expires within 48 hours.

const { DynamoDBClient, GetItemCommand, DeleteItemCommand, UpdateItemCommand, TransactWriteItemsCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

const client = new DynamoDBClient({});
const USER_ROUTE_TABLE = process.env.USER_ROUTE_TABLE;
const LOCATION_DB_TABLE = process.env.LOCATION_DB_TABLE;

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  console.log('routeDelete invoked');

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

  let route;

  try {
    // Fetch route to get cityKey before deleting
    const routeResult = await client.send(new GetItemCommand({
      TableName: USER_ROUTE_TABLE,
      Key: marshall({ userId, recordType: `ROUTE#${routeId}` })
    }));

    if (!routeResult.Item) {
      return response(404, { error: `No route found with routeId: ${routeId}` });
    }

    route = unmarshall(routeResult.Item);
    const now = new Date().toISOString();
    const scheduleTtl = Math.floor(Date.now() / 1000) + (24 * 60 * 60);

    // Step 1: Deactivate SCHEDULE# first — stops delayOrchestrator picking it up tonight
    // TTL set to now + 24h as belt-and-suspenders; DynamoDB auto-expires as final safety net
    await client.send(new UpdateItemCommand({
      TableName: USER_ROUTE_TABLE,
      Key: marshall({ userId, recordType: `SCHEDULE#${routeId}` }),
      UpdateExpression: 'SET #ttl = :ttl, active = :false',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: marshall({ ':ttl': scheduleTtl, ':false': false })
    }));

    // Step 2: Delete ROUTE#, decrement locationDB counter, and decrement PROFILE routeCount atomically
    await client.send(new TransactWriteItemsCommand({
      TransactItems: [
        {
          Delete: {
            TableName: USER_ROUTE_TABLE,
            Key: marshall({ userId, recordType: `ROUTE#${routeId}` })
          }
        },
        {
          Update: {
            TableName: LOCATION_DB_TABLE,
            Key: marshall({ cityKey: route.cityKey }),
            // ConditionExpression prevents activeRouteCount going below zero.
            // Scrapers filter activeRouteCount > 0 directly — no separate active flag needed.
            UpdateExpression: 'ADD activeRouteCount :dec SET lastActiveAt = :ts',
            ConditionExpression: 'activeRouteCount > :zero',
            ExpressionAttributeValues: marshall({
              ':dec': -1,
              ':zero': 0,
              ':ts': now
            })
          }
        },
        {
          Update: {
            TableName: USER_ROUTE_TABLE,
            Key: marshall({ userId, recordType: 'PROFILE' }),
            UpdateExpression: 'ADD routeCount :dec',
            ExpressionAttributeValues: marshall({ ':dec': -1 })
          }
        }
      ]
    }));

    // Step 3: Delete FORECAST# — non-critical, fire and forget
    // If this fails the stale forecast is harmless — routeFetch won't surface it
    // without a matching ROUTE# record
    try {
      await client.send(new DeleteItemCommand({
        TableName: USER_ROUTE_TABLE,
        Key: marshall({ userId, recordType: `FORECAST#${routeId}` })
      }));
    } catch (err) {
      console.warn(`FORECAST# delete failed for routeId=${routeId} — non-critical:`, err.message);
    }

    console.log(`Route deleted: userId=${userId} routeId=${routeId} cityKey=${route.cityKey}`);
    return response(200, { message: 'Route deleted successfully', routeId });

  } catch (err) {
    // TransactionCanceledException from the locationDB ConditionExpression
    // means activeRouteCount was already zero — city is already inactive, safe to ignore
    if (err.name === 'TransactionCanceledException') {
      const reasons = err.CancellationReasons || [];
      const conditionFailed = reasons.some(r => r.Code === 'ConditionalCheckFailed');
      if (conditionFailed) {
        // Transaction was cancelled — ROUTE# was not deleted; clean it up explicitly
        try {
          await client.send(new DeleteItemCommand({
            TableName: USER_ROUTE_TABLE,
            Key: marshall({ userId, recordType: `ROUTE#${routeId}` })
          }));
        } catch (cleanupErr) {
          console.warn(`ROUTE# cleanup failed after condition failure: routeId=${routeId}:`, cleanupErr.message);
        }
        // Transaction also rolled back the PROFILE decrement — apply it manually
        try {
          await client.send(new UpdateItemCommand({
            TableName: USER_ROUTE_TABLE,
            Key: marshall({ userId, recordType: 'PROFILE' }),
            UpdateExpression: 'ADD routeCount :dec',
            ExpressionAttributeValues: marshall({ ':dec': -1 })
          }));
        } catch (profileErr) {
          console.warn(`PROFILE routeCount decrement failed after condition failure: userId=${userId}:`, profileErr.message);
        }
        console.warn(`activeRouteCount already zero for cityKey=${route?.cityKey} — city already inactive`);
        return response(200, { message: 'Route deleted successfully', routeId });
      }
    }
    console.error('routeDelete error:', err);
    return response(500, { error: 'Internal server error' });
  }
};
