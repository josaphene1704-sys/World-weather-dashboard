// Airtable service - mirrors the dashboard's weather data into the "Weather" table.
// One record per city, upserted on "City ID", so every refresh updates rows instead of duplicating them.

const API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TABLE = process.env.AIRTABLE_TABLE || 'Weather';
const BATCH_SIZE = 10; // Airtable accepts at most 10 records per write
const MIN_GAP_MS = 250; // Airtable allows 5 requests/second per base

export class AirtableError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function isConfigured() {
  return Boolean(API_KEY) && Boolean(BASE_ID) && API_KEY !== 'your_airtable_token_here';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Maps a normalized city (see normalize() in server.js) to the table's fields
function toFields(city, updatedAt) {
  return {
    'City ID': city.id,
    Capital: city.capital,
    Country: city.country,
    Continent: city.continent,
    Latitude: city.lat,
    Longitude: city.lon,
    'Temperature (°C)': city.temperature,
    'Feels Like (°C)': city.feelslike,
    Description: city.description,
    'Weather Code': city.code,
    'Humidity (%)': city.humidity,
    'Wind (km/h)': city.wind,
    'Wind Direction': city.windDir,
    'UV Index': city.uv,
    'UTC Offset': city.utcOffset,
    'Updated At': new Date(updatedAt).toISOString(),
  };
}

async function request(body) {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null))?.error;
    throw new AirtableError(res.status, detail?.message ?? detail ?? `Airtable request failed (${res.status})`);
  }
  return res.json();
}

// cities: the array from a refresh; updatedAt: the refresh timestamp (ms).
// Cities that failed to load (no temperature) are skipped. Returns the number of rows written.
export async function syncWeather(cities, updatedAt = Date.now()) {
  if (!isConfigured()) throw new AirtableError(401, 'חסרים AIRTABLE_API_KEY ו-AIRTABLE_BASE_ID בקובץ .env');

  const records = cities
    .filter((city) => !city.error && city.temperature != null)
    .map((city) => ({ fields: toFields(city, updatedAt) }));

  let written = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    if (i > 0) await sleep(MIN_GAP_MS);
    const batch = records.slice(i, i + BATCH_SIZE);
    await request({
      performUpsert: { fieldsToMergeOn: ['City ID'] },
      typecast: true,
      records: batch,
    });
    written += batch.length;
  }
  return written;
}
