/**
 * The sea, from OpenStreetMap's coastline.
 *
 * Until now the sea was traced from the 30 m elevation grid, which gave a
 * stepped coast with fingers of land and water where the height data is noisy
 * at sea level — visibly wrong against the real map (Alex's play-test, Oct 16
 * 2026). OSM's `natural=coastline` ways are the real shore, drawn by hand.
 *
 * The coastline is a set of lines, not polygons, and by convention it runs
 * with the LAND ON ITS LEFT and the water on its right. Turning lines into sea
 * polygons inside a square region is the job here:
 *
 *   1. Join the ways into chains by their shared end nodes.
 *   2. Clip every chain to the region. A chain crossing the edge becomes
 *      pieces that enter and leave through the boundary; a ring wholly
 *      inside is an island (anticlockwise) or an enclosed sea (clockwise).
 *   3. Walk round: from where a piece leaves the region, follow the boundary
 *      CLOCKWISE — which keeps the water on the right — to where the next
 *      piece comes in, and carry on until back at the start. Each loop is
 *      one sea polygon.
 *   4. Islands become holes in the sea polygon around them. A region with
 *      islands but no coastline crossing its edge is all sea, bar the islands.
 *
 * Everything works in local metres (y up, so "anticlockwise" is the usual
 * maths sense), and the result is GeoJSON in lon/lat. Anything that does not
 * add up — a chain that stops in mid-region, say, from a gap in the data —
 * returns null, and the caller falls back to the elevation trace.
 */

/**
 * Join coastline ways into chains, following shared end nodes.
 *
 * @param {Object[]} ways Overpass ways with `nodes` (node ids)
 * @returns {number[][]} chains of node ids, in coastline direction
 */
export function joinCoastWays(ways) {
  const byStart = new Map();
  for (const way of ways) {
    if (way.nodes?.length >= 2) byStart.set(way.nodes[0], way);
  }
  const used = new Set();
  const chains = [];

  // Start from ways nothing leads into, so each chain is built from its head;
  // then whatever is left forms rings.
  const leadsInto = new Set([...byStart.values()].map((way) => way.nodes.at(-1)));
  const heads = [...byStart.values()].filter((way) => !leadsInto.has(way.nodes[0]));
  for (const start of [...heads, ...byStart.values()]) {
    if (used.has(start)) continue;
    const chain = [...start.nodes];
    used.add(start);
    for (;;) {
      const next = byStart.get(chain.at(-1));
      if (!next || used.has(next)) break;
      used.add(next);
      chain.push(...next.nodes.slice(1));
    }
    chains.push(chain);
  }
  return chains;
}

/**
 * Sea polygons for the region, or null when the coastline cannot be trusted
 * (or there is none) — then the caller uses the elevation trace.
 *
 * @param {Array<Array<[number,number]>>} chains lon/lat polylines, coastline direction
 * @param {import('../model/region.js').LocalFrame} frame
 * @returns {Object|null} GeoJSON FeatureCollection of Polygons
 */
export function seaFromCoastline(chains, frame) {
  if (!chains.length) return null;
  const W = frame.widthM;
  const H = frame.heightM;
  const local = chains.map((chain) => chain.map(([lon, lat]) => frame.toLocal(lon, lat)));

  const pieces = [];
  const rings = [];
  for (const chain of local) {
    if (chain.length < 2) continue;
    const closed = samePoint(chain[0], chain.at(-1));
    const inside = chain.every(([x, y]) => x > 0 && x < W && y > 0 && y < H);
    if (closed && inside) { rings.push(chain); continue; }
    // A closed ring that crosses the edge is clipped from a point outside, so
    // it does not seem to start or stop in mid-region.
    let open = chain;
    if (closed) {
      const outside = chain.findIndex(([x, y]) => x <= 0 || x >= W || y <= 0 || y >= H);
      open = [...chain.slice(outside, -1), ...chain.slice(0, outside + 1)];
    }
    const clipped = clipChain(open, W, H);
    for (const piece of clipped) {
      // Every open piece must start and end on the boundary; one that stops
      // inside the region is a hole in the data, and we cannot guess past it.
      if (!onBoundary(piece[0], W, H) || !onBoundary(piece.at(-1), W, H)) return null;
      pieces.push(piece);
    }
  }

  const seas = assemble(pieces, W, H);
  if (seas === null) return null;

  // Rings wholly inside: anticlockwise is land (an island), clockwise is a
  // sea the coastline encloses.
  const islands = [];
  for (const ring of rings) {
    if (signedArea(ring) > 0) islands.push(ring); else seas.push(ring);
  }
  // Islands, and no coastline crossing the edge: the region is open sea.
  if (pieces.length === 0 && islands.length > 0 && seas.length === 0) {
    seas.push([[0, 0], [W, 0], [W, H], [0, H], [0, 0]]);
  }
  if (seas.length === 0) return null;

  const polygons = seas.map((outer) => ({ outer, holes: [] }));
  for (const island of islands) {
    const host = polygons.find(({ outer }) => pointInRing(island[0], outer));
    if (host) host.holes.push(island);
  }

  const toLonLat = (ring) => {
    const coords = ring.map(([x, y]) => frame.toLonLat(x, y).map(round6));
    if (!samePoint(coords[0], coords.at(-1))) coords.push(coords[0]);
    return coords;
  };
  return {
    type: 'FeatureCollection',
    features: polygons.map(({ outer, holes }) => ({
      type: 'Feature',
      properties: { source: 'osm-coastline' },
      geometry: { type: 'Polygon', coordinates: [outer, ...holes].map(toLonLat) },
    })),
  };
}

/**
 * Join boundary-to-boundary pieces into closed sea rings by walking the
 * boundary clockwise between them. Returns null if the pieces do not close.
 */
function assemble(pieces, W, H) {
  const perimeter = 2 * (W + H);
  const entry = pieces.map((piece) => boundaryT(piece[0], W, H));
  const exit = pieces.map((piece) => boundaryT(piece.at(-1), W, H));
  const used = new Array(pieces.length).fill(false);
  const seas = [];

  for (let first = 0; first < pieces.length; first++) {
    if (used[first]) continue;
    const ring = [...pieces[first]];
    used[first] = true;
    let current = first;
    for (let guard = 0; guard <= pieces.length; guard++) {
      // The next piece in, clockwise from where this one left.
      let next = -1;
      let bestGap = Infinity;
      for (let j = 0; j < pieces.length; j++) {
        if (used[j] && j !== first) continue;
        let gap = (entry[j] - exit[current] + perimeter) % perimeter;
        if (j === first && gap === 0 && current === first) gap = perimeter; // a piece is not its own successor at once
        if (gap < bestGap) { bestGap = gap; next = j; }
      }
      if (next === -1) return null;
      ring.push(...cornersBetween(exit[current], exit[current] + bestGap, W, H));
      if (next === first) {
        ring.push(ring[0]);
        seas.push(ring);
        break;
      }
      ring.push(...pieces[next]);
      used[next] = true;
      current = next;
      if (guard === pieces.length) return null;
    }
  }
  return seas;
}

/**
 * Position along the boundary, clockwise from the top-left corner: along the
 * top edge eastwards, down the right edge, west along the bottom, up the left.
 */
function boundaryT([x, y], W, H) {
  const e = 1e-6;
  if (Math.abs(y - H) < e) return x;
  if (Math.abs(x - W) < e) return W + (H - y);
  if (Math.abs(y) < e) return W + H + (W - x);
  return 2 * W + H + y;
}

/** The region's corners passed walking clockwise from t0 to t1, in order. */
function cornersBetween(t0, t1, W, H) {
  const perimeter = 2 * (W + H);
  const corners = [[W, W, H], [W + H, W, 0], [2 * W + H, 0, 0], [perimeter, 0, H]];
  const out = [];
  for (let lap = 0; lap < 2; lap++) {
    for (const [t, x, y] of corners) {
      const at = t + lap * perimeter;
      if (at > t0 && at < t1) out.push([x, y]);
    }
  }
  return out;
}

/**
 * Clip a polyline to the box [0,W]×[0,H], returning the pieces inside in
 * order. Liang–Barsky per segment; a piece starts where the line enters and
 * ends where it leaves.
 */
function clipChain(chain, W, H) {
  const pieces = [];
  let current = null;
  for (let i = 1; i < chain.length; i++) {
    const clipped = clipSegment(chain[i - 1], chain[i], W, H);
    if (!clipped) { if (current) { pieces.push(current); current = null; } continue; }
    const [a, b, enters, leaves] = clipped;
    if (!current || enters) {
      if (current) pieces.push(current);
      current = [a];
    }
    current.push(b);
    if (leaves) { pieces.push(current); current = null; }
  }
  if (current) pieces.push(current);
  return pieces.filter((piece) => piece.length >= 2);
}

function clipSegment([x1, y1], [x2, y2], W, H) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, x1], [dx, W - x1], [-dy, y1], [dy, H - y1]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  if (t1 - t0 < 1e-12) return null;
  return [[x1 + t0 * dx, y1 + t0 * dy], [x1 + t1 * dx, y1 + t1 * dy], t0 > 0, t1 < 1];
}

function onBoundary([x, y], W, H) {
  const e = 1e-6;
  return Math.abs(x) < e || Math.abs(y) < e || Math.abs(x - W) < e || Math.abs(y - H) < e;
}

function samePoint(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

/** Twice the signed area; positive for an anticlockwise ring (y up). */
function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum;
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Make the height grid agree with the coastline: a cell whose centre is in
 * the sea is sea, and one on land is not, whatever the elevation data said.
 * The grade rule, the contours and `isSea` then all match the drawn shore.
 * Scanline fill, even-odd, so islands come out as land.
 *
 * @param {import('../model/region.js').Grid} terrain modified in place
 * @param {Object} sea GeoJSON from `seaFromCoastline`
 * @returns {{toSea:number, toLand:number}} cells changed
 */
export function applySeaToTerrain(terrain, sea, frame, { seaDepthM = -1, landM = 0.5 } = {}) {
  const { cols, rows, cellM, values } = terrain;
  const edges = [];
  for (const feature of sea.features) {
    for (const ring of feature.geometry.coordinates) {
      const local = ring.map(([lon, lat]) => frame.toLocal(lon, lat));
      for (let i = 1; i < local.length; i++) edges.push([local[i - 1], local[i]]);
    }
  }
  let toSea = 0;
  let toLand = 0;
  for (let row = 0; row < rows; row++) {
    const y = (row + 0.5) * cellM;
    const crossings = [];
    for (const [[x1, y1], [x2, y2]] of edges) {
      if ((y1 > y) !== (y2 > y)) crossings.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
    crossings.sort((a, b) => a - b);
    let k = 0;
    let inSea = false;
    for (let col = 0; col < cols; col++) {
      const x = (col + 0.5) * cellM;
      while (k < crossings.length && crossings[k] <= x) { inSea = !inSea; k++; }
      const index = row * cols + col;
      if (inSea && values[index] > seaDepthM) { values[index] = seaDepthM; toSea++; }
      else if (!inSea && values[index] <= 0) { values[index] = landM; toLand++; }
    }
  }
  return { toSea, toLand };
}
