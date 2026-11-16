// Watches routes with service changes and records where the TTC's sources disagree, so we
// can learn over time which one to believe. The sources:
//   alerts       - what the TTC says (stops skipped, route changes)
//   live route   - the stops and path in the real-time feed (Umo IQ), which drive predictions
//   detour feed  - the TTC's GTFS-realtime detour paths
//   schedule     - the normal path (published GTFS)
//   vehicles     - where buses and streetcars actually are: the ground truth
//
// Every few minutes, for each watched route, one JSON line goes to
// data/observations/YYYY-MM-DD.jsonl. summarize() turns those lines into per-route findings.
const fs = require('node:fs/promises');
const path = require('node:path');
const { PathIndex, metres } = require('./geo');
const { getAlertsData, isActiveNow } = require('./alerts');
const { getDetours } = require('./detours');
const { getSchedule } = require('./gtfs');

const NB = 'https://retro.umoiq.com/service/publicJSONFeed?a=ttc';
const DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'observations');
const ON_PATH_M = 50;          // a vehicle within this distance of a path is "on" it
const AT_STOP_M = 40;          // a vehicle within this distance of a stop has passed it
const FRESH_S = 120;           // ignore vehicle positions older than this
const BYPASS = new Set(['DETOUR', 'NO_SERVICE', 'REDUCED_SERVICE', 'STOP_MOVED', 'MODIFIED_SERVICE']);

const asArray = x => x == null ? [] : Array.isArray(x) ? x : [x];
const torontoDate = (t = new Date()) => t.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function nb(params) {
  const res = await fetch(`${NB}&${params}`);
  if (!res.ok) throw new Error(`Umo IQ returned HTTP ${res.status}`);
  const json = await res.json();
  if (json.Error) throw new Error(json.Error.content || 'Umo IQ error');
  return json;
}

// Live route data with paths, cached 30 minutes per route.
const configs = new Map();
async function liveRoute(route) {
  const hit = configs.get(route);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit;
  const r = (await nb(`command=routeConfig&r=${encodeURIComponent(route)}`)).route;
  const stops = new Map();
  for (const s of asArray(r.stop)) if (s.stopId) stops.set(String(s.stopId), { tag: s.tag, title: s.title, lat: +s.lat, lon: +s.lon });
  const lines = asArray(r.path).map(p => asArray(p.point).map(x => [+x.lat, +x.lon]));
  const entry = { at: Date.now(), stops, index: new PathIndex(lines) };
  configs.set(route, entry);
  return entry;
}

async function observeRoute(route, ctx) {
  const t = new Date().toISOString();
  const live = await liveRoute(route);
  const normal = ctx.schedule?.normalIndex(route) || null;
  const detourLines = ctx.detours.filter(d => d.route === route).map(d => d.path);
  const detourIdx = detourLines.length ? new PathIndex(detourLines) : null;
  const routeAlerts = ctx.alerts.filter(a => a.route === route);

  // Vehicles: which path is each one actually on?
  const vl = await nb(`command=vehicleLocations&r=${encodeURIComponent(route)}&t=0`);
  const vehicles = asArray(vl.vehicle).filter(v => v.dirTag && +v.secsSinceReport <= FRESH_S);
  // offNormal*: vehicles away from the scheduled path, i.e. actually detouring. Which source
  // described where they went: the live route data, the detour feed, neither?
  const v = { n: vehicles.length, onLive: 0, onNormal: 0, onDetour: 0, offNormal: 0, offNormalOnLive: 0, offNormalOnDetour: 0, offLive: [] };
  for (const x of vehicles) {
    const lat = +x.lat, lon = +x.lon;
    const dl = live.index.dist(lat, lon), dn = normal ? normal.dist(lat, lon) : null, dd = detourIdx ? detourIdx.dist(lat, lon) : null;
    if (dl <= ON_PATH_M) v.onLive++;
    if (dn != null && dn <= ON_PATH_M) v.onNormal++;
    if (dd != null && dd <= ON_PATH_M) v.onDetour++;
    if (dn != null && dn > ON_PATH_M) {
      v.offNormal++;
      if (dl <= ON_PATH_M) v.offNormalOnLive++;
      if (dd != null && dd <= ON_PATH_M) v.offNormalOnDetour++;
    }
    if (dl > ON_PATH_M) v.offLive.push({ id: x.id, lat, lon, dirTag: x.dirTag,
      liveM: Number.isFinite(dl) ? Math.round(dl) : null,
      normalM: dn == null ? null : Number.isFinite(dn) ? Math.round(dn) : null,
      detourM: dd == null ? null : Number.isFinite(dd) ? Math.round(dd) : null });
  }

  // Stops the alerts say are skipped: does the live feed still list and predict them,
  // and does any vehicle actually go there?
  const skipped = new Map();
  for (const a of routeAlerts) {
    if (!BYPASS.has(a.effect)) continue;
    for (const id of asArray(a.stops)) skipped.set(String(id), a.id);
  }
  const skippedStops = [];
  if (skipped.size) {
    const listed = [...skipped.keys()].filter(id => live.stops.has(id));
    let preds = new Map();
    if (listed.length) {
      const q = listed.map(id => `stops=${encodeURIComponent(route + '|' + live.stops.get(id).tag)}`).join('&');
      try {
        const p = await nb(`command=predictionsForMultiStops&${q}`);
        for (const ps of asArray(p.predictions)) {
          const mins = asArray(ps.direction).flatMap(d => asArray(d.prediction).map(x => +x.minutes)).sort((a, b) => a - b);
          const id = [...live.stops].find(([, s]) => s.tag === ps.stopTag)?.[0];
          if (id) preds.set(id, mins.slice(0, 3));
        }
      } catch { preds = null; }
    }
    for (const [id, alertId] of skipped) {
      const s = live.stops.get(id);
      skippedStops.push({
        stop: id, alert: alertId, listed: !!s, title: s?.title,
        predicted: preds ? (preds.get(id) || []) : null,
        vehiclesAt: s ? vehicles.filter(x => metres([+x.lat, +x.lon], [s.lat, s.lon]) <= AT_STOP_M).length : null,
      });
    }
  }

  return {
    t, route,
    alerts: routeAlerts.map(a => ({ id: a.id, source: a.source, effect: a.effect, stops: asArray(a.stops).length })),
    detourSections: detourLines.length,
    vehicles: v,
    skippedStops,
  };
}

let timer = null, running = false, lastRun = null, lastError = null;

async function cycle() {
  if (running) return;
  running = true;
  try {
    const [alertsData, detoursData, schedule] = await Promise.all([
      getAlertsData(), getDetours().catch(() => ({ detours: [] })), getSchedule().catch(() => null)]);
    const isVehicleRoute = r => !schedule || ['0', '3'].includes(schedule.routeTypes.get(r) ?? '3');
    const alerts = (alertsData?.routes || []).filter(a => a.effect && a.effect !== 'NO_EFFECT' && isActiveNow(a));
    const routes = [...new Set([...alerts.map(a => a.route), ...detoursData.detours.map(d => d.route)])]
      .filter(r => /^\d+$/.test(r) && isVehicleRoute(r));
    const ctx = { alerts, detours: detoursData.detours, schedule };
    const lines = [];
    for (const route of routes) {
      try { lines.push(await observeRoute(route, ctx)); }
      catch (e) { lines.push({ t: new Date().toISOString(), route, error: e.message }); }
      await sleep(250);                                  // be gentle with the public feed
    }
    await fs.mkdir(DIR, { recursive: true });
    await fs.appendFile(path.join(DIR, torontoDate() + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    lastRun = { at: new Date().toISOString(), routes: routes.length };
    lastError = null;
  } catch (e) {
    lastError = e.message;
  } finally {
    running = false;
  }
}

function start(everyMinutes = 5) {
  if (timer) return;
  setTimeout(cycle, 15 * 1000);                          // let the server settle first
  timer = setInterval(cycle, everyMinutes * 60 * 1000);
}

async function readLines(days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const file = path.join(DIR, torontoDate(new Date(Date.now() - i * 864e5)) + '.jsonl');
    try {
      for (const l of (await fs.readFile(file, 'utf8')).split('\n')) if (l) out.push(JSON.parse(l));
    } catch { /* no file that day */ }
  }
  return out;
}

const pct = (a, b) => b ? Math.round(100 * a / b) : null;

// Per-route findings: which source the vehicles agreed with, and stops with "ghost" predictions.
async function summarize(days = 1) {
  const lines = (await readLines(days)).filter(l => !l.error);
  const byRoute = new Map();
  for (const l of lines) {
    if (!byRoute.has(l.route)) byRoute.set(l.route, { route: l.route, cycles: 0, samples: 0, onLive: 0, onNormal: 0, onDetour: 0,
      offNormal: 0, offNormalOnLive: 0, offNormalOnDetour: 0, hasDetourFeed: false, offLiveExamples: [], stops: new Map(), alerts: new Map(), first: l.t, last: l.t });
    const r = byRoute.get(l.route);
    r.cycles++; r.last = l.t;
    r.samples += l.vehicles.n; r.onLive += l.vehicles.onLive; r.onNormal += l.vehicles.onNormal; r.onDetour += l.vehicles.onDetour;
    r.offNormal += l.vehicles.offNormal || 0; r.offNormalOnLive += l.vehicles.offNormalOnLive || 0; r.offNormalOnDetour += l.vehicles.offNormalOnDetour || 0;
    if (l.detourSections) r.hasDetourFeed = true;
    for (const a of l.alerts) r.alerts.set(a.id, a);
    for (const o of l.vehicles.offLive) { r.offLiveExamples.push({ t: l.t, ...o }); if (r.offLiveExamples.length > 10) r.offLiveExamples.shift(); }
    for (const s of l.skippedStops) {
      if (!r.stops.has(s.stop)) r.stops.set(s.stop, { stop: s.stop, title: s.title, cycles: 0, listed: 0, predicted: 0, vehiclesAt: 0 });
      const x = r.stops.get(s.stop);
      x.cycles++; if (s.listed) x.listed++; if (s.predicted?.length) x.predicted++; x.vehiclesAt += s.vehiclesAt || 0;
      x.title ||= s.title;
    }
  }

  return [...byRoute.values()].map(r => {
    const findings = [];
    const live = pct(r.onLive, r.samples), normal = pct(r.onNormal, r.samples);
    if (r.samples >= 10) {
      if (live < 90) findings.push(`${100 - live}% of vehicle positions were off the live route data's path` +
        (normal != null ? `; ${normal}% were on the scheduled path` : '') + '.');
      else findings.push(`Vehicles followed the live route data (${live}% of positions on its path).`);
    }
    if (r.offNormal >= 5) {
      findings.push(`${r.offNormal} positions were off the scheduled path (detouring): ` +
        `${pct(r.offNormalOnLive, r.offNormal)}% matched the live route data` +
        (r.hasDetourFeed ? `, ${pct(r.offNormalOnDetour, r.offNormal)}% matched the detour feed` : ', and there was no detour feed path') + '.');
    }
    // One snapshot rarely catches a vehicle right at a stop, so "never seen" needs an hour of checks.
    const ghosts = [...r.stops.values()].filter(s => s.cycles >= 12 && s.predicted >= s.cycles / 2 && s.vehiclesAt === 0);
    if (ghosts.length) findings.push(`${ghosts.length} stop(s) the alert says are skipped still got predictions while no vehicle was seen there (likely ghost times).`);
    const served = [...r.stops.values()].filter(s => s.vehiclesAt > 0);
    if (served.length) findings.push(`${served.length} stop(s) the alert says are skipped had vehicles at them: the alert may be outdated or only cover some trips.`);
    return {
      route: r.route, cycles: r.cycles, from: r.first, to: r.last, vehiclePositions: r.samples,
      pctOnLivePath: live, pctOnScheduledPath: normal,
      detouringPositions: r.offNormal, detouringOnLivePath: r.offNormalOnLive, detouringOnDetourFeed: r.hasDetourFeed ? r.offNormalOnDetour : null,
      alerts: [...r.alerts.values()], skippedStops: [...r.stops.values()], offLiveExamples: r.offLiveExamples, findings,
    };
  }).sort((a, b) => (a.pctOnLivePath ?? 100) - (b.pctOnLivePath ?? 100));
}

const status = () => ({ lastRun, lastError, running });

module.exports = { start, cycle, summarize, status };
