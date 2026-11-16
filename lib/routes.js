// Route lines for the map.
//   getNetwork(): every bus and streetcar route, from the published schedule, simplified.
//   getRoute(r):  one route's live path, plus where it differs from the regular route:
//                 "changed"   = live path that isn't on the regular route (a diversion),
//                 "notServed" = regular route that the live path doesn't cover.
const { getSchedule } = require('./gtfs');
const { liveRoute } = require('./observer');
const { getRouteRelation } = require('./osm');
const { PathIndex, encodePolyline, simplify, offRuns, dedupe, densify } = require('./geo');

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

async function getRoute(r) {
  const hit = routeCache.get(r);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.body;
  const [live, schedule, osm] = await Promise.all([liveRoute(r), getSchedule().catch(() => null), getRouteRelation(r)]);
  const streetcar = schedule?.routeTypes.get(r) === '0';
  let carLines = dedupe(live.lines), busLines = [];

  // Streetcar routes run replacement buses on their own branches ("506b ... Replacement Bus").
  // The live paths aren't labelled by branch, so assign each part of the path to the branch
  // whose stops it passes (stop-to-stop lines cut corners at turns, hence the wide tolerance).
  if (streetcar) {
    const isBus = d => /\bbus\b/i.test(d.title);
    const carSeq = live.dirs.filter(d => !isBus(d)).map(d => d.pts), busSeq = live.dirs.filter(isBus).map(d => d.pts);
    if (busSeq.length && carSeq.length) {
      const carIdx = new PathIndex(carSeq), busIdx = new PathIndex(busSeq);
      // Streets both use (College west of Bay) belong to both paths.
      const dense = carLines.map(l => densify(l));
      // Each piece of path goes to the branch whose stops it's closest to (a corner between widely
      // spaced stops, e.g. Church & Wellesley on the 506B, is still nearest the bus's stops).
      // Shared only when close to both; otherwise the closer branch (Bay south of College is the
      // streetcar's even though the 506B's stops at the corner are ~70 m away).
      const near = p => { const c = carIdx.dist(p[0], p[1]), b = busIdx.dist(p[0], p[1]); return { car: c <= 50 || c <= b, bus: b <= 50 || b < c }; };
      busLines = splitBy(dense, p => near(p).bus ? 'y' : 'n').y || [];
      carLines = splitBy(dense, p => near(p).car ? 'y' : 'n').y || [];
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
  const notServed = servedRef.length && carIdx ? offRuns(servedRef, carIdx, 35, 120) : [];
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
