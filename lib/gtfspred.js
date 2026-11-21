// Arrival predictions from the TTC's GTFS-realtime trip updates, indexed by stop. Downloaded
// only while someone is looking (at most once a minute); the file covers the whole city (~7 MB).
const URL_TRIPS = 'https://gtfsrt.ttc.ca/trips/update?format=text';   // JSON despite the name
const CACHE_MS = 60 * 1000;
let cache = { at: 0, byStop: null }, loading = null;

async function build() {
  const res = await fetch(URL_TRIPS);
  if (!res.ok) throw new Error(`TTC trip updates returned HTTP ${res.status}`);
  const feed = await res.json();
  const byStop = new Map();
  for (const e of feed.entity || []) {
    const tu = e.tripUpdate; if (!tu) continue;
    const r = tu.trip?.routeId, v = tu.vehicle?.id || null;
    for (const s of tu.stopTimeUpdate || []) {
      if (s.scheduleRelationship === 'SKIPPED') continue;
      const t = +(s.arrival?.time || s.departure?.time || 0) * 1000;
      if (!t || t < Date.now() - 60e3) continue;
      const id = String(s.stopId);
      if (!byStop.has(id)) byStop.set(id, []);
      byStop.get(id).push({ r, v, t });
    }
  }
  return byStop;
}

async function stopPredictions(ids) {
  if (!cache.byStop || Date.now() - cache.at > CACHE_MS) {
    if (!loading) loading = build().then(byStop => { cache = { at: Date.now(), byStop }; }).finally(() => { loading = null; });
    if (!cache.byStop) await loading;
  }
  const out = {};
  for (const id of ids) out[id] = (cache.byStop.get(id) || []).sort((a, b) => a.t - b.t).slice(0, 20);
  return { fetchedAt: new Date(cache.at).toISOString(), stops: out };
}

module.exports = { stopPredictions };
