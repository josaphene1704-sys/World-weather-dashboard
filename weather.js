// Fetch current weather for one city from the Weatherstack API.
// Usage: npm start -- "Tel Aviv"   (defaults to Tel Aviv)

import { fetchCurrent } from './weatherstack.js';

const city = process.argv[2] || 'Tel Aviv';

try {
  const { location, current } = await fetchCurrent(city);
  console.log(`📍 ${location.name}, ${location.country} (${location.localtime})`);
  console.log(`🌡️  ${current.temperature}°C (feels like ${current.feelslike}°C)`);
  console.log(`☁️  ${current.weather_descriptions.join(', ')}`);
  console.log(`💧 Humidity: ${current.humidity}%   💨 Wind: ${current.wind_speed} km/h`);
} catch (err) {
  console.error('❌', err.message);
  process.exit(1);
}
