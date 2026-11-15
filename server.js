// Serves the map and relays TTC service alerts, which the TTC doesn't allow
// browsers to fetch directly (no CORS headers). No dependencies: `node server.js`.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORT = process.env.PORT || 8000;
const ROOT = __dirname;
const ALERTS_URL = 'https://alerts.ttc.ca/api/alerts/live-alerts';
const CACHE_MS = 60 * 1000;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const PUBLIC = new Set(['/index.html']);   // only serve the page itself, not server code

let cache = { at: 0, body: null };

async function getAlerts() {
  if (cache.body && Date.now() - cache.at < CACHE_MS) return cache.body;
  const res = await fetch(ALERTS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`TTC alerts returned HTTP ${res.status}`);
  const body = await res.text();
  JSON.parse(body);                         // don't cache garbage
  cache = { at: Date.now(), body };
  return body;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/alerts') {
      const body = await getAlerts();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=30',
        'access-control-allow-origin': '*' });
      return res.end(body);
    }
    const file = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!PUBLIC.has(file)) { res.writeHead(404); return res.end('Not found'); }
    const data = await fs.readFile(path.join(ROOT, file));
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    // Serve stale alerts rather than nothing if the TTC is briefly unreachable.
    if (url.pathname === '/api/alerts' && cache.body) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-stale': '1' });
      return res.end(cache.body);
    }
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(e.message);
  }
}).listen(PORT, () => console.log(`TTC stop map on http://localhost:${PORT}`));
