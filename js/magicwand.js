// Magic wand: select the contiguous region of one color in the rendered
// result and outline it as vector loops for the cleanup mask.
import { ALPHA_THRESHOLD, srgbToOklab } from "./preprocess.js?v=69";

/**
 * Pixels 4-connected to (nx, ny) whose opaque color is within `tolerance`
 * (Oklab distance) of the clicked color. Zero matches the exact flat
 * fill color; a little tolerance also takes near-duplicate traced fills.
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
 * `smooth` (pixels) rounds the pixel staircase into straight diagonals and
 * curves; 0 keeps the exact pixel outline.
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {number} [smooth]
 * @returns {{ x: number, y: number }[][]}
 */
export function maskLoops(mask, width, height, smooth = 0) {
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
    let points = corners(vertices, stride);
    if (smooth > 0) points = simplifyPath(smoothLoop(points, smooth), 0.35);
    loops.push(points.map((point) => ({ x: point.x / width, y: point.y / height })));
  }
  return loops;
}

const SMOOTH_PASSES = 2;

/**
 * Resample the loop every pixel, then average each point with its
 * neighbours within `smooth` pixels along the outline. Points on a straight
 * edge average to that edge, so lines stay straight while stair steps and
 * bumps up to about `smooth` pixels wide flatten out.
 */
function smoothLoop(points, smooth) {
  /** @type {{ x: number, y: number }[]} */
  let loop = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let k = 0; k < steps; k++) {
      loop.push({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps });
    }
  }
  // A window wider than half the loop would collapse small islands.
  const half = Math.min(Math.round(smooth), Math.floor((loop.length - 1) / 4));
  if (half < 1) return loop;
  const n = loop.length;
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const next = new Array(n);
    for (let i = 0; i < n; i++) {
      let x = 0;
      let y = 0;
      for (let k = -half; k <= half; k++) {
        const p = loop[(i + k + n) % n];
        x += p.x;
        y += p.y;
      }
      next[i] = { x: x / (2 * half + 1), y: y / (2 * half + 1) };
    }
    loop = next;
  }
  return loop;
}

/** Ramer-Douglas-Peucker on a closed loop, split at its farthest point. */
function simplifyPath(points, tolerance) {
  if (points.length < 4) return points;
  let far = 0;
  let best = -1;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[0].x, points[i].y - points[0].y);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const first = rdp(points.slice(0, far + 1), tolerance);
  const second = rdp([...points.slice(far), points[0]], tolerance);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

function rdp(points, tolerance) {
  if (points.length < 3) return points;
  const a = points[0];
  const b = points.at(-1);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  let index = 0;
  let max = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = Math.abs(dy * points[i].x - dx * points[i].y + b.x * a.y - b.y * a.x) / length;
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= tolerance) return [a, b];
  return [
    ...rdp(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...rdp(points.slice(index), tolerance),
  ];
}

/** Pixel-corner vertices where the outline turns, in pixel units. */
function corners(vertices, stride) {
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
    points.push({ x: cur % stride, y: Math.floor(cur / stride) });
  }
  return points;
}
