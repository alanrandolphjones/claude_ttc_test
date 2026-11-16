// Route lines for the map.
//   getNetwork(): every bus and streetcar route, from the published schedule, simplified.
//   getRoute(r):  one route's live path, plus where it differs from the regular route:
//                 "changed"   = live path that isn't on the regular route (a diversion),
//                 "notServed" = regular route that the live path doesn't cover.
const { getSchedule } = require('./gtfs');
const { liveRoute } = require('./observer');
const { getRouteRelation } = require('./osm');
const { PathIndex, encodePolyline, simplify, offRuns, metres } = require('./geo');

// Add points so no gap exceeds `step` metres; off-route checks look at points only.
function densify(line, step = 25) {
  const out = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], n = Math.floor(metres(a, b) / step);
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / (n + 1), a[1] + (b[1] - a[1]) * k / (n + 1)]);
    out.push(b);
  }
  return out;
}

// A route's shapes overlap heavily (branches, short turns): keep only the parts not already drawn.
function dedupe(lines, tol = 15) {
  const kept = [];
  let idx = null;
  for (const l of [...lines].sort((a, b) => b.length - a.length)) {
    const d = densify(l);
    const parts = idx ? offRuns([d], idx, tol, 60) : [d];
    if (!parts.length) continue;
    kept.push(...parts);
    idx = new PathIndex(kept);
  }
  return kept;
}

let network = null;
async function getNetwork() {
  const schedule = await getSchedule();
  if (network && network.loadedAt === schedule.loadedAt) return network.body;
  const routes = [];
  for (const r of schedule.routes) {
    const type = schedule.routeTypes.get(r);
    if (type !== '3' && type !== '0') continue;                 // buses and streetcars only
    const lines = dedupe(schedule.routeLines(r)).map(l => encodePolyline(simplify(l, 8)));
    if (lines.length) routes.push({ r, t: type === '0' ? 'streetcar' : 'bus', lines });
  }
  network = { loadedAt: schedule.loadedAt, body: JSON.stringify({ scheduleDate: schedule.loadedAt, routes }) };
  return network.body;
}

const routeCache = new Map();
async function getRoute(r) {
  const hit = routeCache.get(r);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.body;
  const [live, schedule, osm] = await Promise.all([liveRoute(r), getSchedule().catch(() => null), getRouteRelation(r)]);
  const liveLines = dedupe(live.lines);
  // Prefer OpenStreetMap's usual route: the TTC writes long-running diversions into its schedule.
  const normalLines = osm ? dedupe(osm) : schedule ? dedupe(schedule.routeLines(r)) : null;
  const normalIdx = normalLines?.length ? new PathIndex(normalLines) : null;
  const liveIdx = new PathIndex(liveLines);
  const enc = ls => ls.map(l => encodePolyline(simplify(l, 5)));
  const body = JSON.stringify({
    route: r, title: live.title, fetchedAt: new Date().toISOString(),
    normalSource: osm ? 'openstreetmap' : normalIdx ? 'schedule' : null,
    live: enc(liveLines),
    changed: normalIdx ? enc(offRuns(liveLines, normalIdx, 35, 120)) : [],
    notServed: normalIdx ? enc(offRuns(normalLines, liveIdx, 35, 120)) : [],
  });
  routeCache.set(r, { at: Date.now(), body });
  return body;
}

module.exports = { getNetwork, getRoute };
