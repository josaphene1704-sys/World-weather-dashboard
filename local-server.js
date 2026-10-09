// Local weather dashboard server: serves the page and the API from lib/dashboard.js.
// On Vercel the same API runs as functions in api/ and the page is served from public/.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, sendJson, MOCK, USE_AIRTABLE } from './lib/dashboard.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/')) return handleApi(req, res);
  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(await readFile(path.join(ROOT, 'public', 'index.html')));
  }
  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`🌍 Weather dashboard: http://localhost:${PORT}${MOCK ? '  (MOCK mode - no API calls)' : ''}`);
  if (USE_AIRTABLE) console.log('📋 Reading dashboard data from Airtable');
});
