// Summarizes ghost-tracker runs: node scripts/ghost-report.js [dir-or-files...]
// Default: runs/ in a checkout of the ghost-data branch, or data/ghosts/ locally.
const fs = require('node:fs');
const path = require('node:path');

function files(args) {
  const roots = args.length ? args : ['runs', path.join(__dirname, '..', 'data', 'ghosts')].filter(fs.existsSync);
  const out = [];
  const walk = p => fs.statSync(p).isDirectory() ? fs.readdirSync(p).forEach(f => walk(path.join(p, f))) : p.endsWith('.json') && out.push(p);
  roots.forEach(walk);
  return out.sort();
}

const runs = files(process.argv.slice(2)).map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
if (!runs.length) { console.log('No ghost-tracker runs found.'); process.exit(0); }

const total = {};
for (const r of runs) for (const [k, c] of Object.entries(r.counts))
  for (const [f, v] of Object.entries(c)) (total[k] ||= {})[f] = (total[k][f] || 0) + v;

const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '-';
function row(k) {
  const c = total[k]; if (!c) return null;
  const decided = c.served + c.ghost + c.novehicle;
  return { n: decided, ghost: pct(c.ghost + c.novehicle, decided), noVehicle: pct(c.novehicle, decided),
    meanErr: c.errN ? (c.errSum / c.errN).toFixed(1) : '-', meanAbsErr: c.errN ? (c.errAbs / c.errN).toFixed(1) : '-',
    unclear: c.unclear || 0, unknown: c.unknown || 0 };
}

console.log(`${runs.length} runs, ${runs[0].started} to ${runs[runs.length - 1].ended}\n`);
console.log('Ghost rate = predicted vehicle never came (or no vehicle assigned and none came), of predictions we could check.');
console.log('Error = actual minus predicted, minutes (positive = later than predicted).\n');
for (const scope of ['all', 'streetcar', 'bus']) {
  console.log(`== ${scope}`);
  for (const b of ['0-5', '5-15', '15-30']) for (const f of ['nextbus', 'gtfsrt']) {
    const r = row(`${f}|${scope}|${b}`);
    if (r) console.log(`  ${b.padEnd(6)} min ahead  ${f.padEnd(8)} n=${String(r.n).padEnd(6)} ghosts ${r.ghost.padEnd(7)} (no vehicle ${r.noVehicle})  mean error ${r.meanErr}  mean |error| ${r.meanAbsErr}`);
  }
}
const routes = [...new Set(Object.keys(total).filter(k => k.includes('|route:')).map(k => k.split('|')[1].slice(6)))];
const worst = routes.map(r => ({ r, nb: row(`nextbus|route:${r}|5-15`), gt: row(`gtfsrt|route:${r}|5-15`) }))
  .filter(x => (x.nb?.n || 0) + (x.gt?.n || 0) >= 20)
  .sort((a, b) => parseFloat(b.gt?.ghost || 0) - parseFloat(a.gt?.ghost || 0)).slice(0, 12);
console.log('\n== Routes by GTFS-realtime ghost rate (predictions 5-15 min ahead)');
for (const x of worst) console.log(`  ${x.r.padEnd(4)} gtfsrt ${(x.gt?.ghost || '-').padEnd(7)} nextbus ${x.nb?.ghost || '-'}`);
const up = runs.reduce((a, r) => ({ nb: a.nb + r.unpredictedPasses.nextbus, gt: a.gt + r.unpredictedPasses.gtfsrt, t: a.t + r.unpredictedPasses.total }), { nb: 0, gt: 0, t: 0 });
console.log(`\nVehicles that came without being predicted 2+ min ahead: nextbus ${pct(up.nb, up.t)}, gtfsrt ${pct(up.gt, up.t)} of ${up.t} arrivals`);
