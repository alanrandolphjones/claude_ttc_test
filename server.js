// Serves the map and the data the browser can't fetch from the TTC directly
// (no CORS headers). No dependencies: `node server.js`.
//
//   /api/alerts        live incidents (alerts.ttc.ca) + planned changes (GTFS-realtime), merged
//   /api/detours       detour paths from the TTC's GTFS-realtime trip modifications feed
//   /api/osm-stops     OpenStreetMap stops near routes with service changes (for out-of-service stops)
//   /api/detour-stops  stops detoured trips actually serve (GTFS-realtime modified trip updates)
//   /api/network       every bus/streetcar route line (from the schedule), for drawing the network
//   /api/route?r=N     one route's live path and where it differs from the regular route
//   /api/observations  what the background observer has learned about feeds disagreeing (?days=N)
//
// Set OBSERVE=0 to turn the observer off, OBSERVE_EVERY_MIN to change how often it runs.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { getAlerts, staleAlerts } = require('./lib/alerts');
const { getDetours } = require('./lib/detours');
const observer = require('./lib/observer');
const { getCandidates, osmStatus } = require('./lib/osm');
const { getNetwork, getRoute } = require('./lib/routes');
const { getDetourStops } = require('./lib/detourstops');
const zlib = require('node:zlib');

const PORT = process.env.PORT || 8000;
const ROOT = __dirname;
const PUBLIC = new Set(['/index.html']);   // only serve the page itself, not server code or data

function send(res, status, body, type = 'application/json', extra = {}) {
  const headers = { 'content-type': type, 'access-control-allow-origin': '*', vary: 'accept-encoding', ...extra };
  // Compress text responses (the route network is a few hundred KB) when the browser allows it.
  if (body && body.length > 1024 && /gzip/.test(res.req?.headers['accept-encoding'] || '') && /json|text|html/.test(type)) {
    headers['content-encoding'] = 'gzip';
    body = zlib.gzipSync(body);
  }
  res.writeHead(status, headers);
  res.end(body);
}

const API = {
  '/healthz': async () => JSON.stringify({ ok: true, observer: observer.status(), openstreetmap: osmStatus() }),
  '/api/alerts': async () => getAlerts(),
  '/api/detours': async () => JSON.stringify(await getDetours()),
  '/api/osm-stops': async () => JSON.stringify(await getCandidates()),
  '/api/network': async () => getNetwork(),
  '/api/detour-stops': async () => JSON.stringify(await getDetourStops()),
  '/api/route': async url => {
    const r = url.searchParams.get('r') || '';
    if (!/^\d{1,4}$/.test(r)) throw Object.assign(new Error('Unknown route'), { status: 400 });
    return getRoute(r);
  },
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
    // no-cache: browsers check for a newer page each time, so updates show up on reload.
    send(res, 200, await fs.readFile(path.join(ROOT, file)), 'text/html; charset=utf-8', { 'cache-control': 'no-cache' });
  } catch (e) {
    // Serve stale alerts rather than nothing if the TTC is briefly unreachable.
    if (url.pathname === '/api/alerts' && staleAlerts()) return send(res, 200, staleAlerts(), 'application/json', { 'x-stale': '1' });
    send(res, e.status || 502, e.message, 'text/plain');
  }
}).listen(PORT, () => {
  console.log(`TTC stop map on http://localhost:${PORT}`);
  if (process.env.OBSERVE !== '0') observer.start(+process.env.OBSERVE_EVERY_MIN || 5);
});
