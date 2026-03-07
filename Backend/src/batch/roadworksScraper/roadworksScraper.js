// roadworksScraper — triggered by EventBridge nightly at 23:00 GMT
// Reads active cities from locationDB.
// Fetches planned future Road Works incidents (category 9) from TomTom Traffic Incidents API
// using a bounding box centred on each city's coordinates.
// Only timeValidityFilter=future incidents are fetched — live traffic (accidents, congestion)
// is excluded by design. See ADR-006.
// Writes ROADWORKS#YYYY-MM-DD records to delaysDB for the next 7 days with 8-day TTL,
// so advance-notice incidents (e.g. bridge closure starting in 3 days) appear in the
// correct day's record and survive long enough for delayWorker to read them.
// delayWorker reads these records and matches against user routes using isNearCorridor.

const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { batchWrite, DAY_MAP, fetchHttpJson, callWithRetry } = require('/opt/nodejs/utils');

const client = new DynamoDBClient({});
const ssmClient = new SSMClient({});
const DELAYS_TABLE = process.env.DELAYS_TABLE;
const LOCATION_DB_TABLE = process.env.LOCATION_DB_TABLE;

let tomtomApiKey = null; // module-level cache — fetched once per cold start

const getTomTomApiKey = async () => {
  if (tomtomApiKey) return tomtomApiKey;
  const res = await ssmClient.send(new GetParameterCommand({
    Name: '/routeApp/tomtomApiKey',
    WithDecryption: true
  }));
  tomtomApiKey = res.Parameter.Value;
  return tomtomApiKey;
};

// Compute an approximate bounding box around a lat/lng with a given radius in km.
// TomTom bbox format: minLon,minLat,maxLon,maxLat (west,south,east,north in WGS84).
const computeBoundingBox = (lat, lng, radiusKm = 30) => {
  const deltaLat = radiusKm / 111;
  const deltaLng = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
  return [
    (lng - deltaLng).toFixed(6),
    (lat - deltaLat).toFixed(6),
    (lng + deltaLng).toFixed(6),
    (lat + deltaLat).toFixed(6)
  ].join(',');
};

// Fetch planned Road Works incidents from TomTom Traffic Incidents API v5.
// Returns raw GeoJSON Feature array from the incidents field of the response.
// Retried up to 3× with exponential backoff via callWithRetry — handles transient 5xx / timeouts.
const fetchTomTomIncidents = async (apiKey, bbox) => {
  const url = `https://api.tomtom.com/traffic/services/5/incidentDetails?key=${apiKey}&bbox=${bbox}&timeValidityFilter=future&categoryFilter=9`;
  const parsed = await callWithRetry(() => fetchHttpJson(url));
  return parsed.incidents || [];
};

// Map a raw TomTom GeoJSON Feature to a stored incident object.
// TomTom uses GeoJSON coordinate order [lng, lat] — swapped to { lat, lng } for consistency
// with the rest of the codebase (isNearCorridor, TRANSIT# pointAlerts, EVENTS# venues).
// Point geometry  → { lat, lng, description, startTime, endTime }
// LineString      → { path: [{lat,lng},...], description, startTime, endTime }
// Returns null for unrecognised geometry or missing coordinates — filtered out by caller.
const mapIncident = (feature) => {
  const props = feature.properties || {};
  const description = props.events?.[0]?.description || props.from || null;
  const startTime = props.startTime || null;
  const endTime = props.endTime || null;
  const geo = feature.geometry;

  if (!geo || !geo.coordinates) return null;

  if (geo.type === 'Point') {
    const [lng, lat] = geo.coordinates;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, description, startTime, endTime };
  }

  if (geo.type === 'LineString') {
    const path = geo.coordinates
      .map(([lng, lat]) => ({ lat, lng }))
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (path.length === 0) return null;
    return { path, description, startTime, endTime };
  }

  return null;
};

// Returns true if the incident is active on the given calendar date string (YYYY-MM-DD).
// An incident is active on dayStr if startTime date <= dayStr AND endTime date >= dayStr.
// No startTime  → treated as already-started; include on all days.
// No endTime    → open-ended; include on all days from startTime onward.
// ISO8601 date prefixes are lexicographically comparable — no Date parsing needed.
const isActiveOnDay = (incident, dayStr) => {
  if (incident.startTime && incident.startTime.slice(0, 10) > dayStr) return false;
  if (incident.endTime && incident.endTime.slice(0, 10) < dayStr) return false;
  return true;
};

exports.handler = async (event) => {
  console.log('roadworksScraper invoked');

  try {
    const cityResult = await client.send(new ScanCommand({
      TableName: LOCATION_DB_TABLE,
      FilterExpression: 'activeRouteCount > :zero',
      ExpressionAttributeValues: marshall({ ':zero': 0 })
    }));

    const cities = (cityResult.Items || []).map(i => unmarshall(i));
    console.log(`Fetching roadworks for ${cities.length} active cities`);

    if (cities.length === 0) {
      console.log('No active cities — nothing to fetch');
      return;
    }

    const TOMTOM_KEY = await getTomTomApiKey();
    const today = new Date();
    const ttl = Math.floor(Date.now() / 1000) + (8 * 24 * 60 * 60);

    // Fetch incidents for all cities in parallel — one bounding-box request per city
    const cityIncidents = await Promise.all(
      cities.map(async (city) => {
        try {
          const bbox = computeBoundingBox(city.cityLat, city.cityLng);
          const raw = await fetchTomTomIncidents(TOMTOM_KEY, bbox);
          const incidents = raw.map(mapIncident).filter(Boolean);
          console.log(`${city.cityKey}: ${incidents.length} roadworks incidents from TomTom`);
          return { city, incidents };
        } catch (err) {
          console.error(`Failed to fetch roadworks for ${city.cityKey}:`, err);
          return { city, incidents: [] };
        }
      })
    );

    // Write one ROADWORKS# record per city per day for the next 7 days.
    // Day-bucketing (like EVENTS#) means an incident starting in 3 days appears in the
    // ROADWORKS#{day+3} record written tonight and survives via TTL until delayWorker reads it.
    const writeRequests = [];
    const generatedAt = new Date().toISOString();

    for (const { city, incidents } of cityIncidents) {
      for (let i = 1; i <= 7; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);
        const dateStr = date.toISOString().split('T')[0];
        const dayOfWeek = DAY_MAP[date.getDay()];
        const dayIncidents = incidents.filter(inc => isActiveOnDay(inc, dateStr));

        writeRequests.push({
          PutRequest: {
            Item: marshall({
              cityKey: city.cityKey,
              typeDate: `ROADWORKS#${dateStr}`,
              city: city.city,
              countryCode: city.countryCode,
              date: dateStr,
              dayOfWeek,
              incidents: dayIncidents,
              ttl,
              generatedAt
            })
          }
        });
      }
    }

    await batchWrite(client, DELAYS_TABLE, writeRequests);
    console.log(`roadworksScraper complete — ${writeRequests.length} records written across ${cities.length} cities`);

  } catch (err) {
    console.error('roadworksScraper error:', err);
    throw err;
  }
};
