// Magic wand: select the contiguous region of one color in the reduced
// raster and outline it as vector loops for the cleanup mask.
import { ALPHA_THRESHOLD, srgbToOklab } from "./preprocess.js?v=53";

/**
 * Pixels 4-connected to (nx, ny) whose opaque color is within `tolerance`
 * (Oklab distance) of the clicked color. Zero matches the exact flat
 * palette color; a little tolerance also takes near shades along edges.
 * @param {{ width: number, height: number, data: Uint8ClampedArray } | null} imageData
 * @param {number} nx normalized x
 * @param {number} ny normalized y
 * @param {number} [tolerance]
 * @returns {{ mask: Uint8Array, width: number, height: number, count: number } | null}
 */
export function floodRegion(imageData, nx, ny, tolerance = 0) {
  if (!imageData?.data || nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
  const { width, height, data } = imageData;
  const sx = Math.min(width - 1, Math.floor(nx * width));
  const sy = Math.min(height - 1, Math.floor(ny * height));
  const seed = (sy * width + sx) * 4;
  if (data[seed + 3] < ALPHA_THRESHOLD) return null;
  const [r, g, b] = [data[seed], data[seed + 1], data[seed + 2]];
  const [L, A, B] = srgbToOklab([r, g, b]);
  const limit = tolerance * tolerance;
  /** @type {Map<number, boolean>} reduced rasters have few colors: test each once */
  const near = new Map();
  const same = (i) => {
    const o = i * 4;
    if (data[o + 3] < ALPHA_THRESHOLD) return false;
    if (data[o] === r && data[o + 1] === g && data[o + 2] === b) return true;
    if (!tolerance) return false;
    const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
    let hit = near.get(key);
    if (hit === undefined) {
      const [l2, a2, b2] = srgbToOklab([data[o], data[o + 1], data[o + 2]]);
      hit = (L - l2) ** 2 + (A - a2) ** 2 + (B - b2) ** 2 <= limit;
      near.set(key, hit);
    }
    return hit;
  };

  const mask = new Uint8Array(width * height);
  const stack = [sy * width + sx];
  mask[stack[0]] = 1;
  let count = 0;
  while (stack.length) {
    const i = /** @type {number} */ (stack.pop());
    count++;
    const x = i % width;
    const neighbours = [
      x > 0 ? i - 1 : -1,
      x < width - 1 ? i + 1 : -1,
      i >= width ? i - width : -1,
      i < width * (height - 1) ? i + width : -1,
    ];
    for (const n of neighbours) {
      if (n >= 0 && !mask[n] && same(n)) {
        mask[n] = 1;
        stack.push(n);
      }
    }
  }
  return { mask, width, height, count };
}

/**
 * Dilate by `radius` pixels (8-neighbourhood per step). Traced shapes have
 * smooth edges that cross the raster's pixel stairs; the margin covers it.
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {number} [radius]
 */
export function growMask(mask, width, height, radius = 1) {
  let out = mask;
  for (let step = 0; step < radius; step++) out = dilateOnce(out, width, height);
  return radius > 0 ? out : Uint8Array.from(mask);
}

function dilateOnce(mask, width, height) {
  const grown = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < width) grown[yy * width + xx] = 1;
        }
      }
    }
  }
  return grown;
}

/** @param {Uint8Array} a @param {Uint8Array} b */
export function unionMasks(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] | b[i];
  return out;
}

/**
 * Outline a mask as closed loops of pixel-edge corners, normalized to 0..1.
 * Each boundary edge is used exactly once, so filling the loops with the
 * even-odd rule reproduces the mask, holes included, however the loops are
 * chained at pinch points.
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @returns {{ x: number, y: number }[][]}
 */
export function maskLoops(mask, width, height) {
  const stride = width + 1;
  const set = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  /** @type {number[]} edge start vertices */
  const from = [];
  /** @type {number[]} edge end vertices */
  const to = [];
  /** @type {Map<number, number[]>} vertex to outgoing edge indices */
  const outgoing = new Map();
  const addEdge = (x1, y1, x2, y2) => {
    const a = y1 * stride + x1;
    from.push(a);
    to.push(y2 * stride + x2);
    const list = outgoing.get(a);
    if (list) list.push(from.length - 1);
    else outgoing.set(a, [from.length - 1]);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!set(x, y)) continue;
      if (!set(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!set(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!set(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!set(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }

  const used = new Uint8Array(from.length);
  const loops = [];
  for (let start = 0; start < from.length; start++) {
    if (used[start]) continue;
    /** @type {number[]} */
    const vertices = [];
    let edge = start;
    while (edge >= 0 && !used[edge]) {
      used[edge] = 1;
      vertices.push(from[edge]);
      const next = outgoing.get(to[edge]) ?? [];
      edge = next.find((e) => !used[e]) ?? -1;
    }
    loops.push(simplify(vertices, stride, width, height));
  }
  return loops;
}

/** Drop vertices where the outline continues in a straight line. */
function simplify(vertices, stride, width, height) {
  const points = [];
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const prev = vertices[(i - 1 + n) % n];
    const cur = vertices[i];
    const next = vertices[(i + 1) % n];
    const dx1 = (cur % stride) - (prev % stride);
    const dy1 = Math.floor(cur / stride) - Math.floor(prev / stride);
    const dx2 = (next % stride) - (cur % stride);
    const dy2 = Math.floor(next / stride) - Math.floor(cur / stride);
    if (dx1 === dx2 && dy1 === dy2) continue;
    points.push({ x: (cur % stride) / width, y: Math.floor(cur / stride) / height });
  }
  return points;
}
