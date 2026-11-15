// TTC service alerts from two feeds, merged into one list (see server.js for why).
const LIVE_URL = 'https://alerts.ttc.ca/api/alerts/live-alerts';
const GTFSRT_URL = 'https://gtfsrt.ttc.ca/alerts/all?format=text';
const CACHE_MS = 60 * 1000;

// ---- Protobuf text format -> plain objects ---------------------------------
// Every field becomes an array, since any of them may repeat.
function parseTextproto(src) {
  const re = /\s*(?:([A-Za-z_][\w]*)\s*(\{|:\s*("(?:[^"\\]|\\.)*"|[^\s{}]+))|(\}))/y;
  const root = {}, stack = [root];
  let m;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    const cur = stack[stack.length - 1];
    if (m[4]) { stack.pop(); continue; }
    const [, key, brace, raw] = m;
    let val;
    if (brace === '{') { val = {}; stack.push(val); }
    else if (raw[0] === '"') val = JSON.parse(raw.replace(/\\'/g, "'"));
    else val = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    (cur[key] ||= []).push(val);
  }
  return root;
}

const text = t => t?.[0]?.translation?.find(x => (x.language?.[0] || 'en') === 'en')?.text?.[0] ?? '';
const EFFECT_DESC = { DETOUR: 'Detour', NO_SERVICE: 'No service', REDUCED_SERVICE: 'Reduced service',
  SIGNIFICANT_DELAYS: 'Delays', MODIFIED_SERVICE: 'Service change', STOP_MOVED: 'Stop moved',
  ADDITIONAL_SERVICE: 'Additional service', OTHER_EFFECT: 'Service alert', ACCESSIBILITY_ISSUE: 'Accessibility' };

// One record per route, in the same shape as alerts.ttc.ca's `routes` entries.
function normalizeGtfsrt(feed) {
  const out = [];
  for (const e of feed.entity || []) {
    const a = e.alert?.[0];
    if (!a) continue;
    const effect = a.effect?.[0] || 'UNKNOWN_EFFECT';
    if (effect === 'ACCESSIBILITY_ISSUE') continue;          // elevators/escalators: not about vehicles
    const byRoute = new Map();
    for (const ie of a.informed_entity || []) {
      const r = ie.route_id?.[0];
      if (r == null || r === '') continue;
      if (!byRoute.has(r)) byRoute.set(r, []);
      const s = ie.stop_id?.[0];
      if (s != null && s !== '') byRoute.get(r).push(String(s));
    }
    const periods = (a.active_period || []).map(p => ({
      start: p.start ? new Date(p.start[0] * 1000).toISOString() : null,
      end: p.end ? new Date(p.end[0] * 1000).toISOString() : null,
    }));
    const description = text(a.description_text);
    for (const [route, stops] of byRoute) {
      out.push({
        id: String(e.id?.[0] ?? ''), source: 'gtfsrt', route: String(route), stops,
        effect, effectDesc: EFFECT_DESC[effect] || 'Service alert',
        headerText: text(a.header_text), title: text(a.header_text), description,
        url: text(a.url), direction: '', cause: a.cause?.[0] || '', activePeriods: periods,
        activePeriod: periods[0] || { start: null, end: null },
        shuttleType: /replacement bus|shuttle/i.test(description) ? 'Replacement buses' : null,
      });
    }
  }
  return out;
}

// ---- Fetch + cache ---------------------------------------------------------
let cache = { at: 0, body: null, data: null };

async function getText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${new URL(url).host} returned HTTP ${res.status}`);
  return res.text();
}

async function getAlerts() {
  if (cache.body && Date.now() - cache.at < CACHE_MS) return cache.body;
  const [live, rt] = await Promise.allSettled([getText(LIVE_URL), getText(GTFSRT_URL)]);
  if (live.status === 'rejected' && rt.status === 'rejected') throw live.reason;

  const liveRoutes = live.status === 'fulfilled'
    ? (JSON.parse(live.value).routes || []).map(a => ({ ...a, source: 'live' })) : [];
  // The GTFS-realtime feed repeats the live alerts under the same ids; keep the live
  // version (it has direction and shuttle details) and add everything else.
  const liveIds = new Set(liveRoutes.map(a => String(a.id)));
  const planned = rt.status === 'fulfilled'
    ? normalizeGtfsrt(parseTextproto(rt.value)).filter(a => !liveIds.has(a.id)) : [];

  const body = JSON.stringify({
    fetchedAt: new Date().toISOString(),
    sources: { live: live.status === 'fulfilled', gtfsrt: rt.status === 'fulfilled' },
    routes: [...liveRoutes, ...planned],
  });
  cache = { at: Date.now(), body, data: JSON.parse(body) };
  return body;
}


// Parsed form, for server-side use.
async function getAlertsData() { await getAlerts(); return cache.data; }
const staleAlerts = () => cache.body;

// Same rules as the page: an alert applies now if any of its periods covers now.
function isActiveNow(a, now = Date.now()) {
  const periods = a.activePeriods?.length ? a.activePeriods : [a.activePeriod || {}];
  return periods.some(p => {
    const start = p.start ? Date.parse(p.start) : -Infinity;
    const end = !p.end || p.end.startsWith('0001') ? Infinity : Date.parse(p.end);
    return start <= now && now < end;
  });
}

module.exports = { getAlerts, getAlertsData, staleAlerts, isActiveNow };
