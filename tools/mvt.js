/**
 * A Mapbox Vector Tile decoder in plain JavaScript, no dependencies.
 *
 * Written for Phase R's probes (Q5.3: can an MVT decoder be vendored without a
 * build step?). MVT is a small, closed protobuf schema — four messages, no
 * extensions, no imports — so decoding it needs a varint reader and nothing
 * else. @mapbox/vector-tile + pbf are general protobuf machinery we would not
 * use the rest of.
 *
 * The wire format: https://github.com/mapbox/vector-tile-spec/tree/master/2.1
 *
 *   Tile    { 3: repeated Layer }
 *   Layer   { 15: version, 1: name, 2: repeated Feature, 3: repeated keys,
 *             4: repeated Value, 5: extent }
 *   Feature { 1: id, 2: packed tags, 3: geom type, 4: packed geometry }
 *   Value   { 1: string, 2: float, 3: double, 4: int64, 5: uint64,
 *             6: sint64, 7: bool }
 */

const GEOM_TYPE = ['unknown', 'point', 'line', 'polygon'];

/** A cursor over a byte buffer with just the protobuf primitives we need. */
class Reader {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  get done() { return this.pos >= this.end; }

  /** Base-128 varint. JS numbers are exact to 2^53, which covers every field
   *  here except a hypothetical huge feature id — ids are read as Number and
   *  OSM ids are under 2^40, so this is safe. */
  varint() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.buf[this.pos++];
      result += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return result;
      shift += 7;
    }
  }

  /** ZigZag: geometry deltas and sint64 values are encoded this way. */
  svarint() {
    const value = this.varint();
    return value % 2 === 1 ? (value + 1) / -2 : value / 2;
  }

  /** A length-delimited field, returned as a sub-reader over the same bytes. */
  message() {
    const length = this.varint();
    const reader = new Reader(this.buf, this.pos, this.pos + length);
    this.pos += length;
    return reader;
  }

  string() {
    const length = this.varint();
    const text = this.buf.toString('utf8', this.pos, this.pos + length);
    this.pos += length;
    return text;
  }

  float() { const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
  double() { const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }

  /** Skip a field we do not care about, given its wire type. */
  skip(wire) {
    if (wire === 0) { this.varint(); return; }
    if (wire === 1) { this.pos += 8; return; }
    if (wire === 2) { this.pos += this.varint(); return; }
    if (wire === 5) { this.pos += 4; return; }
    throw new Error(`unknown wire type ${wire}`);
  }
}

/** One Value message → a JS scalar. */
function readValue(reader) {
  let value = null;
  while (!reader.done) {
    const tag = reader.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1) value = reader.string();
    else if (field === 2) value = reader.float();
    else if (field === 3) value = reader.double();
    else if (field === 4) value = reader.varint();
    else if (field === 5) value = reader.varint();
    else if (field === 6) value = reader.svarint();
    else if (field === 7) value = Boolean(reader.varint());
    else reader.skip(wire);
  }
  return value;
}

/**
 * Decode a feature's geometry command stream into rings of tile-local
 * coordinates (0..extent). Returns an array of rings; a point feature gets one
 * ring of its points, a line one ring per linestring, a polygon one ring per
 * ring (outer and inner are not distinguished here — winding tells them apart
 * and the probes do not need it).
 */
function readGeometry(reader) {
  const rings = [];
  let ring = null;
  let x = 0;
  let y = 0;

  while (!reader.done) {
    const command = reader.varint();
    const id = command & 7;
    const count = command >> 3;

    if (id === 1 || id === 2) {        // MoveTo / LineTo
      for (let i = 0; i < count; i++) {
        x += reader.svarint();
        y += reader.svarint();
        if (id === 1) {                 // MoveTo always begins a new ring
          ring = [[x, y]];
          rings.push(ring);
        } else {
          ring.push([x, y]);
        }
      }
    } else if (id === 7) {             // ClosePath
      if (ring && ring.length) ring.push([ring[0][0], ring[0][1]]);
    } else {
      break;                            // Unknown command: stop, do not guess.
    }
  }
  return rings;
}

/** One Feature message, resolved against its layer's key and value tables. */
function readFeature(reader, keys, values) {
  const feature = { id: null, type: 'unknown', properties: {}, rings: [] };

  while (!reader.done) {
    const tag = reader.varint();
    const field = tag >> 3;
    const wire = tag & 7;

    if (field === 1) {
      feature.id = reader.varint();
    } else if (field === 2) {
      const packed = reader.message();
      while (!packed.done) {
        const key = keys[packed.varint()];
        const value = values[packed.varint()];
        feature.properties[key] = value;
      }
    } else if (field === 3) {
      feature.type = GEOM_TYPE[reader.varint()] || 'unknown';
    } else if (field === 4) {
      feature.rings = readGeometry(reader.message());
    } else {
      reader.skip(wire);
    }
  }
  return feature;
}

/** One Layer message. Features are decoded eagerly — tiles are small. */
function readLayer(reader) {
  const keys = [];
  const values = [];
  const featureReaders = [];
  let name = '';
  let extent = 4096;
  let version = 1;

  while (!reader.done) {
    const tag = reader.varint();
    const field = tag >> 3;
    const wire = tag & 7;

    if (field === 1) name = reader.string();
    else if (field === 2) featureReaders.push(reader.message());
    else if (field === 3) keys.push(reader.string());
    else if (field === 4) values.push(readValue(reader.message()));
    else if (field === 5) extent = reader.varint();
    else if (field === 15) version = reader.varint();
    else reader.skip(wire);
  }

  const features = featureReaders.map((f) => readFeature(f, keys, values));
  return { name, extent, version, features };
}

/**
 * Decode a whole tile.
 *
 * @param {Buffer|Uint8Array} buffer raw .pbf / .mvt bytes (already gunzipped)
 * @returns {Object<string, {name:string, extent:number, version:number, features:Object[]}>}
 *          layers by name
 */
export function decodeTile(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const reader = new Reader(buf);
  const layers = {};

  while (!reader.done) {
    const tag = reader.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 3) {
      const layer = readLayer(reader.message());
      layers[layer.name] = layer;
    } else {
      reader.skip(wire);
    }
  }
  return layers;
}

/** Slippy tile x/y for a lon/lat at a zoom. Mirrors data/terrain.js. */
export function tileXY(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return [x, y];
}

/** Tile-local coordinate → lon/lat. The inverse of the Web Mercator above. */
export function tileToLonLat(tx, ty, z, px, py, extent) {
  const n = 2 ** z;
  const lon = ((tx + px / extent) / n) * 360 - 180;
  const yy = Math.PI * (1 - 2 * (ty + py / extent) / n);
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(yy));
  return [lon, lat];
}
