// Detour paths from the TTC's GTFS-realtime trip modifications feed. Each entry carries the
// whole detoured trip's shape; the detour itself is the part that leaves the route's normal
// path (from the published schedule).
const { decodePolyline } = require('./geo');
const { getSchedule } = require('./gtfs');

const DETOUR_URL = 'https://gtfsrt.ttc.ca/trips/detour?format=text';   // despite the name, this is JSON
const CACHE_MS = 5 * 60 * 1000;
const OFF_ROUTE_M = 40;

// "detour_22_798:0_0_2036_504_Broadview and Queen" -> { route: "504", headsign: "Broadview and Queen" }
function parseId(id) {
  const parts = String(id).replace(/_shape$/, '').split('_');
  return { route: parts[5] || '', headsign: parts.slice(6).join('_') };
}

// Runs of consecutive points off the normal path, each padded by one point so it joins the route.
function offRuns(points, index) {
  if (!index) return [points];
  const off = points.map(p => index.dist(p[0], p[1]) > OFF_ROUTE_M);
  const runs = [];
  for (let i = 0; i < points.length; i++) {
    if (!off[i]) continue;
    let j = i;
    while (j + 1 < points.length && off[j + 1]) j++;
    runs.push(points.slice(Math.max(0, i - 1), Math.min(points.length, j + 2)));
    i = j;
  }
  return runs;
}

let cache = { at: 0, data: null };

async function getDetours() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const res = await fetch(DETOUR_URL);
  if (!res.ok) throw new Error(`TTC detour feed returned HTTP ${res.status}`);
  const feed = await res.json();
  const schedule = await getSchedule().catch(() => null);

  const shapes = new Map();
  for (const e of feed.entity || []) if (e.shape) shapes.set(e.shape.shapeId || e.id, e.shape.encodedPolyline);

  const byKey = new Map();
  for (const e of feed.entity || []) {
    const tm = e.tripModifications;
    if (!tm) continue;
    const { route, headsign } = parseId(e.id);
    for (const sel of tm.selectedTrips || []) {
      const poly = shapes.get(sel.shapeId);
      if (!poly) continue;
      const key = route + '|' + poly;
      if (!byKey.has(key)) byKey.set(key, { route, headsigns: new Set(), dates: new Set(), poly });
      const d = byKey.get(key);
      d.headsigns.add(headsign);
      (tm.serviceDates || []).forEach(x => d.dates.add(x));
    }
  }

  // Several trip patterns usually share the same detour section: merge identical sections.
  const merged = new Map();
  for (const d of byKey.values()) {
    const index = schedule?.normalIndex(d.route) || null;
    for (const seg of offRuns(decodePolyline(d.poly), index)) {
      const round = seg.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]);
      const key = d.route + '|' + JSON.stringify(round);
      if (!merged.has(key)) merged.set(key, { route: d.route, headsigns: new Set(), dates: new Set(), path: round, normalKnown: !!index });
      const m = merged.get(key);
      d.headsigns.forEach(h => m.headsigns.add(h));
      d.dates.forEach(x => m.dates.add(x));
    }
  }

  const data = {
    fetchedAt: new Date().toISOString(),
    scheduleLoaded: !!schedule,
    detours: [...merged.values()].map(m => ({
      route: m.route, headsigns: [...m.headsigns].sort(), serviceDates: [...m.dates].sort(),
      path: m.path, normalKnown: m.normalKnown,
    })),
  };
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { getDetours };
