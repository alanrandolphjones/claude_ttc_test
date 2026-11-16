// Small geometry helpers for Toronto-scale distances (an equirectangular projection is
// accurate to well under a metre over a few kilometres at this latitude).
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos(43.7 * Math.PI / 180);

const xy = (lat, lon) => [lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT];

function metres(a, b) {
  return Math.hypot((a[0] - b[0]) * M_PER_DEG_LAT, (a[1] - b[1]) * M_PER_DEG_LON);
}

// Google encoded polyline -> [[lat, lon], ...]
function decodePolyline(str, precision = 5) {
  const out = [], f = 10 ** precision;
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (let k = 0; k < 2; k++) {
      let shift = 0, res = 0, b;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const v = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += v; else lon += v;
    }
    out.push([lat / f, lon / f]);
  }
  return out;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Grid index over polylines: distance from a point to the nearest line, for "is this
// point on the route?" checks. Points farther than one cell from every line get Infinity.
class PathIndex {
  constructor(lines, cell = 200) {
    this.cell = cell;
    this.grid = new Map();
    this.size = 0;
    for (const line of lines) {
      for (let i = 0; i + 1 < line.length; i++) {
        const [ax, ay] = xy(...line[i]), [bx, by] = xy(...line[i + 1]);
        const seg = [ax, ay, bx, by];
        const x0 = Math.floor(Math.min(ax, bx) / cell), x1 = Math.floor(Math.max(ax, bx) / cell);
        const y0 = Math.floor(Math.min(ay, by) / cell), y1 = Math.floor(Math.max(ay, by) / cell);
        for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
          const k = gx + ',' + gy;
          if (!this.grid.has(k)) this.grid.set(k, []);
          this.grid.get(k).push(seg);
        }
        this.size++;
      }
    }
  }
  dist(lat, lon) {
    const [px, py] = xy(lat, lon);
    const gx = Math.floor(px / this.cell), gy = Math.floor(py / this.cell);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const s of this.grid.get((gx + dx) + ',' + (gy + dy)) || []) {
        const d = segDist(px, py, s[0], s[1], s[2], s[3]);
        if (d < best) best = d;
      }
    }
    return best;
  }
}

function encodePolyline(points, precision = 5) {
  const f = 10 ** precision;
  let out = '', plat = 0, plon = 0;
  const enc = v => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lon] of points) {
    const a = Math.round(lat * f), b = Math.round(lon * f);
    out += enc(a - plat) + enc(b - plon);
    plat = a; plon = b;
  }
  return out;
}

// Douglas-Peucker line simplification, tolerance in metres.
function simplify(points, tol = 6) {
  if (points.length < 3) return points;
  const P = points.map(p => xy(...p)), keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = -1, bi = -1;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(P[k][0], P[k][1], P[i][0], P[i][1], P[j][0], P[j][1]);
      if (d > best) { best = d; bi = k; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([i, bi], [bi, j]); }
  }
  return points.filter((_, k) => keep[k]);
}

// Parts of `lines` farther than `tol` metres from `index`, as runs of at least minLen metres.
function offRuns(lines, index, tol = 35, minLen = 80) {
  const runs = [];
  for (const line of lines) {
    let run = null;
    const flush = () => {
      if (run && run.length > 1) {
        let len = 0;
        for (let k = 1; k < run.length; k++) len += metres(run[k - 1], run[k]);
        if (len >= minLen) runs.push(run);
      }
      run = null;
    };
    for (let i = 0; i < line.length; i++) {
      const off = !index || index.dist(line[i][0], line[i][1]) > tol;
      if (off) { if (!run) run = i > 0 ? [line[i - 1]] : []; run.push(line[i]); }
      else if (run) { run.push(line[i]); flush(); }
    }
    flush();
  }
  return runs;
}

// Add points so no gap exceeds `step` metres; off-route checks look at points only.
function densify(line, step = 25) {
  const out = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], n = Math.floor(metres(a, b) / step);
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / (n + 1), a[1] + (b[1] - a[1]) * k / (n + 1)]);
    out.push(b);
  }
  return out;
}

// A route's shapes overlap heavily (branches, short turns): keep only the parts not already drawn.
function dedupe(lines, tol = 15) {
  const kept = [];
  let idx = null;
  for (const l of [...lines].sort((a, b) => b.length - a.length)) {
    const d = densify(l);
    const parts = idx ? offRuns([d], idx, tol, 60) : [d];
    if (!parts.length) continue;
    kept.push(...parts);
    idx = new PathIndex(kept);
  }
  return kept;
}

module.exports = { metres, decodePolyline, encodePolyline, simplify, offRuns, densify, dedupe, PathIndex };
