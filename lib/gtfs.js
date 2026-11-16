// Loads the TTC's published schedule (GTFS, from Toronto Open Data) to get each route's
// normal path. The live feeds already follow detours, so this is the only "normal" reference.
// Downloaded at most once a day and cached in data/.
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { PathIndex } = require('./geo');

const PACKAGE_URL = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=ttc-routes-and-schedules';
const FALLBACK_ZIP = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/7795b45e-e65a-4465-81fc-c36b9dfff169/resource/cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/opendata_ttc_schedules.zip';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');   // point at a persistent volume in production
const ZIP_PATH = path.join(DATA_DIR, 'gtfs.zip');
const MAX_AGE_MS = 24 * 3600 * 1000;

// Minimal ZIP reader: enough for the plain deflate entries in the TTC's file.
function readZipEntries(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('GTFS zip: no central directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('GTFS zip: bad directory entry');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted.includes(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    out[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
  }
  return out;
}

function* csvRows(text) {
  const lines = text.split(/\r?\n/);
  const head = lines[0].replace(/^﻿/, '').split(',');
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cells = lines[i].split(',');            // TTC's trips/shapes/routes have no quoted commas in the columns used
    const row = {};
    head.forEach((h, j) => { row[h] = cells[j]; });
    yield row;
  }
}

async function downloadZip() {
  let url = FALLBACK_ZIP;
  try {
    const pkg = await (await fetch(PACKAGE_URL)).json();
    url = pkg.result.resources.find(r => /zip/i.test(r.format) || /\.zip$/i.test(r.url))?.url || url;
  } catch { /* use fallback URL */ }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GTFS download returned HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(ZIP_PATH, buf);
  return buf;
}

async function loadZip() {
  try {
    const st = await fs.stat(ZIP_PATH);
    if (Date.now() - st.mtimeMs < MAX_AGE_MS) return await fs.readFile(ZIP_PATH);
  } catch { /* not cached yet */ }
  try { return await downloadZip(); }
  catch (e) {
    try { return await fs.readFile(ZIP_PATH); } catch { throw e; }   // stale beats nothing
  }
}

let current = null, loading = null;

async function build() {
  const files = readZipEntries(await loadZip(), ['trips.txt', 'shapes.txt', 'routes.txt']);
  const routeShapes = new Map();
  for (const t of csvRows(files['trips.txt'])) {
    if (!routeShapes.has(t.route_id)) routeShapes.set(t.route_id, new Set());
    routeShapes.get(t.route_id).add(t.shape_id);
  }
  const shapes = new Map();
  for (const s of csvRows(files['shapes.txt'])) {
    if (!shapes.has(s.shape_id)) shapes.set(s.shape_id, []);
    shapes.get(s.shape_id).push([+s.shape_pt_sequence, +s.shape_pt_lat, +s.shape_pt_lon]);
  }
  for (const pts of shapes.values()) pts.sort((a, b) => a[0] - b[0]);
  const routeTypes = new Map([...csvRows(files['routes.txt'])].map(r => [r.route_short_name, r.route_type]));
  const indexes = new Map();
  return {
    loadedAt: new Date().toISOString(),
    routeTypes,
    // Normal path of a route, as a distance index; built lazily per route.
    normalIndex(route) {
      if (!indexes.has(route)) {
        const lines = [...(routeShapes.get(route) || [])].map(id => (shapes.get(id) || []).map(p => [p[1], p[2]]));
        indexes.set(route, lines.length ? new PathIndex(lines) : null);
      }
      return indexes.get(route);
    },
  };
}

// Returns the loaded schedule, reloading in the background once a day.
async function getSchedule() {
  if (current && Date.now() - Date.parse(current.loadedAt) < MAX_AGE_MS) return current;
  if (!loading) loading = build().then(s => (current = s)).finally(() => { loading = null; });
  if (current) return current;      // serve yesterday's while today's loads
  return loading;
}

module.exports = { getSchedule };
