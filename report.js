// Prints what the observer has learned: `node report.js [days]` (default 1).
// Run an observation pass first with `node report.js --now`.
const observer = require('./lib/observer');

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--now')) { await observer.cycle(); const s = observer.status(); if (s.lastError) console.error('Observer error:', s.lastError); }
  const days = +args.find(a => /^\d+$/.test(a)) || 1;
  const routes = await observer.summarize(days);
  if (!routes.length) return console.log('No observations yet. Start the server (it observes every 5 minutes) or run: node report.js --now');
  for (const r of routes) {
    const p = v => v == null ? '  -' : String(v).padStart(3) + '%';
    console.log(`\n${r.route.padEnd(4)} ${r.cycles} checks, ${r.vehiclePositions} vehicle positions · on live path ${p(r.pctOnLivePath)} · on scheduled path ${p(r.pctOnScheduledPath)}` +
      ` · detouring ${r.detouringPositions} (on live path ${r.detouringOnLivePath}, on detour feed ${r.detouringOnDetourFeed ?? '-'})`);
    for (const f of r.findings) console.log('     ' + f);
    for (const s of r.skippedStops.filter(s => s.predicted || s.vehiclesAt))
      console.log(`     stop #${s.stop} ${s.title || ''}: predicted in ${s.predicted}/${s.cycles} checks, vehicles seen ${s.vehiclesAt}`);
  }
})();
