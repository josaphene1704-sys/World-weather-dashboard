// Shared Weatherstack client - used by the CLI script and the dashboard server.

const API_KEY = process.env.WEATHERSTACK_API_KEY;
const HTTPS_RESTRICTED = 105;
// Try HTTPS first; fall back to HTTP if the plan doesn't allow it.
let protocol = 'https';

const HEBREW_ERRORS = {
  101: 'מפתח ה-API חסר או לא תקין – בדקי את קובץ ‎.env',
  102: 'החשבון ב-Weatherstack לא פעיל',
  104: 'נגמרה מכסת הקריאות החודשית של Weatherstack – אפשר יהיה לרענן שוב בתחילת החודש הבא. מוצגים הנתונים האחרונים מהטבלה.',
  615: 'הבקשה ל-Weatherstack נכשלה – נסי שוב מאוחר יותר',
};

export class WeatherstackError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function hasApiKey() {
  return Boolean(API_KEY) && API_KEY !== 'your_api_key_here';
}

// query: city name ("Tel Aviv") or coordinates ("32.08,34.78")
export async function fetchCurrent(query) {
  if (!hasApiKey()) throw new WeatherstackError(101, HEBREW_ERRORS[101]);

  const url = new URL(`${protocol}://api.weatherstack.com/current`);
  url.searchParams.set('access_key', API_KEY);
  url.searchParams.set('query', query);
  url.searchParams.set('units', 'm'); // metric: Celsius, km/h

  const data = await (await fetch(url)).json();

  // Weatherstack returns HTTP 200 even on errors, with an "error" object
  if (data.error) {
    if (data.error.code === HTTPS_RESTRICTED && protocol === 'https') {
      protocol = 'http';
      return fetchCurrent(query);
    }
    throw new WeatherstackError(data.error.code, HEBREW_ERRORS[data.error.code] ?? data.error.info);
  }
  return data;
}
