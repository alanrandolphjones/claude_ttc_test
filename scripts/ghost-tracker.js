// Ghost tracker: records arrival predictions from both TTC feeds for a panel of stops, records
// when vehicles actually pass those stops, and scores every prediction.
//
//   node scripts/ghost-tracker.js [minutes=50] [outFile]
//
// Feeds compared:
//   nextbus - Umo IQ / NextBus predictions (what this app shows), polled per stop panel
//   gtfsrt  - TTC GTFS-realtime trip updates (what Google / Transit appear to use)
// Ground truth: TTC GTFS-realtime vehicle positions every 30 s. A vehicle "passed" a stop when
// the line between two consecutive positions comes within 40 m of the stop while heading the
// stop's direction of travel.
//
// Each prediction (feed, stop, vehicle, predicted time) is scored once it can be:
//   served  - that vehicle passed the stop; error = actual - predicted (minutes)
//   ghost   - predicted time + 15 min went by and that vehicle never passed the stop, though
//             it was being tracked (so it went elsewhere, short-turned or entered service later)
//   novehicle - the trip had no vehicle assigned (GTFS-realtime only); counts as a ghost if no
//             vehicle of that route passed the stop within 5 min of the predicted time
//   unknown - the vehicle wasn't seen in the positions feed, so we can't tell
// Passes nobody predicted at least 2 minutes ahead are counted as "unpredicted".
const fs = require('node:fs');
const path = require('node:path');
const { parseTextproto } = require('../lib/alerts');

const NB = 'https://retro.umoiq.com/service/publicJSONFeed?a=ttc';
const TRIPS = 'https://gtfsrt.ttc.ca/trips/update?format=text';        // JSON
const VEHICLES = 'https://gtfsrt.ttc.ca/vehicles/position?format=text'; // protobuf text format

const MINUTES = +process.argv[2] || 50;
const OUT = process.argv[3] || path.join(__dirname, '..', 'data', 'ghosts', `${new Date().toISOString().slice(0, 16).replace(/:/g, '')}.json`);
const STREETCARS = ['501', '503', '504', '505', '506', '509', '510', '511', '512'];
const BUSES = ['7', '25', '29', '32', '35', '36', '39', '41', '47', '52', '53', '54', '63', '84', '85', '94', '95', '96', '102', '165'];
const PER_DIRECTION = 4;
const PASS_M = 40, GHOST_GRACE_MS = (+process.env.GHOST_GRACE_MIN || 15) * 60e3, NOVEHICLE_WINDOW_MS = 5 * 60e3, MAX_LEAD_MS = 30 * 60e3;

const asArray = x => x == null ? [] : Array.isArray(x) ? x : [x];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const M_LAT = 110574, M_LON = 80487;
const metres = (a, b) => Math.hypot((a[0] - b[0]) * M_LAT, (a[1] - b[1]) * M_LON);
const bearing = (a, b) => (Math.atan2((b[1] - a[1]) * M_LON, (b[0] - a[0]) * M_LAT) * 180 / Math.PI + 360) % 360;
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
function segDist(p, a, b) {
  const ax = (a[1] - p[1]) * M_LON, ay = (a[0] - p[0]) * M_LAT, bx = (b[1] - p[1]) * M_LON, by = (b[0] - p[0]) * M_LAT;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
}
async function json(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }
const lead = ms => ms < 5 * 60e3 ? '0-5' : ms < 15 * 60e3 ? '5-15' : '15-30';
const hourOf = t => new Date(t).toLocaleString('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', hour12: false });

// ---- Stop panel --------------------------------------------------------------------------
async function buildPanel() {
  const panel = new Map();                               // stopId -> { id, tag, route, lat, lon, heading }
  for (const r of [...STREETCARS, ...BUSES]) {
    try {
      const cfg = (await json(`${NB}&command=routeConfig&r=${r}&terse`)).route;
      const byTag = new Map(asArray(cfg.stop).map(s => [s.tag, s]));
      for (const d of asArray(cfg.direction)) {
        if (d.useForUI === 'false') continue;
        const seq = asArray(d.stop).map(x => byTag.get(x.tag)).filter(s => s && s.stopId);
        if (seq.length < 8) continue;
        for (let k = 1; k <= PER_DIRECTION; k++) {
          const i = Math.round(k * (seq.length - 1) / (PER_DIRECTION + 1));
          const s = seq[i], prev = seq[i - 1], next = seq[i + 1];
          if (panel.has(s.stopId)) continue;
          panel.set(s.stopId, { id: s.stopId, tag: s.tag, route: r, title: s.title, lat: +s.lat, lon: +s.lon,
            heading: bearing([+prev.lat, +prev.lon], [+next.lat, +next.lon]) });
        }
      }
    } catch (e) { console.error('route', r, e.message); }
    await sleep(150);
  }
  return panel;
}

// ---- State ---------------------------------------------------------------------------------
const preds = new Map();      // key feed|stop|vehicle|tripOrTarget -> { feed, stop, route, vehicle, firstSeen, byLead: {bucket: predictedTime} }
const passes = new Map();     // stop|vehicle -> [times]
const ownPasses = new Map();  // stop|vehicle -> [times], only vehicles on the stop's panel route
const nearby = new Map();     // stop|vehicle -> [times] the vehicle came within 60 m, any heading
const routePasses = new Map(); // stop|route -> [times]
const lastPos = new Map();    // vehicle -> { t, p, route }
const seenVehicles = new Map(); // vehicle -> last seen time

function notePrediction(feed, stop, route, vehicle, tripKey, predicted, now) {
  const l = predicted - now;
  if (l < 0 || l > MAX_LEAD_MS) return;
  const target = Math.round(predicted / (20 * 60e3));    // groups revisions of the same arrival
  const key = `${feed}|${stop}|${vehicle || 'none:' + tripKey}|${tripKey || target}`;
  let p = preds.get(key);
  if (!p) preds.set(key, p = { feed, stop, route, vehicle, tripKey, firstSeen: now, byLead: {} });
  p.byLead[lead(l)] = predicted;                          // latest prediction made within each lead band
  p.last = predicted;
}

async function pollNextbus(panel, now) {
  const ids = [...panel.values()];
  for (let i = 0; i < ids.length; i += 100) {
    const q = ids.slice(i, i + 100).map(s => `stops=${encodeURIComponent(s.route + '|' + s.tag)}`).join('&');
    try {
      const d = await json(`${NB}&command=predictionsForMultiStops&${q}`);
      for (const p of asArray(d.predictions)) {
        const stop = ids.find(s => s.tag === p.stopTag && s.route === p.routeTag);
        if (!stop) continue;
        for (const dir of asArray(p.direction)) for (const x of asArray(dir.prediction))
          notePrediction('nextbus', stop.id, p.routeTag, x.vehicle, x.tripTag, +x.epochTime, now);
      }
    } catch (e) { console.error('nextbus', e.message); }
  }
}

async function pollGtfsrt(panel, now) {
  try {
    const d = await json(TRIPS);
    for (const e of d.entity || []) {
      const tu = e.tripUpdate; if (!tu) continue;
      const route = tu.trip?.routeId, vehicle = tu.vehicle?.id || null, trip = tu.trip?.tripId;
      for (const s of tu.stopTimeUpdate || []) {
        if (!panel.has(String(s.stopId)) || s.scheduleRelationship === 'SKIPPED') continue;
        const t = +(s.arrival?.time || s.departure?.time || 0) * 1000;
        if (t) notePrediction('gtfsrt', String(s.stopId), route, vehicle, trip, t, now);
      }
    }
  } catch (e) { console.error('gtfsrt', e.message); }
}

async function pollPositions(panel, now) {
  let feed;
  try { const r = await fetch(VEHICLES); feed = parseTextproto(await r.text()); } catch (e) { return console.error('positions', e.message); }
  const stops = [...panel.values()];
  for (const e of feed.entity || []) {
    const v = e.vehicle?.[0]; if (!v) continue;
    const id = String(v.vehicle?.[0]?.id?.[0] ?? ''), pos = v.position?.[0];
    if (!id || !pos) continue;
    const t = (v.timestamp?.[0] || 0) * 1000 || now, p = [pos.latitude[0], pos.longitude[0]];
    const route = v.trip?.[0]?.route_id?.[0] != null ? String(v.trip[0].route_id[0]) : null;
    seenVehicles.set(id, now);
    const prev = lastPos.get(id);
    lastPos.set(id, { t, p, route });
    if (!prev || t <= prev.t || t - prev.t > 5 * 60e3) continue;
    const moved = metres(prev.p, p), head = moved > 5 ? bearing(prev.p, p) : null;
    for (const s of stops) {
      if (Math.abs(s.lat - p[0]) > 0.01 || Math.abs(s.lon - p[1]) > 0.014) continue;
      const { d, t: frac } = segDist([s.lat, s.lon], prev.p, p);
      if (d <= 60) { const nk = s.id + '|' + id, nl = nearby.get(nk) || []; nl.push(prev.t + frac * (t - prev.t)); nearby.set(nk, nl); }
      if (d > PASS_M) continue;
      if (head != null && angDiff(head, s.heading) > 60) continue;     // other side of the street
      const at = prev.t + frac * (t - prev.t);
      const k = s.id + '|' + id;
      const list = passes.get(k) || [];
      if (!list.some(x => Math.abs(x - at) < 3 * 60e3)) {
        list.push(at); passes.set(k, list);
        if (route === s.route) { const ol = ownPasses.get(k) || []; ol.push(at); ownPasses.set(k, ol); }
      }
      if (route) { const rk = s.id + '|' + route, rl = routePasses.get(rk) || []; if (!rl.some(x => Math.abs(x - at) < 60e3)) rl.push(at); routePasses.set(rk, rl); }
    }
  }
}

// ---- Scoring -------------------------------------------------------------------------------
function score(now, final) {
  const out = [];
  for (const [key, p] of preds) {
    if (now < p.last + GHOST_GRACE_MS && !final) continue;
    let outcome, actual = null;
    if (!p.vehicle) {
      const rl = routePasses.get(p.stop + '|' + p.route) || [];
      const hit = rl.find(x => Math.abs(x - p.last) <= NOVEHICLE_WINDOW_MS);
      outcome = hit ? 'served-other' : (now >= p.last + GHOST_GRACE_MS ? 'novehicle' : null);
      actual = hit || null;
    } else {
      const list = passes.get(p.stop + '|' + p.vehicle) || [];
      const hit = list.filter(x => x > p.firstSeen - 2 * 60e3).sort((a, b) => Math.abs(a - p.last) - Math.abs(b - p.last))[0];
      if (hit && Math.abs(hit - p.last) < 40 * 60e3) { outcome = 'served'; actual = hit; }
      else if (now >= p.last + GHOST_GRACE_MS) {
        const seen = seenVehicles.get(p.vehicle);
        // Near the stop at some point but no clean pass: GPS gap or odd geometry, not a ghost.
        const near = (nearby.get(p.stop + '|' + p.vehicle) || []).some(x => Math.abs(x - p.last) < 30 * 60e3);
        outcome = !seen || seen < p.last - 5 * 60e3 ? 'unknown' : near ? 'unclear' : 'ghost';
      }
    }
    if (!outcome) continue;                               // still pending at the end of the run
    out.push({ ...p, outcome, actual });
    preds.delete(key);
  }
  return out;
}

let countFrom = 0, countUntil = Infinity;     // passes counted for "unpredicted": while collecting
function unpredicted(scored) {
  // Passes at panel stops with no prediction for that vehicle from a feed made >= 2 min ahead.
  const res = { nextbus: 0, gtfsrt: 0, total: 0 };
  const predicted = { nextbus: new Set(), gtfsrt: new Set() };
  for (const p of scored) if (p.vehicle && p.outcome === 'served') {
    const early = Object.entries(p.byLead).some(([b, t]) => b !== '0-5' || t - p.firstSeen >= 2 * 60e3);
    if (early) predicted[p.feed].add(p.stop + '|' + p.vehicle + '|' + Math.round(p.actual / 600e3));
  }
  for (const [k, list] of ownPasses) for (const t of list) {
    if (t < countFrom || t > countUntil) continue;
    res.total++;
    const id = k + '|' + Math.round(t / 600e3);
    if (!predicted.nextbus.has(id)) res.nextbus++;
    if (!predicted.gtfsrt.has(id)) res.gtfsrt++;
  }
  return res;
}

function summarize(scored, panel, started) {
  const agg = {};
  const add = (k, field, v = 1) => { (agg[k] ||= { served: 0, ghost: 0, novehicle: 0, 'served-other': 0, unknown: 0, unclear: 0, errSum: 0, errAbs: 0, errN: 0 })[field] += v; };
  for (const p of scored) {
    const kind = STREETCARS.includes(p.route) ? 'streetcar' : 'bus';
    for (const [b, t] of Object.entries(p.byLead)) {
      for (const k of [`${p.feed}|all|${b}`, `${p.feed}|${kind}|${b}`, `${p.feed}|route:${p.route}|${b}`, `${p.feed}|hour:${hourOf(t)}|${b}`]) {
        add(k, p.outcome);
        if (p.outcome === 'served') { const err = (p.actual - t) / 60e3; add(k, 'errSum', err); add(k, 'errAbs', Math.abs(err)); add(k, 'errN'); }
      }
    }
  }
  const ghosts = scored.filter(p => p.outcome === 'ghost' || p.outcome === 'novehicle').slice(0, 80).map(p => ({
    feed: p.feed, route: p.route, stop: p.stop, stopTitle: panel.get(p.stop)?.title, vehicle: p.vehicle, trip: p.tripKey,
    predicted: new Date(p.last).toISOString(), outcome: p.outcome,
  }));
  return { started: new Date(started).toISOString(), ended: new Date().toISOString(), panelStops: panel.size,
    predictionsScored: scored.length, unpredictedPasses: unpredicted(scored), counts: agg, ghostExamples: ghosts };
}

(async () => {
  const started = Date.now(), until = started + MINUTES * 60e3;
  countFrom = started + 5 * 60e3; countUntil = until - GHOST_GRACE_MS;
  const panel = await buildPanel();
  console.log(`panel: ${panel.size} stops on ${STREETCARS.length + BUSES.length} routes; running ${MINUTES} min`);
  const scored = [];
  let tick = 0;
  // Watch, but stop collecting new predictions 15 min before the end so most can be scored.
  while (Date.now() < until) {
    const now = Date.now();
    await pollPositions(panel, now);
    if (tick % 2 === 0 && now < until - GHOST_GRACE_MS) { await pollNextbus(panel, now); await pollGtfsrt(panel, now); }
    scored.push(...score(now, false));
    tick++;
    await sleep(Math.max(0, 30e3 - (Date.now() - now)));
  }
  scored.push(...score(Date.now(), false));
  const summary = summarize(scored, panel, started);
  summary.pendingAtEnd = preds.size;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(summary));
  const a = summary.counts;
  for (const f of ['nextbus', 'gtfsrt']) {
    const tot = { served: 0, ghost: 0, novehicle: 0, unclear: 0, unknown: 0 };
    for (const b of ['0-5', '5-15', '15-30']) for (const k of Object.keys(tot)) tot[k] += a[`${f}|all|${b}`]?.[k] || 0;
    console.log(f.padEnd(8), JSON.stringify(tot));
  }
  console.log('unpredicted passes', JSON.stringify(summary.unpredictedPasses), '->', OUT);
})();
