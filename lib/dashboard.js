// Weather dashboard API logic, shared by the local server (local-server.js) and Vercel (api/).
// Calls Weatherstack on the server, so the API key never reaches the browser.
// Results are cached on disk and only refreshed on demand, to protect the monthly call quota.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CITIES } from '../cities.js';
import { fetchCurrent, hasApiKey } from '../weatherstack.js';
import { syncToAirtable, readFromAirtable, hasAirtableConfig } from '../airtable.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Mock mode: fake data, zero API calls - for testing the UI
export const MOCK = process.env.MOCK === '1' || process.argv.includes('--mock');
const MONTHLY_LIMIT = Number(process.env.MONTHLY_CALL_LIMIT) || 100; // Weatherstack free plan
const MIN_REFRESH_MINUTES = 10;
// The free plan rejects bursts of parallel requests, so call one city at a time with a pause
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS) || 1200;
const RATE_LIMIT_RETRY_MS = 3000;
// Stop the whole refresh on these: invalid key, inactive account, quota reached
const FATAL_CODES = new Set([101, 102, 104]);
const isRateLimit = (err) => err.code === 106 || /rate limit/i.test(err.message);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Vercel's file system is read-only except /tmp, which is wiped between cold starts -
// there the table is the real store and this cache is only a short-lived fallback.
const DATA_DIR = process.env.VERCEL ? '/tmp/weather-data' : path.join(ROOT, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, MOCK ? 'weather.mock.json' : 'weather.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(file, data) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

// --- Monthly usage tracking (local count of calls made by this dashboard) ---

const currentMonth = () => new Date().toISOString().slice(0, 7);

async function getUsage() {
  const usage = await readJson(USAGE_FILE);
  return usage?.month === currentMonth() ? usage : { month: currentMonth(), calls: 0 };
}

async function addUsage(calls) {
  if (!calls) return;
  const usage = await getUsage();
  usage.calls += calls;
  await writeJson(USAGE_FILE, usage);
}

// --- Fetching ---

function normalize(city, { location, current }) {
  return {
    ...city,
    temperature: current.temperature,
    feelslike: current.feelslike,
    description: current.weather_descriptions?.[0]?.trim() ?? '',
    code: current.weather_code,
    humidity: current.humidity,
    wind: current.wind_speed,
    windDir: current.wind_dir,
    uv: current.uv_index,
    utcOffset: Number(location.utc_offset),
  };
}

const MOCK_CODES = [113, 113, 116, 119, 122, 143, 176, 296, 302, 389, 326];

// Same shape as a real Weatherstack response
function mockResponse(city) {
  const temperature = Math.round(30 - Math.abs(city.lat) * 0.45 + (Math.random() * 8 - 4));
  return {
    location: { utc_offset: String(Math.round(city.lon / 15)) },
    current: {
      temperature,
      feelslike: temperature + Math.round(Math.random() * 4 - 2),
      weather_descriptions: ['Mock data'],
      weather_code: MOCK_CODES[Math.floor(Math.random() * MOCK_CODES.length)],
      humidity: Math.round(20 + Math.random() * 70),
      wind_speed: Math.round(Math.random() * 30),
      wind_dir: 'NW',
      uv_index: Math.round(Math.random() * 9),
    },
  };
}

async function fetchAllCities() {
  const results = [];
  let calls = 0;
  let fatal = null;

  async function fetchCity(city) {
    calls++; // count failures too - better to over-count than to exceed the quota
    return fetchCurrent(`${city.lat},${city.lon}`);
  }

  for (const city of CITIES) {
    if (fatal) {
      results.push({ ...city, error: fatal.message });
      continue;
    }
    try {
      if (MOCK) {
        results.push(normalize(city, mockResponse(city)));
        continue;
      }
      if (calls) await sleep(REQUEST_DELAY_MS);
      let raw;
      try {
        raw = await fetchCity(city);
      } catch (err) {
        if (!isRateLimit(err)) throw err;
        await sleep(RATE_LIMIT_RETRY_MS); // one retry after a longer pause
        raw = await fetchCity(city);
      }
      results.push(normalize(city, raw));
    } catch (err) {
      if (FATAL_CODES.has(err.code)) fatal = err;
      results.push({ ...city, error: err.message });
    }
  }

  await addUsage(calls);

  if (fatal) throw new HttpError(502, fatal.message);
  if (results.every((r) => r.error)) throw new HttpError(502, results[0].error);
  return results;
}

async function refresh() {
  if (!MOCK) {
    if (!hasApiKey()) throw new HttpError(500, 'חסר מפתח API – הוסיפי WEATHERSTACK_API_KEY לקובץ ‎.env');
    const { calls } = await getUsage();
    const left = MONTHLY_LIMIT - calls;
    if (left < CITIES.length) {
      throw new HttpError(429, `אין מספיק קריאות החודש: רענון דורש ${CITIES.length}, נשארו ${Math.max(left, 0)}`);
    }
  }
  const data = { updatedAt: Date.now(), cities: await fetchAllCities() };
  data.airtable = await syncAirtable(data);
  await writeJson(CACHE_FILE, data);
  return data;
}

// A failed sync must not break the dashboard - report it alongside the data instead
async function syncAirtable(data) {
  if (MOCK) return { status: 'skipped', reason: 'mock' };
  if (!hasAirtableConfig()) return { status: 'skipped', reason: 'missing AIRTABLE_* in .env' };
  try {
    const synced = await syncToAirtable(data);
    console.log(`Airtable: ${synced} rows synced`);
    return { status: 'ok', synced };
  } catch (err) {
    console.error(err.message);
    return { status: 'error', error: err.message };
  }
}

// Prevent two simultaneous refreshes from spending the quota twice
let refreshing = null;
function refreshOnce() {
  refreshing ??= refresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function withMeta(data, extra = {}) {
  const { calls } = await getUsage();
  return {
    ...data,
    ...extra,
    mock: MOCK,
    usage: { calls, limit: MONTHLY_LIMIT, perRefresh: CITIES.length },
  };
}

export const USE_AIRTABLE = !MOCK && hasAirtableConfig();

// Dashboard data straight from the Airtable table. The local clock uses the table's "UTC Offset",
// falling back to the last refresh, then to an estimate from the longitude.
async function fromAirtable(cache) {
  const offsets = new Map(cache?.cities?.map((c) => [c.id, c.utcOffset]));
  const rows = await readFromAirtable();
  const cities = rows.map(({ lastUpdated, ...c }) => ({
    ...c,
    utcOffset: c.utcOffset ?? offsets.get(c.id) ?? Math.round((c.lon ?? 0) / 15),
  }));
  // Prefer the table's own "Updated At" column when it exists
  const lastUpdated = Math.max(0, ...rows.map((r) => r.lastUpdated ?? 0));
  return { updatedAt: lastUpdated || cache?.updatedAt || null, cities };
}

// GET: the table is the source of truth; the local cache is only a fallback
async function getWeather() {
  let cache = await readJson(CACHE_FILE);
  if (!USE_AIRTABLE) {
    if (cache) return withMeta(cache, { source: 'cache' });
    return withMeta(await refreshOnce(), { source: 'live' });
  }
  try {
    let data = await fromAirtable(cache);
    if (!data.cities.length) {
      // Empty table: fill it once from Weatherstack, then read it back
      cache = await refreshOnce();
      data = await fromAirtable(cache);
    }
    return withMeta(data, { source: 'airtable' });
  } catch (err) {
    if (err instanceof HttpError || !cache) throw err;
    console.error(err.message);
    return withMeta(cache, { source: 'cache', warning: `לא ניתן לקרוא מאיירטייבל – מוצגים נתונים שמורים (${err.message})` });
  }
}

// POST: explicit refresh from the dashboard button
async function forceRefresh() {
  const cache = await readJson(CACHE_FILE);
  // Allow an early retry when the last refresh left some cities without data
  let complete = cache?.cities?.every((c) => !c.error);
  let lastUpdate = cache?.updatedAt;
  if (!cache && USE_AIRTABLE) {
    // No local cache (e.g. a fresh Vercel instance): use the table's "Updated At" column
    lastUpdate = (await fromAirtable(null).catch(() => null))?.updatedAt;
    complete = Boolean(lastUpdate);
  }
  if (complete && Date.now() - lastUpdate < MIN_REFRESH_MINUTES * 60_000) {
    throw new HttpError(429, `הנתונים עודכנו לפני פחות מ-${MIN_REFRESH_MINUTES} דקות – אין צורך לרענן עדיין`);
  }
  const fresh = await refreshOnce();
  if (!USE_AIRTABLE || fresh.airtable?.status !== 'ok') return withMeta(fresh, { source: 'live' });
  // Show what actually landed in the table
  return withMeta(await fromAirtable(fresh), { source: 'airtable', airtable: fresh.airtable });
}

// --- API handler: used by the local server and by the Vercel functions in api/ ---

export function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export async function handleApi(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && pathname === '/api/weather') return sendJson(res, 200, await getWeather());
    if (req.method === 'POST' && pathname === '/api/refresh') return sendJson(res, 200, await forceRefresh());
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err.status ?? 500;
    if (status === 500) console.error(err);
    sendJson(res, status, await withMeta({}, { error: err.message }));
  }
}
