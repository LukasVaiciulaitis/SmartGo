// weatherScraper — triggered by EventBridge nightly at 23:00 GMT
// Reads active cities from locationDB.
// Fetches 7-day hourly forecast from Open-Meteo per city.
// Stores full 24-hour hourly precipitation data per day — no time window filtering.
// Relevance decisions (which hours matter per user) are made in delayWorker, not here.
// Writes WEATHER#YYYY-MM-DD records to delaysDB with 8-day TTL.

const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { batchWrite, DAY_MAP, fetchHttpJson, callWithRetry } = require('/opt/nodejs/utils');

const client = new DynamoDBClient({});
const DELAYS_TABLE = process.env.DELAYS_TABLE;
const LOCATION_DB_TABLE = process.env.LOCATION_DB_TABLE;

// Fetch full 7-day hourly forecast from Open-Meteo for a city centroid.
// timezone=UTC ensures hours are returned in UTC — delayWorker applies user timezone if needed.
// Variables fetched:
//   precipitation  — total wet precipitation (rain + showers + snowfall), mm
//   snowfall       — snowfall amount, cm (separate from precipitation for explicit snow detection)
//   wind_speed_10m — wind speed at 10m height, km/h
//   weather_code   — WMO weather interpretation code (used to detect fog: codes 45, 48)
// Retried up to 3× with exponential backoff via callWithRetry — handles transient 5xx / timeouts.
const fetchWeatherForecast = (lat, lng) => {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=precipitation,snowfall,wind_speed_10m,weather_code&timezone=UTC&forecast_days=8`;
  return callWithRetry(() => fetchHttpJson(url));
};

// Extract full 24-hour hourly weather array for a given date
// Returns array of { hour: "HH", precipitationMm, snowfallCm, windspeedKph, weatherCode }
const extractHourlyData = (hourlyData, dateStr) => {
  return hourlyData.time
    .map((t, i) => ({
      time: t,
      precipitationMm: hourlyData.precipitation[i],
      snowfallCm: hourlyData.snowfall[i],
      windspeedKph: hourlyData.wind_speed_10m[i],
      weatherCode: hourlyData.weather_code[i]
    }))
    .filter(h => h.time.startsWith(dateStr))
    .map(h => ({
      hour: h.time.split('T')[1].substring(0, 2),
      precipitationMm: Math.round(h.precipitationMm * 10) / 10,
      snowfallCm: Math.round(h.snowfallCm * 10) / 10,
      windspeedKph: Math.round(h.windspeedKph * 10) / 10,
      weatherCode: h.weatherCode
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
    const generatedAt = new Date().toISOString();

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
              generatedAt
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
