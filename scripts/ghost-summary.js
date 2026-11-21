// Rolls ghost-tracker runs from the last N days into one small summary the app reads:
//   node scripts/ghost-summary.js <runs-dir> [days=14] > summary.json
// Per route and feed: predictions checked and ghosts. Per feed and lead band: mean error, so the
// app can correct a feed's bias.
const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2] || 'runs', days = +process.argv[3] || 14;
const since = Date.now() - days * 864e5;
const files = [];
const walk = p => fs.statSync(p).isDirectory() ? fs.readdirSync(p).forEach(f => walk(path.join(p, f))) : p.endsWith('.json') && files.push(p);
if (fs.existsSync(dir)) walk(dir);

const routes = {}, leads = {};
let runs = 0, from = null, to = null;
for (const f of files.sort()) {
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (Date.parse(r.ended) < since) continue;
  runs++; from ||= r.started; to = r.ended;
  for (const [k, c] of Object.entries(r.counts)) {
    const [feed, scope, lead] = k.split('|');
    const checked = (c.served || 0) + (c.ghost || 0) + (c.novehicle || 0), ghosts = (c.ghost || 0) + (c.novehicle || 0);
    if (scope.startsWith('route:')) {
      const x = ((routes[scope.slice(6)] ||= {})[feed] ||= { checked: 0, ghosts: 0 });
      x.checked += checked; x.ghosts += ghosts;
    } else if (scope === 'all') {
      const x = ((leads[feed] ||= {})[lead] ||= { n: 0, errSum: 0 });
      x.n += c.errN || 0; x.errSum += c.errSum || 0;
    }
  }
}
const bias = {};
for (const [feed, l] of Object.entries(leads)) for (const [lead, x] of Object.entries(l))
  (bias[feed] ||= {})[lead] = x.n ? +(x.errSum / x.n).toFixed(2) : 0;

process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), days, runs, from, to, routes,
  meanErrorMinutes: bias }) + '\n');
