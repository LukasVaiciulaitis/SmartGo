// weatherScraper — triggered by EventBridge nightly at 23:00 GMT
// Reads active cities from locationDB.
// Fetches 7-day hourly forecast from Open-Meteo per city.
// Stores full 24-hour hourly precipitation data per day — no time window filtering.
// Relevance decisions (which hours matter per user) are made in delayWorker, not here.
// Writes WEATHER#YYYY-MM-DD records to delaysDB with 8-day TTL.

const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { batchWrite } = require('/opt/nodejs/utils');
const https = require('https');

const client = new DynamoDBClient({});
const DELAYS_TABLE = process.env.DELAYS_TABLE;
const LOCATION_DB_TABLE = process.env.LOCATION_DB_TABLE;

const DAY_MAP = { 0: 'SUN', 1: 'MON', 2: 'TUE', 3: 'WED', 4: 'THU', 5: 'FRI', 6: 'SAT' };

// Fetch full 7-day hourly forecast from Open-Meteo for a city centroid
// timezone=UTC ensures hours are returned in UTC — delayWorker applies user timezone if needed
const fetchWeatherForecast = (lat, lng) => {
  return new Promise((resolve, reject) => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=precipitation&timezone=UTC&forecast_days=8`;
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse Open-Meteo response for lat=${lat} lng=${lng}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error(`Open-Meteo request timed out for lat=${lat} lng=${lng}`));
    });
  });
};

// Extract full 24-hour hourly precipitation array for a given date
// Returns array of { hour: "HH", precipitationMm: N } for all 24 hours
const extractHourlyData = (hourlyData, dateStr) => {
  return hourlyData.time
    .map((t, i) => ({ time: t, precipitationMm: hourlyData.precipitation[i] }))
    .filter(h => h.time.startsWith(dateStr))
    .map(h => ({
      hour: h.time.split('T')[1].substring(0, 2),
      precipitationMm: Math.round(h.precipitationMm * 10) / 10
    }));
};

exports.handler = async (event) => {
  console.log('weatherScraper invoked');

  try {
    // Scan locationDB for active cities — scrapers are city-aware only, not user-aware
    const cityResult = await client.send(new ScanCommand({
      TableName: LOCATION_DB_TABLE,
      FilterExpression: 'activeRouteCount > :zero',
      ExpressionAttributeValues: marshall({ ':zero': 0 })
    }));

    const cities = (cityResult.Items || []).map(i => unmarshall(i));
    console.log(`Fetching weather for ${cities.length} active cities`);

    if (cities.length === 0) {
      console.log('No active cities — nothing to fetch');
      return;
    }

    const today = new Date();
    const ttl = Math.floor(Date.now() / 1000) + (8 * 24 * 60 * 60);

    // Fetch weather for all cities in parallel
    // Open-Meteo is free with no rate limit concerns at city scale
    const cityForecasts = await Promise.all(
      cities.map(async (city) => {
        try {
          const forecast = await fetchWeatherForecast(city.cityLat, city.cityLng);
          return { city, forecast };
        } catch (err) {
          console.error(`Failed to fetch weather for ${city.cityKey}:`, err);
          return { city, forecast: null };
        }
      })
    );

    // Build all DynamoDB write requests
    const writeRequests = [];

    for (const { city, forecast } of cityForecasts) {
      if (!forecast) continue;

      // Write one WEATHER# record per day for next 7 days
      for (let i = 1; i <= 7; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);
        const dateStr = date.toISOString().split('T')[0];
        const dayOfWeek = DAY_MAP[date.getDay()];
        const hourly = extractHourlyData(forecast.hourly, dateStr);

        writeRequests.push({
          PutRequest: {
            Item: marshall({
              cityKey: city.cityKey,
              typeDate: `WEATHER#${dateStr}`,
              city: city.city,
              countryCode: city.countryCode,
              date: dateStr,
              dayOfWeek,
              hourly,
              ttl,
              generatedAt: new Date().toISOString()
            })
          }
        });
      }
    }

    // batchWrite handles chunking to 25 and retries unprocessed items with exponential backoff
    await batchWrite(client, DELAYS_TABLE, writeRequests);

    console.log(`weatherScraper complete — ${writeRequests.length} records written across ${cities.length} cities`);

  } catch (err) {
    console.error('weatherScraper error:', err);
    throw err;
  }
};
