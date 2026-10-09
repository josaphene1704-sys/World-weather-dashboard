// Airtable sync - upserts one row per city after each refresh, matched on "City ID".

const { AIRTABLE_API_KEY: API_KEY, AIRTABLE_BASE_ID: BASE_ID, AIRTABLE_TABLE: TABLE } = process.env;
const BATCH_SIZE = 10; // Airtable max records per request
const MERGE_FIELD = 'City ID';

// Columns that may or may not exist in the table. Any the table rejects are skipped from then on.
const skippedFields = new Set();

export function hasAirtableConfig() {
  return Boolean(API_KEY && BASE_ID && TABLE);
}

function toFields(city, updatedAt) {
  return {
    [MERGE_FIELD]: city.id,
    Capital: city.capital,
    Country: city.country,
    Continent: city.continent,
    Latitude: city.lat,
    Longitude: city.lon,
    'Temperature (°C)': city.temperature,
    'Feels Like (°C)': city.feelslike,
    // Optional columns
    Description: city.description,
    'Weather Code': city.code,
    'Humidity (%)': city.humidity,
    'Wind Speed (km/h)': city.wind,
    'Wind Direction': city.windDir,
    'UV Index': city.uv,
    'Last Updated': new Date(updatedAt).toISOString(),
  };
}

const withoutSkipped = (fields) =>
  Object.fromEntries(Object.entries(fields).filter(([name]) => !skippedFields.has(name)));

async function upsertBatch(records) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      performUpsert: { fieldsToMergeOn: [MERGE_FIELD] },
      typecast: true, // lets Airtable add new Continent options automatically
      records: records.map((fields) => ({ fields: withoutSkipped(fields) })),
    }),
  });
  if (res.ok) return;

  const { error } = await res.json().catch(() => ({}));
  const unknown = error?.type === 'UNKNOWN_FIELD_NAME' && error.message.match(/"(.+?)"/)?.[1];
  if (unknown && unknown !== MERGE_FIELD && !skippedFields.has(unknown)) {
    console.warn(`Airtable: column "${unknown}" not found in the table - skipping it`);
    skippedFields.add(unknown);
    return upsertBatch(records);
  }
  throw new Error(`Airtable ${res.status}: ${error?.message ?? error?.type ?? error ?? 'unknown error'}`);
}

// Returns how many rows were written. Cities that failed to load are not sent.
export async function syncToAirtable({ updatedAt, cities }) {
  const records = cities.filter((c) => !c.error).map((c) => toFields(c, updatedAt));
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    await upsertBatch(records.slice(i, i + BATCH_SIZE));
  }
  return records.length;
}
