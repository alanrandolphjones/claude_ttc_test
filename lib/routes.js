// Route lines for the map.
//   getNetwork(): every bus and streetcar route, from the published schedule, simplified.
//   getRoute(r):  one route's live path, plus where it differs from the regular route:
//                 "changed"   = live path that isn't on the regular route (a diversion),
//                 "notServed" = regular route that the live path doesn't cover.
const { getSchedule } = require('./gtfs');
const { liveRoute } = require('./observer');
const { getRouteRelation } = require('./osm');
const { PathIndex, encodePolyline, simplify, offRuns, dedupe, densify, metres } = require('./geo');

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

// Split lines into runs by a per-point label.
function splitBy(lines, label) {
  const out = {};
  for (const line of lines) {
    let cur = null, run = [];
    for (const p of line) {
      const l = label(p);
      if (l !== cur && run.length) { (out[cur] ||= []).push([...run, p]); run = []; }
      cur = l; run.push(p);
    }
    if (run.length > 1) (out[cur] ||= []).push(run);
  }
  return out;
}

// ---- Tracing a direction along the path network ---------------------------------------
// Path pieces become an undirected graph; a direction's path is the shortest way along it
// from each stop to the next.
function buildGraph(lines) {
  const ids = new Map(), pts = [], adj = [];
  const id = p => {
    const k = p[0].toFixed(5) + ',' + p[1].toFixed(5);
    let i = ids.get(k);
    if (i === undefined) { i = pts.length; ids.set(k, i); pts.push(p); adj.push([]); }
    return i;
  };
  const link = (a, b) => { if (a === b) return; const w = metres(pts[a], pts[b]); adj[a].push([b, w]); adj[b].push([a, w]); };
  for (const l of lines) for (let i = 1; i < l.length; i++) link(id(l[i - 1]), id(l[i]));
  // Join path pieces whose ends don't quite meet (within 15 m).
  const cell = p => Math.floor(p[0] / 0.0002) + ',' + Math.floor(p[1] / 0.00027);
  const grid = new Map();
  pts.forEach((p, i) => { const k = cell(p); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  pts.forEach((p, i) => {
    const [a, b] = cell(p).split(',').map(Number);
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++)
      for (const j of grid.get((a + x) + ',' + (b + y)) || []) if (j > i && metres(p, pts[j]) <= 15) link(i, j);
  });
  return { pts, adj };
}

function nearestNode(g, p) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < g.pts.length; i++) { const d = metres(p, g.pts[i]); if (d < bd) { bd = d; best = i; } }
  return bd <= 80 ? best : -1;
}

function shortest(g, s, t) {
  const dist = new Float64Array(g.pts.length).fill(Infinity), prev = new Int32Array(g.pts.length).fill(-1);
  dist[s] = 0;
  const heap = [[0, s]];
  const push = x => { heap.push(x); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  while (heap.length) {
    const [d, u] = pop();
    if (u === t) break;
    if (d > dist[u]) continue;
    for (const [v, w] of g.adj[u]) if (d + w < dist[v]) { dist[v] = d + w; prev[v] = u; push([d + w, v]); }
  }
  if (!Number.isFinite(dist[t])) return null;
  const out = [];
  for (let u = t; u !== -1; u = prev[u]) out.push(g.pts[u]);
  return out.reverse();
}

function tracePath(g, stopPts) {
  const nodes = stopPts.map(p => nearestNode(g, p)).filter(i => i >= 0);
  const line = [];
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i] === nodes[i - 1]) continue;
    const seg = shortest(g, nodes[i - 1], nodes[i]) || [g.pts[nodes[i - 1]], g.pts[nodes[i]]];
    line.push(...(line.length ? seg.slice(1) : seg));
  }
  return line;
}

async function getRoute(r) {
  const hit = routeCache.get(r);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.body;
  const [live, schedule, osm] = await Promise.all([liveRoute(r), getSchedule().catch(() => null), getRouteRelation(r)]);
  const streetcar = schedule?.routeTypes.get(r) === '0';
  let carLines = dedupe(live.lines), busLines = [];

  // Streetcar routes run replacement buses on their own branches ("506b ... Replacement Bus").
  // The live paths aren't labelled by branch, so trace each direction along them, stop to stop:
  // that gives each branch's exact streets, both ways.
  if (streetcar) {
    const isBus = d => /\bbus\b/i.test(d.title);
    if (live.dirs.some(isBus) && live.dirs.some(d => !isBus(d))) {
      const g = buildGraph(live.lines);
      // Two-way streets often have a path per side (Spadina's median): draw one line per street.
      carLines = dedupe(live.dirs.filter(d => !isBus(d)).map(d => tracePath(g, d.pts)).filter(l => l.length > 1), 30);
      busLines = dedupe(live.dirs.filter(isBus).map(d => tracePath(g, d.pts)).filter(l => l.length > 1), 30);
    }
  }

  // What counts as the regular route:
  //  - streetcars: OpenStreetMap's route (tracks are carefully mapped), because the TTC writes
  //    long-running diversions into its schedule, so the schedule can't show them;
  //  - buses: OSM bus routes are often incomplete, so "off the regular route" means off both
  //    OSM and the schedule, and "not served" is measured against the schedule.
  const schedLines = schedule ? dedupe(schedule.routeLines(r)) : [];
  const osmLines = osm ? dedupe(osm) : [];
  const useOsm = streetcar && osmLines.length;
  const changedRef = useOsm ? osmLines : [...osmLines, ...schedLines];
  const servedRef = useOsm ? osmLines : schedLines.length ? schedLines : osmLines;
  const changedIdx = changedRef.length ? new PathIndex(changedRef) : null;
  const carIdx = carLines.length ? new PathIndex(carLines) : null;
  const busIdx = busLines.length ? new PathIndex(busLines) : null;
  const normalIdx = changedIdx;
  // Shorter gaps are turning loops at the ends of the line, which stop-to-stop tracing skips.
  const notServed = servedRef.length && carIdx ? offRuns(servedRef, carIdx, 35, 200) : [];
  // Of the regular route the main service skips, which parts does the replacement bus cover?
  const covered = busIdx ? splitBy(notServed.map(l => densify(l)), p => busIdx.dist(p[0], p[1]) <= 35 ? 'bus' : 'none') : { none: notServed };
  const enc = ls => (ls || []).map(l => encodePolyline(simplify(l, 5)));
  const body = JSON.stringify({
    route: r, title: live.title, fetchedAt: new Date().toISOString(), streetcar,
    normalSource: useOsm ? 'openstreetmap' : osmLines.length && schedLines.length ? 'schedule+openstreetmap' : schedLines.length ? 'schedule' : osmLines.length ? 'openstreetmap' : null,
    live: enc(carLines),
    replacementBus: enc(busLines),
    changed: changedIdx && carIdx ? enc(offRuns(carLines, changedIdx, 35, 120)) : [],
    notServed: enc(covered.none),
    notServedBusCovers: enc(covered.bus),
  });
  routeCache.set(r, { at: Date.now(), body });
  return body;
}

module.exports = { getNetwork, getRoute };
