// How full each vehicle is, from the TTC's GTFS-realtime vehicle positions (occupancy_status).
// Keyed by vehicle number, the same number the arrival predictions carry.
const { parseTextproto } = require('./alerts');

const URL_VEHICLES = 'https://gtfsrt.ttc.ca/vehicles/position?format=text';
const CACHE_MS = 30 * 1000;
let cache = { at: 0, body: null }, loading = null;

async function build() {
  const res = await fetch(URL_VEHICLES);
  if (!res.ok) throw new Error(`TTC vehicle positions returned HTTP ${res.status}`);
  const feed = parseTextproto(await res.text());
  const vehicles = {};
  for (const e of feed.entity || []) {
    const v = e.vehicle?.[0];
    const id = v?.vehicle?.[0]?.id?.[0], occ = v?.occupancy_status?.[0];
    if (id != null && occ) vehicles[String(id)] = occ;
  }
  return JSON.stringify({ fetchedAt: new Date().toISOString(), vehicles });
}

async function getOccupancy() {
  if (cache.body && Date.now() - cache.at < CACHE_MS) return cache.body;
  if (!loading) loading = build().then(body => (cache = { at: Date.now(), body }).body).finally(() => { loading = null; });
  return cache.body || loading;
}

module.exports = { getOccupancy };
