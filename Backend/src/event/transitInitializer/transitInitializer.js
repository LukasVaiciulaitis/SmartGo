// transitInitializer — triggered by DynamoDB Stream on locationDB (INSERT only)
// When a new city is added via routeCreate, this handler discovers and records
// which Transitland GTFS-RT feed IDs (if any) serve that city.
//
// For every INSERT, searches Transitland operators by city name, probes each
// candidate feed for ServiceAlerts availability, then writes transitlandFeedIds
// and gtfsRtAvailable back to locationDB. Cities where no GTFS-RT alerts feed
// exists (e.g. Ireland/NTA — confirmed 404) receive transitlandFeedIds: [] and
// gtfsRtAvailable: false; transitScraper skips them.

const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { getTransitlandApiKey, discoverTransitlandFeedIds } = require('/opt/nodejs/utils');

const dynamoClient = new DynamoDBClient({});
const LOCATION_TABLE = process.env.LOCATION_DB_TABLE;

exports.handler = async (event) => {
  console.log(`transitInitializer invoked — ${event.Records.length} stream record(s)`);

  for (const record of event.Records) {
    // FilterCriteria restricts to INSERT, but guard defensively
    if (record.eventName !== 'INSERT') continue;

    const city = unmarshall(record.dynamodb.NewImage);
    console.log(`Processing INSERT for city: ${city.cityKey}`);

    try {
      console.log(`${city.cityKey}: searching Transitland for GTFS-RT alert feeds`);

      const apiKey = await getTransitlandApiKey();
      const feedIds = await discoverTransitlandFeedIds([city.city], apiKey);

      const gtfsRtAvailable = feedIds.length > 0;
      console.log(`${city.cityKey}: discovery result: [${feedIds.join(', ') || 'none found'}] — gtfsRtAvailable=${gtfsRtAvailable}`);

      await dynamoClient.send(new UpdateItemCommand({
        TableName: LOCATION_TABLE,
        Key: marshall({ cityKey: city.cityKey }),
        UpdateExpression: 'SET transitlandFeedIds = :ids, gtfsRtAvailable = :avail',
        ExpressionAttributeValues: marshall({ ':ids': feedIds, ':avail': gtfsRtAvailable })
      }));

      console.log(`${city.cityKey}: wrote transitlandFeedIds and gtfsRtAvailable to locationDB`);

    } catch (err) {
      console.error(`transitInitializer failed for ${city.cityKey}:`, err);
      throw err; // Re-throw to trigger Lambda retry
    }
  }
};
