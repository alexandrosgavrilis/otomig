/**
 * The Canvas 2D overlay: one canvas sitting exactly over the MapLibre map,
 * where everything that moves or that the player draws is rendered.
 *
 * MapLibre owns the calm static world. This owns lines, stops, vehicles and
 * passengers, because Mini Metro's line patterns — dotted circles inside a
 * tram line, triangles inside a metro line — are far easier with a path and a
 * stroke than with style rules.
 *
 * The two stay glued together by redrawing on MapLibre's own `render` event and
 * projecting every position through `map.project`. That is the only correct
 * hook: `move` fires too rarely during inertial panning, and a rAF loop of our
 * own would drift a frame behind the map.
 *
 * Phase 1 draws only the region boundary, which is enough to prove the
 * projection and the device-pixel scaling are right. Phase 2 fills it in.
 */

import { COLORS } from '../config.js';

export class Overlay {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {maplibregl.Map} map
   */
  constructor(canvas, map) {
    this.canvas = canvas;
    this.map = map;
    this.ctx = canvas.getContext('2d');
    /** Painters run in order on every frame. Phase 2 pushes lines and vehicles. */
    this.painters = [];

    this._onRender = () => this.draw();
    this._onResize = () => { this.resize(); this.draw(); };

    map.on('render', this._onRender);
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  /**
   * Match the canvas's backing store to the display size times the device pixel
   * ratio, then scale the context so all drawing code can work in CSS pixels.
   * Without this, every line is soft on a high-DPI screen.
   */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth, clientHeight } = this.canvas;
    this.canvas.width = Math.round(clientWidth * dpr);
    this.canvas.height = Math.round(clientHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = clientWidth;
    this.height = clientHeight;
  }

  /** Project a lon/lat to CSS pixels on the canvas. @returns {[number,number]} */
  project(lon, lat) {
    const point = this.map.project([lon, lat]);
    return [point.x, point.y];
  }

  /** Unproject CSS pixels back to lon/lat. @returns {[number,number]} */
  unproject(x, y) {
    const lngLat = this.map.unproject([x, y]);
    return [lngLat.lng, lngLat.lat];
  }

  draw() {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.width, this.height);
    for (const painter of this.painters) painter(ctx, this);
  }

  destroy() {
    this.map.off('render', this._onRender);
    window.removeEventListener('resize', this._onResize);
  }
}

/**
 * A hairline around the imported square, so the edge of the world is visible
 * rather than just an abrupt end to the roads.
 *
 * @param {[number,number,number,number]} bbox
 */
export function regionBoundaryPainter(bbox) {
  const [west, south, east, north] = bbox;
  return (ctx, overlay) => {
    const corners = [[west, south], [east, south], [east, north], [west, north]]
      .map(([lon, lat]) => overlay.project(lon, lat));

    ctx.save();
    ctx.strokeStyle = COLORS.roadMajor;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i][0], corners[i][1]);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  };
}
