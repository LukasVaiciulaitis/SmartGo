// eventScraper — triggered by EventBridge nightly at 23:00 GMT
// Reads active cities from locationDB.
// Fetches all events from Ticketmaster per city for the next 7 days.
// Stores all events regardless of start time — no commute window filtering.
// Relevance decisions (which events affect which user's route) are made in delayWorker, not here.
// Writes EVENTS#YYYY-MM-DD records to delaysDB with 8-day TTL.

const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { chunkArray, batchWrite } = require('/opt/nodejs/utils');
const https = require('https');

const client = new DynamoDBClient({});
const ssmClient = new SSMClient({});
const DELAYS_TABLE = process.env.DELAYS_TABLE;
const LOCATION_DB_TABLE = process.env.LOCATION_DB_TABLE;

let tmApiKey = null; // module-level cache — fetched once per cold start

const getTmApiKey = async () => {
  if (tmApiKey) return tmApiKey;
  const res = await ssmClient.send(new GetParameterCommand({
    Name: '/routeApp/ticketmasterApiKey',
    WithDecryption: false
  }));
  tmApiKey = res.Parameter.Value;
  return tmApiKey;
};

const DAY_MAP = { 0: 'SUN', 1: 'MON', 2: 'TUE', 3: 'WED', 4: 'THU', 5: 'FRI', 6: 'SAT' };

// Fetch a single page of events from Ticketmaster Discovery API v2
// Uses lat/lng + radius instead of city name — Ticketmaster Ireland is organised by region,
// not city, so city=DUBLIN returns 0 results. A 25km radius around the city centroid is reliable.
const fetchTicketmasterPage = (apiKey, lat, lng, startDate, endDate, page) => {
  return new Promise((resolve, reject) => {
    const url = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${apiKey}&latlong=${lat},${lng}&radius=25&unit=km&startDateTime=${startDate}T00:00:00Z&endDateTime=${endDate}T23:59:59Z&size=200&page=${page}&sort=date,asc`;

    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse Ticketmaster response for lat=${lat},lng=${lng} page ${page}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error(`Ticketmaster request timed out for lat=${lat},lng=${lng} page ${page}`));
    });
  });
};

// Fetch all events across all pages from Ticketmaster for a given lat/lng and date range
// Page 0 is fetched first to determine totalPages, then remaining pages fetched in parallel
const fetchTicketmasterEvents = async (lat, lng, startDate, endDate) => {
  const TM_API_KEY = await getTmApiKey();
  if (!TM_API_KEY) {
    console.warn(`Ticketmaster key not set — skipping events for lat=${lat},lng=${lng}`);
    return [];
  }

  const firstPage = await fetchTicketmasterPage(TM_API_KEY, lat, lng, startDate, endDate, 0);
  const totalPages = Math.min(firstPage.page?.totalPages || 1, 5); // Ticketmaster hard cap is 1,000 results (5 pages of 200)
  const firstEvents = firstPage._embedded?.events || [];

  if (totalPages === 1) return firstEvents;

  // Fetch remaining pages in parallel
  // Note: Ticketmaster rate limit is 5 req/sec — monitor if city count grows significantly
  const remainingPages = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, i) =>
      fetchTicketmasterPage(TM_API_KEY, lat, lng, startDate, endDate, i + 1)
    )
  );

  return [
    ...firstEvents,
    ...remainingPages.flatMap(p => p._embedded?.events || [])
  ];
};

// Map a raw Ticketmaster event to a lean stored record
// Only store fields delayWorker needs for corridor filtering and reasoning.
// startTime is Ticketmaster's localTime (venue local time) — compared against user's local
// arriveBy in delayWorker (not UTC), keeping both sides in the same timezone frame.
const mapEvent = (ev) => {
  const rawLat = parseFloat(ev._embedded?.venues?.[0]?.location?.latitude);
  const rawLng = parseFloat(ev._embedded?.venues?.[0]?.location?.longitude);
  return {
    name: ev.name,
    venue: ev._embedded?.venues?.[0]?.name || null,
    lat: Number.isFinite(rawLat) ? rawLat : null,
    lng: Number.isFinite(rawLng) ? rawLng : null,
    startTime: ev.dates?.start?.localTime || null,
    url: ev.url || null
  };
};

exports.handler = async (event) => {
  console.log('eventScraper invoked');

  try {
    // Scan locationDB for active cities — scrapers are city-aware only, not user-aware
    const cityResult = await client.send(new ScanCommand({
      TableName: LOCATION_DB_TABLE,
      FilterExpression: 'activeRouteCount > :zero',
      ExpressionAttributeValues: marshall({ ':zero': 0 })
    }));

    const cities = (cityResult.Items || []).map(i => unmarshall(i));
    console.log(`Fetching events for ${cities.length} active cities`);

    if (cities.length === 0) {
      console.log('No active cities — nothing to fetch');
      return;
    }

    const today = new Date();
    const sevenDaysOut = new Date(today);
    sevenDaysOut.setDate(today.getDate() + 7);
    const startDate = new Date(today);
    startDate.setDate(today.getDate() + 1);
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = sevenDaysOut.toISOString().split('T')[0];
    const ttl = Math.floor(Date.now() / 1000) + (8 * 24 * 60 * 60);

    // Fetch events for all cities in parallel
    // Ticketmaster rate limit is 5 req/sec — at city scale this is fine
    // If city count grows significantly, add concurrency control here
    const cityEvents = await Promise.all(
      cities.map(async (city) => {
        try {
          const events = await fetchTicketmasterEvents(city.cityLat, city.cityLng, startDateStr, endDateStr);
          console.log(`${city.cityKey}: ${events.length} events from Ticketmaster`);
          return { city, events };
        } catch (err) {
          console.error(`Failed to fetch events for ${city.cityKey}:`, err);
          return { city, events: [] };
        }
      })
    );

    // Build all DynamoDB write requests
    const writeRequests = [];

    for (const { city, events } of cityEvents) {
      // Group events by date
      const eventsByDate = {};
      for (const ev of events) {
        const evDate = ev.dates?.start?.localDate;
        if (!evDate) continue;
        if (!eventsByDate[evDate]) eventsByDate[evDate] = [];
        eventsByDate[evDate].push(mapEvent(ev));
      }

      // Write one EVENTS# record per day for next 7 days
      for (let i = 1; i <= 7; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);
        const dateStr = date.toISOString().split('T')[0];
        const dayOfWeek = DAY_MAP[date.getDay()];
        const dayEvents = eventsByDate[dateStr] || [];

        writeRequests.push({
          PutRequest: {
            Item: marshall({
              cityKey: city.cityKey,
              typeDate: `EVENTS#${dateStr}`,
              city: city.city,
              countryCode: city.countryCode,
              date: dateStr,
              dayOfWeek,
              events: dayEvents,
              ttl,
              generatedAt: new Date().toISOString()
            })
          }
        });
      }
    }

    // batchWrite handles chunking to 25 and retries unprocessed items with exponential backoff
    await batchWrite(client, DELAYS_TABLE, writeRequests);

    console.log(`eventScraper complete — ${writeRequests.length} records written across ${cities.length} cities`);

  } catch (err) {
    console.error('eventScraper error:', err);
    throw err;
  }
};
