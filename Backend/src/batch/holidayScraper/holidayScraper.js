// holidayScraper — triggered by EventBridge nightly at 23:00 GMT
// Reads active cities from locationDB (read-only — no writes to locationDB).
// Fetches public holidays from Nager.Date once per unique countryCode — O(countries), not O(cities).
// Filters holidays per city using subdivisionCode (ISO 3166-2 e.g. "IE-L"):
//   - Nationwide holidays (counties null/empty) always included.
//   - Region-specific holidays (counties array non-empty) only included when subdivisionCode matches.
//   - Cities with no subdivisionCode conservatively receive all national holidays.
// Fetches current year + next year so the 7-day forecast window is covered across the year boundary.
// Writes individual HOLIDAY#YYYY-MM-DD records to delaysDB — one per applicable holiday per city.
//   Each record carries a TTL set to the day after the holiday date (auto-expiry via DynamoDB TTL).
// Writes a HOLIDAY_REFRESH marker (SK: HOLIDAY_REFRESH) to delaysDB per city to gate the annual refresh.
//
// Annual refresh strategy (ADR-008):
//   City is skipped if a HOLIDAY_REFRESH record exists with refreshedYear = current calendar year,
//   EXCEPT in December. December is always a re-run — next-year holidays are commonly published in
//   Q4, so a December run is needed to pick them up before January.

const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { batchGet, batchWrite, callWithRetry, fetchHttpJson } = require('/opt/nodejs/utils');

const client = new DynamoDBClient({});
const LOCATION_DB_TABLE = process.env.LOCATION_DB_TABLE;
const DELAYS_TABLE = process.env.DELAYS_TABLE;

// Returns true if the city should be skipped this run.
// refresh is the unmarshalled HOLIDAY_REFRESH record from delaysDB, or null/undefined if absent.
// Skip when: refresh exists, refreshedYear matches the current year, AND it is not December.
const shouldSkipCity = (refresh, now) => {
  if (!refresh) return false;
  const isDecember = now.getMonth() === 11; // 0-indexed
  if (refresh.refreshedYear !== now.getFullYear()) return false; // populated in a previous year — stale
  return !isDecember;                                            // skip Jan–Nov; re-run in December
};

// Fetch all public holidays for a country+year from Nager.Date (no auth required, MIT licence).
// Returns array of raw Nager holiday objects, or [] on 404 (country not supported by Nager.Date).
// Retried up to 3× with exponential backoff for transient 5xx / timeouts.
// fetchHttpJson sets err.retryable=false for 4xx (except 429) so 404 is not retried.
const fetchHolidays = async (countryCode, year) => {
  const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`;
  try {
    return await callWithRetry(() => fetchHttpJson(url));
  } catch (err) {
    if (err.statusCode === 404) return []; // country not supported by Nager.Date
    throw err;
  }
};

// A holiday applies to a city when it is nationwide (counties null/empty) OR its counties
// list includes the city's ISO 3166-2 subdivisionCode.
// Cities with no subdivisionCode receive all national holidays (conservative inclusion).
const isApplicableToCity = (holiday, subdivisionCode) => {
  if (!holiday.counties || holiday.counties.length === 0) return true;
  if (!subdivisionCode) return true;
  return holiday.counties.includes(subdivisionCode);
};

exports.handler = async () => {
  console.log('holidayScraper invoked');

  try {
    // Scan locationDB for active cities (read-only)
    const cityResult = await client.send(new ScanCommand({
      TableName: LOCATION_DB_TABLE,
      FilterExpression: 'activeRouteCount > :zero',
      ExpressionAttributeValues: marshall({ ':zero': 0 })
    }));

    const cities = (cityResult.Items || []).map(i => unmarshall(i));
    console.log(`Found ${cities.length} active cities`);

    if (cities.length === 0) {
      console.log('No active cities — nothing to fetch');
      return;
    }

    // BatchGet HOLIDAY_REFRESH markers from delaysDB to apply the annual refresh gate
    const refreshKeys = cities.map(c => marshall({ cityKey: c.cityKey, typeDate: 'HOLIDAY_REFRESH' }));
    const refreshMap = await batchGet(client, DELAYS_TABLE, refreshKeys, item => item.cityKey, unmarshall);

    const now = new Date();
    const citiesToUpdate = cities.filter(c => !shouldSkipCity(refreshMap[c.cityKey], now));
    const skippedCount = cities.length - citiesToUpdate.length;
    console.log(`${citiesToUpdate.length} cities to update, ${skippedCount} skipped (already updated in ${now.getFullYear()}${now.getMonth() === 11 ? ' — December re-run for next-year holidays' : ''})`);

    if (citiesToUpdate.length === 0) {
      console.log('All cities already updated this year — nothing to fetch');
      return;
    }

    // Fetch current year + next year to cover the 7-day forecast window at year boundary
    const thisYear = now.getFullYear();
    const nextYear = thisYear + 1;

    // Deduplicate countryCode values — one Nager.Date call per country per year
    const uniqueCountryCodes = [...new Set(citiesToUpdate.map(c => c.countryCode).filter(Boolean))];
    console.log(`Fetching holidays for ${uniqueCountryCodes.length} unique countries (${thisYear} + ${nextYear})`);

    // Fetch all country/year pairs in parallel
    const holidaysByCountryYear = {};
    await Promise.all(
      uniqueCountryCodes.flatMap(cc =>
        [thisYear, nextYear].map(async (year) => {
          try {
            const holidays = await fetchHolidays(cc, year);
            holidaysByCountryYear[`${cc}#${year}`] = holidays;
            console.log(`${cc}/${year}: ${holidays.length} holidays`);
          } catch (err) {
            console.error(`Failed to fetch holidays for ${cc}/${year}:`, err);
            holidaysByCountryYear[`${cc}#${year}`] = [];
          }
        })
      )
    );

    // Build all write requests up front, then issue two consolidated batchWrite calls —
    // one for all HOLIDAY# records across all cities, one for all HOLIDAY_REFRESH markers.
    // This matches the pattern used by other scrapers and avoids N sequential DynamoDB calls.
    const holidayWriteRequests = [];
    const refreshWriteRequests = [];

    for (const city of citiesToUpdate) {
      const cc = city.countryCode;
      if (!cc) continue;

      const allHolidays = [
        ...(holidaysByCountryYear[`${cc}#${thisYear}`] || []),
        ...(holidaysByCountryYear[`${cc}#${nextYear}`] || [])
      ];

      const cityHolidays = allHolidays.filter(h => isApplicableToCity(h, city.subdivisionCode));
      console.log(`${city.cityKey}: ${cityHolidays.length} holidays queued (subdivisionCode=${city.subdivisionCode ?? 'none'})`);

      for (const h of cityHolidays) {
        // TTL: expire the record one day after the holiday date (Unix seconds)
        const ttl = Math.floor((new Date(h.date).getTime() + 86_400_000) / 1000);
        holidayWriteRequests.push({
          PutRequest: {
            Item: marshall({
              cityKey: city.cityKey,
              typeDate: `HOLIDAY#${h.date}`,
              name: h.name,
              types: h.types || [],
              ttl
            })
          }
        });
      }

      // HOLIDAY_REFRESH has no TTL — it persists until overwritten on next year's run
      refreshWriteRequests.push({
        PutRequest: {
          Item: marshall({
            cityKey: city.cityKey,
            typeDate: 'HOLIDAY_REFRESH',
            refreshedAt: now.toISOString(),
            refreshedYear: now.getFullYear()
          })
        }
      });
    }

    if (holidayWriteRequests.length > 0) {
      await batchWrite(client, DELAYS_TABLE, holidayWriteRequests);
    }
    await batchWrite(client, DELAYS_TABLE, refreshWriteRequests);

    console.log(`holidayScraper complete — ${refreshWriteRequests.length} cities processed (${holidayWriteRequests.length} holiday records written)`);

  } catch (err) {
    console.error('holidayScraper error:', err);
    throw err;
  }
};
