// TTC stops as mapped in OpenStreetMap. The TTC drops a stop from its live data and its
// schedule while it's out of service (for example during a construction diversion), so OSM
// is the only place that still says where the regular stop is. The page shows such stops as
// "not in service" when a route's direction is missing there.
const fs = require('node:fs/promises');
const path = require('node:path');
const { metres } = require('./geo');
const { getAlertsData, isActiveNow } = require('./alerts');
const { liveRoute } = require('./observer');

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const BBOX = '43.57,-79.65,43.87,-79.10';                 // City of Toronto, with a margin
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'osm-stops.json');
const MAX_AGE_MS = 24 * 3600 * 1000;
const NEAR_ROUTE_M = 150;

const QUERY = `[out:json][timeout:90];
(node["highway"="bus_stop"](${BBOX});node["railway"="tram_stop"](${BBOX});node["public_transport"="platform"](${BBOX}););
out body;`;

// Keep TTC stops: tagged as TTC, or untagged (most Toronto stops are TTC). Skip other agencies.
const OTHER = /\b(go transit|metrolinx|yrt|york region|miway|mississauga|brampton|durham|drt|up express)\b/i;
function isTtc(t) {
  const who = `${t.network || ''} ${t.operator || ''}`;
  if (/ttc|toronto transit/i.test(who)) return true;
  return !OTHER.test(who) && !t.network && !t.operator;
}

async function fetchStops() {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'ttc-stop-map (detour checker)' },
    body: 'data=' + encodeURIComponent(QUERY),
  });
  if (!res.ok) throw new Error(`Overpass returned HTTP ${res.status}`);
  const json = await res.json();
  const stops = (json.elements || []).filter(e => e.type === 'node' && e.tags && isTtc(e.tags)).map(e => ({
    id: e.id, lat: e.lat, lon: e.lon, name: e.tags.name || '', ref: e.tags.ref || '',
    routeRef: e.tags.route_ref || '', disused: !!(e.tags.disused || e.tags['disused:highway']),
  }));
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), stops }));
  return stops;
}

let cache = null, loading = null;
async function getOsmStops() {
  if (cache && Date.now() - cache.at < MAX_AGE_MS) return cache.stops;
  if (!loading) loading = (async () => {
    try {
      const saved = JSON.parse(await fs.readFile(FILE, 'utf8'));
      if (Date.now() - Date.parse(saved.fetchedAt) < MAX_AGE_MS) return saved.stops;
    } catch { /* nothing saved yet */ }
    try { return await fetchStops(); }
    catch (e) {
      try { return JSON.parse(await fs.readFile(FILE, 'utf8')).stops; } catch { throw e; }   // stale beats nothing
    }
  })().then(stops => { cache = { at: Date.now(), stops }; return stops; }).finally(() => { loading = null; });
  return loading;
}

// OSM stops near routes that have a service change now. The page decides which of them are
// out of service (no live stop there, and a direction missing).
async function getCandidates() {
  const [osm, alertsData] = await Promise.all([getOsmStops(), getAlertsData()]);
  const routes = [...new Set((alertsData?.routes || [])
    .filter(a => a.effect && a.effect !== 'NO_EFFECT' && isActiveNow(a) && /^\d+$/.test(a.route) && +a.route >= 7)
    .map(a => a.route))];
  const live = [];
  for (const r of routes) {
    try { for (const s of (await liveRoute(r)).stops.values()) live.push([s.lat, s.lon]); } catch { /* skip route */ }
  }
  // Coarse grid so this stays fast with ~10k OSM stops.
  const cell = p => Math.floor(p[0] / 0.002) + ',' + Math.floor(p[1] / 0.0027);
  const grid = new Map();
  for (const p of live) { const k = cell(p); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); }
  const near = s => {
    const [a, b] = cell([s.lat, s.lon]).split(',').map(Number);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++)
      for (const p of grid.get((a + i) + ',' + (b + j)) || []) if (metres([s.lat, s.lon], p) <= NEAR_ROUTE_M) return true;
    return false;
  };
  return { fetchedAt: new Date().toISOString(), routes, stops: osm.filter(near) };
}

// A route's usual path as mapped in OpenStreetMap (route relations). Mappers record the
// regular routing, not temporary diversions, so this is the best "normal" for long-running
// diversions that the TTC has already written into its schedule. Null if unavailable.
const relCache = new Map();
async function getRouteRelation(ref) {
  if (!/^\d{1,4}$/.test(ref)) return null;
  const hit = relCache.get(ref);
  if (hit && Date.now() - hit.at < MAX_AGE_MS) return hit.lines;
  const q = `[out:json][timeout:60];relation["type"="route"]["route"~"^(bus|tram|trolleybus)$"]["ref"="${ref}"](${BBOX});out geom;`;
  try {
    const res = await fetch(OVERPASS, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'ttc-stop-map (detour checker)' },
      body: 'data=' + encodeURIComponent(q),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const lines = (json.elements || []).filter(e => e.type === 'relation' && isTtc(e.tags || {}))
      .flatMap(e => (e.members || []).filter(m => m.type === 'way' && m.geometry?.length > 1).map(m => m.geometry.map(g => [g.lat, g.lon])));
    relCache.set(ref, { at: Date.now(), lines: lines.length ? lines : null });
    return lines.length ? lines : null;
  } catch {
    relCache.set(ref, { at: Date.now() - MAX_AGE_MS + 15 * 60 * 1000, lines: null });   // retry in 15 minutes
    return null;
  }
}

module.exports = { getCandidates, getOsmStops, getRouteRelation };
