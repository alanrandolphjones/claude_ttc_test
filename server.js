// Serves the map and the data the browser can't fetch from the TTC directly
// (no CORS headers). No dependencies: `node server.js`.
//
//   /api/alerts        live incidents (alerts.ttc.ca) + planned changes (GTFS-realtime), merged
//   /api/detours       detour paths from the TTC's GTFS-realtime trip modifications feed
//   /api/observations  what the background observer has learned about feeds disagreeing (?days=N)
//
// Set OBSERVE=0 to turn the observer off, OBSERVE_EVERY_MIN to change how often it runs.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { getAlerts, staleAlerts } = require('./lib/alerts');
const { getDetours } = require('./lib/detours');
const observer = require('./lib/observer');

const PORT = process.env.PORT || 8000;
const ROOT = __dirname;
const PUBLIC = new Set(['/index.html']);   // only serve the page itself, not server code or data

function send(res, status, body, type = 'application/json', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', ...extra });
  res.end(body);
}

const API = {
  '/healthz': async () => JSON.stringify({ ok: true, observer: observer.status() }),
  '/api/alerts': async () => getAlerts(),
  '/api/detours': async () => JSON.stringify(await getDetours()),
  '/api/observations': async url => JSON.stringify({
    status: observer.status(),
    routes: await observer.summarize(Math.min(31, Math.max(1, +url.searchParams.get('days') || 1))),
  }),
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const api = API[url.pathname];
  try {
    if (api) return send(res, 200, await api(url), 'application/json', { 'cache-control': 'public, max-age=30' });
    const file = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!PUBLIC.has(file)) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, await fs.readFile(path.join(ROOT, file)), 'text/html; charset=utf-8');
  } catch (e) {
    // Serve stale alerts rather than nothing if the TTC is briefly unreachable.
    if (url.pathname === '/api/alerts' && staleAlerts()) return send(res, 200, staleAlerts(), 'application/json', { 'x-stale': '1' });
    send(res, 502, e.message, 'text/plain');
  }
}).listen(PORT, () => {
  console.log(`TTC stop map on http://localhost:${PORT}`);
  if (process.env.OBSERVE !== '0') observer.start(+process.env.OBSERVE_EVERY_MIN || 5);
});
