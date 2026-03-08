// routeDelete — DELETE /routes/delete
// Deactivates SCHEDULE# first (stops nightly processing), then deletes ROUTE# and FORECAST#.
// Decrements activeRouteCount in locationDB atomically with ROUTE# deletion via transaction.
// When activeRouteCount reaches zero, scrapers skip the city (they filter activeRouteCount > 0).
// SCHEDULE# uses TTL for final cleanup — DynamoDB auto-expires within 48 hours.

const { DynamoDBClient, GetItemCommand, DeleteItemCommand, UpdateItemCommand, TransactWriteItemsCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { response, getUserId, parseBody, UUID_REGEX } = require('/opt/nodejs/utils');

const client = new DynamoDBClient({});
const USER_ROUTE_TABLE = process.env.USER_ROUTE_TABLE;
const LOCATION_DB_TABLE = process.env.LOCATION_DB_TABLE;

exports.handler = async (event) => {
  console.log('routeDelete invoked');

  const userId = getUserId(event);
  if (!userId) return response(401, { error: 'Unauthorised - no valid token' });

  const { body, parseError } = parseBody(event);
  if (parseError) return parseError;

  const { routeId } = body;
  if (!routeId) return response(400, { error: 'routeId is required in request body' });
  if (!UUID_REGEX.test(routeId)) return response(400, { error: 'routeId must be a valid UUID' });

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
            ConditionExpression: 'routeCount > :zero',
            ExpressionAttributeValues: marshall({ ':dec': -1, ':zero': 0 })
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
    // TransactionCanceledException — one of the two ConditionExpressions failed.
    // CancellationReasons indices correspond to TransactItems order:
    //   [0] Delete ROUTE#     — no condition, never the cause
    //   [1] Update locationDB — condition: activeRouteCount > 0
    //   [2] Update PROFILE    — condition: routeCount > 0
    if (err.name === 'TransactionCanceledException') {
      const reasons = err.CancellationReasons || [];
      const locationConditionFailed = reasons[1]?.Code === 'ConditionalCheckFailed';
      const profileConditionFailed  = reasons[2]?.Code === 'ConditionalCheckFailed';

      if (locationConditionFailed || profileConditionFailed) {
        // Transaction was cancelled — ROUTE# was not deleted; clean it up explicitly.
        // If this delete fails, surface 500 — the route still exists and cannot be retried
        // without potentially double-decrementing the counters.
        try {
          await client.send(new DeleteItemCommand({
            TableName: USER_ROUTE_TABLE,
            Key: marshall({ userId, recordType: `ROUTE#${routeId}` })
          }));
        } catch (cleanupErr) {
          console.error(`ROUTE# cleanup failed after condition failure: routeId=${routeId}:`, cleanupErr.message);
          return response(500, { error: 'Internal server error' });
        }

        if (locationConditionFailed) {
          // activeRouteCount was already 0 — city already inactive, no locationDB update needed.
          // Transaction rolled back the PROFILE decrement — apply it manually.
          try {
            await client.send(new UpdateItemCommand({
              TableName: USER_ROUTE_TABLE,
              Key: marshall({ userId, recordType: 'PROFILE' }),
              UpdateExpression: 'ADD routeCount :dec',
              ConditionExpression: 'routeCount > :zero',
              ExpressionAttributeValues: marshall({ ':dec': -1, ':zero': 0 })
            }));
          } catch (profileErr) {
            console.warn(`PROFILE routeCount decrement skipped or failed for userId=${userId}:`, profileErr.message);
          }
          console.warn(`activeRouteCount already zero for cityKey=${route?.cityKey} — city already inactive`);
        } else {
          // routeCount was already 0 — data inconsistency (ROUTE# existed but PROFILE counter
          // was at floor). Transaction rolled back the locationDB decrement — apply it manually.
          try {
            await client.send(new UpdateItemCommand({
              TableName: LOCATION_DB_TABLE,
              Key: marshall({ cityKey: route.cityKey }),
              UpdateExpression: 'ADD activeRouteCount :dec SET lastActiveAt = :ts',
              ConditionExpression: 'activeRouteCount > :zero',
              ExpressionAttributeValues: marshall({ ':dec': -1, ':zero': 0, ':ts': new Date().toISOString() })
            }));
          } catch (locationErr) {
            console.warn(`locationDB activeRouteCount decrement failed for cityKey=${route?.cityKey}:`, locationErr.message);
          }
          console.warn(`routeCount floor hit for userId=${userId} — PROFILE counter was 0 while ROUTE# existed (data inconsistency)`);
        }

        return response(200, { message: 'Route deleted successfully', routeId });
      }
    }
    console.error('routeDelete error:', err);
    return response(500, { error: 'Internal server error' });
  }
};
