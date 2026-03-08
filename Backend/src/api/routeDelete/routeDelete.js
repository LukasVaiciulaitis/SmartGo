// routeDelete — DELETE /routes/delete
// Atomically deletes ROUTE#, deactivates SCHEDULE#, and decrements both counters in one transaction.
// Keeping SCHEDULE# inside the transaction eliminates the previous Step 1 / Step 2 non-atomicity
// gap where SCHEDULE# could be deactivated but ROUTE# left intact on a mid-operation failure.
// When activeRouteCount reaches zero, scrapers skip the city (they filter activeRouteCount > 0).
// SCHEDULE# TTL is set inside the transaction as belt-and-suspenders; DynamoDB auto-expires as
// the final safety net within 48 hours.

const { DynamoDBClient, GetItemCommand, DeleteItemCommand, UpdateItemCommand, TransactWriteItemsCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { response, getUserId, parseBody, UUID_REGEX } = require('/opt/nodejs/utils');

const dynamoClient = new DynamoDBClient({});
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
    const routeResult = await dynamoClient.send(new GetItemCommand({
      TableName: USER_ROUTE_TABLE,
      Key: marshall({ userId, recordType: `ROUTE#${routeId}` })
    }));

    if (!routeResult.Item) {
      return response(404, { error: `No route found with routeId: ${routeId}` });
    }

    route = unmarshall(routeResult.Item);
    const now = new Date().toISOString();
    const scheduleTtl = Math.floor(Date.now() / 1000) + (24 * 60 * 60);

    // Single atomic transaction: delete ROUTE#, deactivate SCHEDULE#, and decrement both counters.
    // SCHEDULE# deactivation is inside the transaction — if the transaction rolls back (condition
    // failure), SCHEDULE# remains active and the route is left in a consistent state for retry.
    await dynamoClient.send(new TransactWriteItemsCommand({
      TransactItems: [
        {
          Delete: {
            TableName: USER_ROUTE_TABLE,
            Key: marshall({ userId, recordType: `ROUTE#${routeId}` })
          }
        },
        {
          // Deactivate SCHEDULE# — stops delayOrchestrator picking it up tonight.
          // TTL set as belt-and-suspenders; DynamoDB auto-expires as final safety net.
          Update: {
            TableName: USER_ROUTE_TABLE,
            Key: marshall({ userId, recordType: `SCHEDULE#${routeId}` }),
            UpdateExpression: 'SET #ttl = :ttl, active = :false',
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: marshall({ ':ttl': scheduleTtl, ':false': false })
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
            ExpressionAttributeValues: marshall({ ':dec': -1, ':zero': 0, ':ts': now })
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

    // Delete FORECAST# — non-critical, fire and forget
    // If this fails the stale forecast is harmless — routeFetch won't surface it
    // without a matching ROUTE# record
    try {
      await dynamoClient.send(new DeleteItemCommand({
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
    // The whole transaction rolled back: ROUTE#, SCHEDULE#, and both counters are unchanged.
    // CancellationReasons indices correspond to TransactItems order:
    //   [0] Delete ROUTE#     — no condition, never the cause
    //   [1] Update SCHEDULE#  — no condition, never the cause
    //   [2] Update locationDB — condition: activeRouteCount > 0
    //   [3] Update PROFILE    — condition: routeCount > 0
    if (err.name === 'TransactionCanceledException') {
      const reasons = err.CancellationReasons || [];
      const locationConditionFailed = reasons[2]?.Code === 'ConditionalCheckFailed';
      const profileConditionFailed  = reasons[3]?.Code === 'ConditionalCheckFailed';

      if (locationConditionFailed || profileConditionFailed) {
        // Transaction rolled back — ROUTE# and SCHEDULE# were not modified.
        // Delete ROUTE# and deactivate SCHEDULE# individually to complete the route removal.
        // Note: the compensating ops below are themselves non-atomic — if PROFILE decrement
        // fails after ROUTE# is deleted, routeCount will be permanently off by one. This is
        // an accepted limitation: it only occurs on a pre-existing counter inconsistency
        // (ROUTE# existed while the counter was already at its floor), which should not
        // arise under normal operation.
        const scheduleTtl = Math.floor(Date.now() / 1000) + (24 * 60 * 60);

        try {
          await dynamoClient.send(new DeleteItemCommand({
            TableName: USER_ROUTE_TABLE,
            Key: marshall({ userId, recordType: `ROUTE#${routeId}` })
          }));
        } catch (cleanupErr) {
          console.error(`ROUTE# cleanup failed after condition failure: routeId=${routeId}:`, cleanupErr.message);
          return response(500, { error: 'Internal server error' });
        }

        try {
          await dynamoClient.send(new UpdateItemCommand({
            TableName: USER_ROUTE_TABLE,
            Key: marshall({ userId, recordType: `SCHEDULE#${routeId}` }),
            UpdateExpression: 'SET #ttl = :ttl, active = :false',
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: marshall({ ':ttl': scheduleTtl, ':false': false })
          }));
        } catch (scheduleErr) {
          console.warn(`SCHEDULE# deactivation failed after condition failure for routeId=${routeId}:`, scheduleErr.message);
        }

        if (locationConditionFailed) {
          // activeRouteCount was already 0 — city already inactive, no locationDB update needed.
          // Apply PROFILE decrement separately since the transaction rolled it back.
          try {
            await dynamoClient.send(new UpdateItemCommand({
              TableName: USER_ROUTE_TABLE,
              Key: marshall({ userId, recordType: 'PROFILE' }),
              UpdateExpression: 'ADD routeCount :dec',
              ConditionExpression: 'routeCount > :zero',
              ExpressionAttributeValues: marshall({ ':dec': -1, ':zero': 0 })
            }));
          } catch (profileErr) {
            // Failure here leaves routeCount off by one — log as error for visibility.
            console.error(`PROFILE routeCount decrement failed for userId=${userId} — counter is now off by one:`, profileErr.message);
          }
          console.warn(`activeRouteCount already zero for cityKey=${route?.cityKey} — city already inactive`);
        } else {
          // routeCount was already 0 — data inconsistency (ROUTE# existed but PROFILE counter
          // was at floor). Apply locationDB decrement separately since the transaction rolled it back.
          try {
            await dynamoClient.send(new UpdateItemCommand({
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
