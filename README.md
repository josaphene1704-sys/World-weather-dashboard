# 🌍 World Weather Dashboard

דאשבורד שמציג את מזג האוויר הנוכחי בבירות של 21 מדינות גדולות בעולם, על בסיס [Weatherstack API](https://weatherstack.com).

## Features
- Weather card per country: temperature, feels-like, humidity, wind and live local time
- Summary: hottest, coldest, average and most humid
- Search, continent filter and sorting
- Hebrew RTL UI, mobile friendly, dark mode
- Disk cache + monthly API-call counter to stay within the free plan (100 calls/month)

## Setup
1. Copy `.env.example` to `.env` and add your Weatherstack key:
   ```
   WEATHERSTACK_API_KEY=your_api_key_here
   ```
2. Run (Node.js 22+, no dependencies to install):
   ```bash
   npm run dashboard        # real data  -> http://localhost:3000
   npm run dashboard:mock   # fake data, zero API calls
   npm start -- "Paris"     # single city in the terminal
   ```

## Notes
- The API key stays on the local server and is never sent to the browser.
- Each refresh costs one call per country (21 calls). Data is cached in `data/` and refreshed only via the button.
