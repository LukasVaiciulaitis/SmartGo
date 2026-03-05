// transitScraper — triggered by EventBridge nightly at 23:00 GMT alongside weatherScraper and eventScraper
// Reads active cities from locationDB that have a transitlandFeedId configured.
// Fetches GTFS-RT ServiceAlerts for each city via Transitland's download_latest_rt API (one call per city).
// Builds route-level alerts using routeId directly as shortName —
// major agencies (MTA, TfL, etc.) use human-readable short names as their GTFS route_id (e.g. "X28", "M55").
// Stop-level informedEntity entries (those with a stopId) are skipped — no coordinate resolution is needed.
// Writes TRANSIT#YYYY-MM-DD records to delaysDB for tomorrow's date with 8-day TTL.
// delayWorker reads these records and matches routeAlerts against stored route steps using
// shortName matching (nameShort from Google Routes API steps).

const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { batchWrite, callWithRetry, DAY_MAP } = require('/opt/nodejs/utils');

const dynamoClient = new DynamoDBClient({});
const ssmClient = new SSMClient({});
const DELAYS_TABLE = process.env.DELAYS_TABLE;
const LOCATION_DB_TABLE = process.env.LOCATION_DB_TABLE;

// Module-level cache — key survives warm Lambda invocations.
let cachedApiKey = null;

const getTransitlandApiKey = async () => {
  if (cachedApiKey) return cachedApiKey;
  const result = await ssmClient.send(new GetParameterCommand({
    Name: '/routeApp/transitlandApiKey',
    WithDecryption: true
  }));
  cachedApiKey = result.Parameter.Value;
  return cachedApiKey;
};

// Extract the best English text from a GTFS-RT TranslatedString.
// Falls back to the first available translation if no English entry exists.
const getText = (translatedString) => {
  if (!translatedString) return null;
  const translations = translatedString.translation || [];
  const en = translations.find(t => !t.language || t.language === 'en' || t.language === 'en-IE') || translations[0];
  return en?.text || null;
};

// Returns true if the alert has at least one active_period ending in the future,
// or no active_period at all (no expiry = perpetually active).
const isActiveAlert = (alert, nowSecs) => {
  const periods = alert.activePeriod || [];
  if (periods.length === 0) return true;
  return periods.some(p => {
    const end = p.end ? Number(p.end) : null;
    return end === null || end === 0 || end > nowSecs;
  });
};

exports.handler = async (event) => {
  console.log('transitScraper invoked');

  try {
    const apiKey = await getTransitlandApiKey();

    // Scan locationDB for active cities that have at least one Transitland feed ID configured.
    const cityResult = await dynamoClient.send(new ScanCommand({
      TableName: LOCATION_DB_TABLE,
      FilterExpression: 'activeRouteCount > :zero AND attribute_exists(transitlandFeedIds)',
      ExpressionAttributeValues: marshall({ ':zero': 0 })
    }));

    // Only process cities that have a non-empty feed ID list.
    const cities = (cityResult.Items || []).map(i => unmarshall(i))
      .filter(c => Array.isArray(c.transitlandFeedIds) && c.transitlandFeedIds.length > 0);
    console.log(`Fetching transit alerts for ${cities.length} cities with transitlandFeedIds`);

    if (cities.length === 0) {
      console.log('No cities with transitlandFeedIds configured — nothing to scrape');
      return;
    }

    const nowSecs = Math.floor(Date.now() / 1000);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    const dayOfWeek = DAY_MAP[tomorrow.getDay()];
    const ttl = nowSecs + (8 * 24 * 60 * 60); // 8-day TTL matches other delay records
    const generatedAt = new Date().toISOString();

    // Per-city try/catch ensures one bad feed does not abort the remaining cities.
    const cityResults = await Promise.all(cities.map(async (city) => {
      try {
        // Fetch alerts from every feed configured for this city and merge results.
        // Deduplication by routeId ensures the same route alert from overlapping feeds
        // (e.g. a consolidated feed + a per-line feed) is only written once.
        const seenRouteIds = new Set();
        const routeAlerts = [];

        for (const feedId of city.transitlandFeedIds) {
          const url = `https://transit.land/api/v2/rest/feeds/${feedId}/download_latest_rt/alerts.json?apikey=${apiKey}`;

          let data;
          try {
            data = await callWithRetry(async () => {
              const res = await fetch(url);
              if (!res.ok) {
                const err = new Error(`HTTP ${res.status} from Transitland feed ${feedId} for ${city.cityKey}`);
                err.retryable = res.status >= 500;
                throw err;
              }
              return res.json();
            });
          } catch (err) {
            console.error(`Failed to fetch feed ${feedId} for ${city.cityKey}:`, err.message);
            continue; // one bad feed should not block the others
          }

          const entities = data.entity || [];
          const activeAlerts = entities.filter(e => e.alert && isActiveAlert(e.alert, nowSecs));
          console.log(`${city.cityKey} [${feedId}]: ${activeAlerts.length} active alerts`);

          // Build route-level alerts directly from informedEntity.routeId.
          // Entries narrowed by stopId (platform-specific) are skipped — the routeId alone
          // is sufficient for line-level corridor matching in delayWorker.
          for (const entity of activeAlerts) {
            const alert = entity.alert;
            const header = getText(alert.headerText);
            const description = getText(alert.descriptionText);
            const activePeriods = (alert.activePeriod || []).map(p => ({
              start: p.start ? Number(p.start) : null,
              end: p.end ? Number(p.end) : null
            }));

            for (const ie of (alert.informedEntity || [])) {
              if (!ie.routeId || ie.stopId) continue;
              if (seenRouteIds.has(ie.routeId)) continue;
              seenRouteIds.add(ie.routeId);
              routeAlerts.push({ shortName: ie.routeId, header, description, activePeriods });
            }
          }
        }

        console.log(`${city.cityKey}: ${routeAlerts.length} route alerts extracted across ${city.transitlandFeedIds.length} feed(s)`);
        return { city, routeAlerts };

      } catch (err) {
        console.error(`Failed to process transit alerts for ${city.cityKey}:`, err);
        return null; // skip — don't fail the whole invocation for one city
      }
    }));

    // Build write requests from collected results.
    // TRANSIT# records carry the same standard fields (city, countryCode, date, dayOfWeek)
    // as WEATHER#, EVENTS#, and ROADWORKS# records for consistency across delaysDB.
    // pointAlerts is always empty — stop-level alert matching requires coordinate resolution
    // and is deferred as a future enhancement once agency coverage is established.
    const writeRequests = [];
    for (const result of cityResults) {
      if (!result) continue;
      const { city, routeAlerts } = result;
      writeRequests.push({
        PutRequest: {
          Item: marshall({
            cityKey: city.cityKey,
            typeDate: `TRANSIT#${tomorrowStr}`,
            city: city.city,
            countryCode: city.countryCode,
            date: tomorrowStr,
            dayOfWeek,
            pointAlerts: [],
            routeAlerts,
            ttl,
            generatedAt
          })
        }
      });
    }

    await batchWrite(dynamoClient, DELAYS_TABLE, writeRequests);
    console.log(`transitScraper complete — ${writeRequests.length} TRANSIT# records written`);

  } catch (err) {
    console.error('transitScraper error:', err);
    throw err;
  }
};
