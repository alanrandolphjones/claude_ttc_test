// Fetches TTC stops and TTC route relations from OpenStreetMap and writes compact snapshots
// to osm/. Run by .github/workflows/osm-snapshot.yml; also works locally: node scripts/osm-snapshot.js
const fs = require('node:fs/promises');
const path = require('node:path');
const { overpass, parseStops, isTtc, STOPS_QUERY, BBOX } = require('../lib/osm');
const { dedupe, simplify, encodePolyline } = require('../lib/geo');

const OUT = path.join(__dirname, '..', 'osm');
const ROUTES_QUERY = `[out:json][timeout:180];
relation["type"="route"]["route"~"^(bus|tram|trolleybus)$"](${BBOX});
out geom;`;

(async () => {
  await fs.mkdir(OUT, { recursive: true });
  const fetchedAt = new Date().toISOString();

  const stops = parseStops(await overpass(STOPS_QUERY, 180000));
  if (stops.length < 3000) throw new Error(`Only ${stops.length} stops returned; refusing to overwrite the snapshot`);
  stops.sort((a, b) => a.id - b.id);
  await fs.writeFile(path.join(OUT, 'ttc-stops.json'), JSON.stringify({ fetchedAt, source: 'OpenStreetMap contributors, ODbL', stops }) + '\n');
  console.log(`${stops.length} TTC stops`);

  const rel = await overpass(ROUTES_QUERY, 240000);
  const byRef = new Map();
  for (const e of rel.elements || []) {
    if (e.type !== 'relation' || !isTtc(e.tags || {}) || !/^\d{1,4}$/.test(e.tags.ref || '')) continue;
    const lines = (e.members || []).filter(m => m.type === 'way' && m.geometry?.length > 1).map(m => m.geometry.map(g => [g.lat, g.lon]));
    if (!byRef.has(e.tags.ref)) byRef.set(e.tags.ref, []);
    byRef.get(e.tags.ref).push(...lines);
  }
  const routes = {};
  for (const [ref, lines] of [...byRef].sort((a, b) => a[0] - b[0])) routes[ref] = dedupe(lines).map(l => encodePolyline(simplify(l, 5)));
  if (Object.keys(routes).length < 100) throw new Error(`Only ${Object.keys(routes).length} routes returned; refusing to overwrite the snapshot`);
  await fs.writeFile(path.join(OUT, 'ttc-routes.json'), JSON.stringify({ fetchedAt, source: 'OpenStreetMap contributors, ODbL', routes }) + '\n');
  console.log(`${Object.keys(routes).length} TTC routes`);
})().catch(e => { console.error(e.message); process.exit(1); });
