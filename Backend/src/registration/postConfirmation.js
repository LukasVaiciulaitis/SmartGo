// postConfirmation — Cognito post-confirmation trigger
// Fires once, synchronously, after a user successfully verifies their email.
// Writes a PROFILE record to userRouteDB.
// Throwing causes Cognito to surface a registration failure to the app — user must retry.
// userId is the Cognito sub (UUID) — stable, never changes, used as PK throughout the system.

const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');

const client = new DynamoDBClient({});
const USER_ROUTE_TABLE = process.env.USER_ROUTE_TABLE;

exports.handler = async (event) => {
  console.log('postConfirmation invoked', JSON.stringify(event));

  // Cognito passes the user's sub and email in the request
  const userId = event.request?.userAttributes?.sub;
  const email = event.request?.userAttributes?.email;

  if (!userId || !email) {
    // Should never happen — Cognito always provides these on post-confirmation
    // Throw to block registration and surface a clear error
    throw new Error('postConfirmation: missing userId or email in Cognito event — registration blocked');
  }

  const now = new Date().toISOString();

  try {
    await client.send(new PutItemCommand({
      TableName: USER_ROUTE_TABLE,
      Item: marshall({
        userId,
        recordType: 'PROFILE',
        email,
        routeCount: 0,
        createdAt: now
      }),
      // Safety guard — should never be called twice for the same user,
      // but prevents overwriting an existing PROFILE if it somehow is
      ConditionExpression: 'attribute_not_exists(userId)'
    }));

    console.log(`PROFILE created: userId=${userId} email=${email}`);

  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // PROFILE already exists — idempotent, not an error
      // Log and continue so registration succeeds
      console.warn(`PROFILE already exists for userId=${userId} — skipping write`);
    } else {
      // DynamoDB unavailable or unexpected error — throw to block registration
      console.error('postConfirmation error:', err);
      throw err;
    }
  }

  // Must return the event object back to Cognito
  return event;
};
