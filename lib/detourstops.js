// Which stops a detoured trip actually serves. The TTC's GTFS-realtime trip updates for
// modified trips (gtfsrt.ttc.ca/trips/modified_update) carry each detoured trip's stop-by-stop
// list with predicted times; a stop on the detour streets that isn't listed is skipped.
// (The detour feed itself only has the path, not the stops.)
const { liveRoute } = require('./observer');

const URL_MODIFIED = 'https://gtfsrt.ttc.ca/trips/modified_update?format=text';   // JSON despite the name
const CACHE_MS = 90 * 1000;

// "detour_43_853:0_0_971_95_Port Union Rd" -> { route: "95", headsign: "Port Union Rd" }
function parseMod(id) {
  const parts = String(id).split('_');
  return { route: parts[5] || '', headsign: parts.slice(6).join('_') };
}

let cache = { at: 0, data: null }, loading = null;

async function build() {
  const res = await fetch(URL_MODIFIED);
  if (!res.ok) throw new Error(`TTC trip updates returned HTTP ${res.status}`);
  const feed = await res.json();
  const byMod = new Map();
  for (const e of feed.entity || []) {
    const tu = e.tripUpdate, mod = tu?.trip?.modifiedTrip?.modificationsId;
    if (!mod) continue;
    const route = tu.trip.routeId || parseMod(mod).route;
    if (!byMod.has(mod)) byMod.set(mod, { route, headsign: parseMod(mod).headsign, mod, seqs: [], times: new Map(), trips: 0 });
    const m = byMod.get(mod);
    m.trips++;
    const stus = (tu.stopTimeUpdate || []).filter(s => s.stopId && s.scheduleRelationship !== 'SKIPPED');
    m.seqs.push(stus.map(s => String(s.stopId)));
    for (const s of stus) {
      const t = +(s.arrival?.time || s.departure?.time || 0) * 1000;
      if (!t) continue;
      if (!m.times.has(s.stopId)) m.times.set(String(s.stopId), []);
      m.times.get(String(s.stopId)).push(t);
    }
  }

  const out = [];
  for (const m of byMod.values()) {
    // Stops the route doesn't normally serve: those are the detour's own stops.
    let regular = new Set();
    try { regular = new Set((await liveRoute(m.route)).stops.keys()); } catch { /* unknown route */ }
    // Order: the longest stop list (trips report only their remaining stops), then any others.
    const order = [];
    for (const seq of [...m.seqs].sort((a, b) => b.length - a.length)) for (const id of seq) if (!order.includes(id)) order.push(id);
    const detour = order.filter(id => !regular.has(id));
    if (!detour.length) continue;                    // detour over: trips list the regular stops again
    const now = Date.now();
    const times = {};
    for (const id of detour) times[id] = (m.times.get(id) || []).filter(t => t > now - 60000).sort((a, b) => a - b).slice(0, 3);
    out.push({ route: m.route, headsign: m.headsign, modification: m.mod, trips: m.trips, served: order, detourStops: detour, times });
  }
  return { fetchedAt: new Date().toISOString(), detours: out };
}

async function getDetourStops() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  if (!loading) loading = build().then(data => (cache = { at: Date.now(), data }).data).finally(() => { loading = null; });
  return cache.data || loading;                        // serve the previous copy while refreshing
}

module.exports = { getDetourStops };
