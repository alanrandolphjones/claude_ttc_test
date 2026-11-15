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

module.exports = { metres, decodePolyline, PathIndex };
