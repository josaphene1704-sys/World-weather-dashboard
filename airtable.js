// Airtable is the dashboard's data store: refreshes upsert one row per city (matched on "City ID"),
// and the dashboard reads its cards back from the table.

const { AIRTABLE_API_KEY: API_KEY, AIRTABLE_BASE_ID: BASE_ID, AIRTABLE_TABLE: TABLE } = process.env;
const TABLE_URL = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE ?? '')}`;
const HEADERS = { Authorization: `Bearer ${API_KEY}` };
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
    'Wind (km/h)': city.wind,
    'Wind Direction': city.windDir,
    'UV Index': city.uv,
    'UTC Offset': city.utcOffset,
    'Updated At': new Date(updatedAt).toISOString(),
  };
}

const withoutSkipped = (fields) =>
  Object.fromEntries(Object.entries(fields).filter(([name]) => !skippedFields.has(name)));

async function upsertBatch(records) {
  const res = await fetch(TABLE_URL, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
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

const num = (v) => (typeof v === 'number' ? v : v == null || v === '' ? null : Number(v));

// Table row -> the city shape the dashboard renders
function fromFields(f) {
  return {
    id: String(f[MERGE_FIELD] ?? '').trim().toLowerCase(),
    capital: f.Capital ?? '',
    country: f.Country ?? '',
    continent: f.Continent ?? '',
    lat: num(f.Latitude),
    lon: num(f.Longitude),
    temperature: num(f['Temperature (°C)']),
    feelslike: num(f['Feels Like (°C)']),
    description: f.Description ?? '',
    code: num(f['Weather Code']),
    humidity: num(f['Humidity (%)']),
    wind: num(f['Wind (km/h)']),
    windDir: f['Wind Direction'] ?? null,
    uv: num(f['UV Index']),
    utcOffset: num(f['UTC Offset']),
    lastUpdated: f['Updated At'] ? Date.parse(f['Updated At']) : null,
  };
}

// Reads every row of the table (Airtable pages at 100 rows)
export async function readFromAirtable() {
  const cities = [];
  let offset;
  do {
    const url = new URL(TABLE_URL);
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: HEADERS });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${body.error?.message ?? body.error?.type ?? body.error ?? 'unknown error'}`);
    cities.push(...body.records.map((r) => fromFields(r.fields)));
    offset = body.offset;
  } while (offset);
  // Skip blank rows (e.g. an empty line added in the Airtable UI)
  return cities.filter((c) => c.id && c.temperature != null);
}
