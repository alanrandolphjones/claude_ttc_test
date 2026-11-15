// Serves the map and relays TTC service alerts, which the TTC doesn't allow
// browsers to fetch directly (no CORS headers). No dependencies: `node server.js`.
//
// /api/alerts combines two TTC feeds into one list:
//   - alerts.ttc.ca: live incidents (collisions, same-day detours) with the exact stops skipped.
//   - gtfsrt.ttc.ca: GTFS-realtime alerts, which also carry planned service changes
//     (construction diversions, replacement buses, events) that the first feed leaves out.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORT = process.env.PORT || 8000;
const ROOT = __dirname;
const LIVE_URL = 'https://alerts.ttc.ca/api/alerts/live-alerts';
const GTFSRT_URL = 'https://gtfsrt.ttc.ca/alerts/all?format=text';
const CACHE_MS = 60 * 1000;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const PUBLIC = new Set(['/index.html']);   // only serve the page itself, not server code

// ---- Protobuf text format -> plain objects ---------------------------------
// Every field becomes an array, since any of them may repeat.
function parseTextproto(src) {
  const re = /\s*(?:([A-Za-z_][\w]*)\s*(\{|:\s*("(?:[^"\\]|\\.)*"|[^\s{}]+))|(\}))/y;
  const root = {}, stack = [root];
  let m;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    const cur = stack[stack.length - 1];
    if (m[4]) { stack.pop(); continue; }
    const [, key, brace, raw] = m;
    let val;
    if (brace === '{') { val = {}; stack.push(val); }
    else if (raw[0] === '"') val = JSON.parse(raw.replace(/\\'/g, "'"));
    else val = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    (cur[key] ||= []).push(val);
  }
  return root;
}

const text = t => t?.[0]?.translation?.find(x => (x.language?.[0] || 'en') === 'en')?.text?.[0] ?? '';
const EFFECT_DESC = { DETOUR: 'Detour', NO_SERVICE: 'No service', REDUCED_SERVICE: 'Reduced service',
  SIGNIFICANT_DELAYS: 'Delays', MODIFIED_SERVICE: 'Service change', STOP_MOVED: 'Stop moved',
  ADDITIONAL_SERVICE: 'Additional service', OTHER_EFFECT: 'Service alert', ACCESSIBILITY_ISSUE: 'Accessibility' };

// One record per route, in the same shape as alerts.ttc.ca's `routes` entries.
function normalizeGtfsrt(feed) {
  const out = [];
  for (const e of feed.entity || []) {
    const a = e.alert?.[0];
    if (!a) continue;
    const effect = a.effect?.[0] || 'UNKNOWN_EFFECT';
    if (effect === 'ACCESSIBILITY_ISSUE') continue;          // elevators/escalators: not about vehicles
    const byRoute = new Map();
    for (const ie of a.informed_entity || []) {
      const r = ie.route_id?.[0];
      if (r == null || r === '') continue;
      if (!byRoute.has(r)) byRoute.set(r, []);
      const s = ie.stop_id?.[0];
      if (s != null && s !== '') byRoute.get(r).push(String(s));
    }
    const periods = (a.active_period || []).map(p => ({
      start: p.start ? new Date(p.start[0] * 1000).toISOString() : null,
      end: p.end ? new Date(p.end[0] * 1000).toISOString() : null,
    }));
    const description = text(a.description_text);
    for (const [route, stops] of byRoute) {
      out.push({
        id: String(e.id?.[0] ?? ''), source: 'gtfsrt', route: String(route), stops,
        effect, effectDesc: EFFECT_DESC[effect] || 'Service alert',
        headerText: text(a.header_text), title: text(a.header_text), description,
        url: text(a.url), direction: '', cause: a.cause?.[0] || '', activePeriods: periods,
        activePeriod: periods[0] || { start: null, end: null },
        shuttleType: /replacement bus|shuttle/i.test(description) ? 'Replacement buses' : null,
      });
    }
  }
  return out;
}

// ---- Fetch + cache ---------------------------------------------------------
let cache = { at: 0, body: null };

async function getText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${new URL(url).host} returned HTTP ${res.status}`);
  return res.text();
}

async function getAlerts() {
  if (cache.body && Date.now() - cache.at < CACHE_MS) return cache.body;
  const [live, rt] = await Promise.allSettled([getText(LIVE_URL), getText(GTFSRT_URL)]);
  if (live.status === 'rejected' && rt.status === 'rejected') throw live.reason;

  const liveRoutes = live.status === 'fulfilled'
    ? (JSON.parse(live.value).routes || []).map(a => ({ ...a, source: 'live' })) : [];
  // The GTFS-realtime feed repeats the live alerts under the same ids; keep the live
  // version (it has direction and shuttle details) and add everything else.
  const liveIds = new Set(liveRoutes.map(a => String(a.id)));
  const planned = rt.status === 'fulfilled'
    ? normalizeGtfsrt(parseTextproto(rt.value)).filter(a => !liveIds.has(a.id)) : [];

  const body = JSON.stringify({
    fetchedAt: new Date().toISOString(),
    sources: { live: live.status === 'fulfilled', gtfsrt: rt.status === 'fulfilled' },
    routes: [...liveRoutes, ...planned],
  });
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
