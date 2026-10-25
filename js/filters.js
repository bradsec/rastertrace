// Pixel filters run before tracing: specks, soft-edge repair, alpha
// cleanup, smoothing, grayscale and median/mode filters. Mutate in place.
// Pure functions: they run in Node (tests) and the browser (worker/app).
// Images are plain { data: Uint8ClampedArray, width, height } RGBA buffers.

import { ALPHA_THRESHOLD } from "./raster.js?v=1";

/**
 * Cut every pixel to pure black or white: r below the threshold goes
 * black, everything else white. Alpha is untouched. Run after
 * toGrayscale so r is luma; this makes the stencil threshold a user
 * control instead of vtracer's fixed cut at 128.
 * @param {ImageData} img
 * @param {number} threshold
 */
export function thresholdImage(img, threshold) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] < threshold ? 0 : 255;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
  }
}

/**
 * Paint pixels below the alpha threshold with the given opaque color.
 * Binary (stencil) tracing keys on brightness only and ignores alpha, so
 * transparent areas must become background-colored before the trace.
 * @param {ImageData} img
 * @param {number[]} rgb
 */
export function fillTransparent(img, [r, g, b]) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < ALPHA_THRESHOLD) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }
}

/**
 * Speck cleanup after a knockout: clear opaque islands and fill enclosed
 * transparent pinholes smaller than `size` x `size` pixels (the same area
 * rule as the tracer's speckle filter). A pinhole takes the most common
 * opaque color around it, so quantized images keep their palette.
 * Transparent regions touching the border are background, never holes.
 * 4-connected. Mutates img in place.
 * @param {ImageData} img
 * @param {number} size
 */
export function removeSpecks(img, size) {
  const maxArea = size * size;
  if (maxArea <= 1) return img;
  const { data, width, height } = img;
  const n = width * height;
  /**
   * @param {number} p
   */
  const opaque = (p) => data[p * 4 + 3] >= ALPHA_THRESHOLD;
  const seen = new Uint8Array(n);
  const queue = new Uint32Array(n);
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    const isOpaque = opaque(start);
    seen[start] = 1;
    queue[0] = start;
    let count = 1;
    let touchesBorder = false;
    // Neighbor colors across the region boundary, for pinhole fill.
    const around = new Map();
    for (let head = 0; head < count; head++) {
      const p = queue[head];
      const x = p % width;
      const y = (p / width) | 0;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      for (const q of [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ]) {
        if (q < 0) continue;
        if (opaque(q) !== isOpaque) {
          if (!isOpaque && count < maxArea) {
            const j = q * 4;
            const key = (data[j] << 16) | (data[j + 1] << 8) | data[j + 2];
            around.set(key, (around.get(key) || 0) + 1);
          }
          continue;
        }
        if (!seen[q]) {
          seen[q] = 1;
          queue[count++] = q;
        }
      }
    }
    if (count >= maxArea) continue;
    if (isOpaque) {
      for (let k = 0; k < count; k++) data[queue[k] * 4 + 3] = 0;
    } else if (!touchesBorder && around.size) {
      let fill = 0;
      let best = -1;
      for (const [key, c] of around) {
        if (c > best) {
          best = c;
          fill = key;
        }
      }
      for (let k = 0; k < count; k++) {
        const i = queue[k] * 4;
        data[i] = (fill >> 16) & 0xff;
        data[i + 1] = (fill >> 8) & 0xff;
        data[i + 2] = fill & 0xff;
        data[i + 3] = 255;
      }
    }
  }
  return img;
}

// unblendEdges: how far (source px) a pixel looks for the two fills a
// soft edge blends, and how close (RGB) a color must sit to the segment
// between two fills to count as their blend.
export const BLEND_REACH = 20;
const BLEND_TOLERANCE = 24;
// A pixel this close (RGB) to its fill is solid, not a blend, and a
// pixel weighs at most this many nearby fills as blend ends.
const BLEND_MATCH = 10;
const BLEND_CANDIDATES = 8;
// A fill this close (share of the way) to either end of a blend counts
// as a shade of that end, not a gradient band.
const BLEND_BAND_END = 0.15;

/**
 * Soft-edge repair after color reduction. A blurred or anti-aliased edge
 * between two fills holds blends of them, and snapping each blend to the
 * nearest palette color can land on a third color (a navy and cream blur
 * turns teal), leaving a stripe of it along the edge. Each palette color
 * stands for its fill: the original color most of its pixels had, which
 * My colors swatches can differ from. A pixel whose original color is a
 * blend of two fills found within `reach` pixels, and closer to that
 * blend than to its own fill, takes the palette color of the one its
 * blend leans to, so the edge splits where the mix crosses half. Real
 * outlines (the original matches its fill) and gradient bands (its fill
 * is itself between the two) stay. `original` holds the colors before
 * reduction. Mutates img.
 * @param {ImageData} img
 * @param {Uint8ClampedArray} original
 * @param {number} reach
 */
export function unblendEdges(img, original, reach) {
  if (reach < 1) return img;
  const { data, width, height } = img;
  const n = width * height;
  // Every step near the pixel, then growing by half: a ray only has to
  // cross the blend band and land on the fill beyond it, and upscaled
  // sources stretch `reach` to dozens of pixels.
  const steps = [];
  for (let step = 1; step <= reach; step = step < 4 ? step + 1 : Math.ceil(step * 1.5)) {
    steps.push(step);
  }
  if (steps.at(-1) !== reach) steps.push(reach);
  const stepCount = steps.length;
  const directions = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];
  // Pixels by palette index, tallying original colors per index. Flat
  // art repeats each pair along a row, so runs are counted, not pixels.
  const ids = new Int32Array(n);
  const paletteIds = new Map();
  const palette = [];
  const tally = new Map();
  const COLOR = 0x1000000;
  let lastKey = -1;
  let lastId = -1;
  let runPair = -1;
  let runLength = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (data[i + 3] < ALPHA_THRESHOLD) {
      ids[p] = -1;
      continue;
    }
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (key !== lastKey) {
      lastKey = key;
      lastId = paletteIds.get(key) ?? -1;
      if (lastId === -1) {
        lastId = palette.length;
        paletteIds.set(key, lastId);
        palette.push(key);
      }
    }
    ids[p] = lastId;
    const pair = lastId * COLOR + ((original[i] << 16) | (original[i + 1] << 8) | original[i + 2]);
    if (pair === runPair) {
      runLength++;
      continue;
    }
    if (runLength) tally.set(runPair, (tally.get(runPair) || 0) + runLength);
    runPair = pair;
    runLength = 1;
  }
  if (runLength) tally.set(runPair, (tally.get(runPair) || 0) + runLength);
  const fills = new Int32Array(palette.length);
  const fillCounts = new Float64Array(palette.length);
  for (const [pair, count] of tally) {
    const id = Math.floor(pair / COLOR);
    if (count > fillCounts[id]) {
      fillCounts[id] = count;
      fills[id] = pair % COLOR;
    }
  }
  // Solid pixels match their fill: the colors a blend can mix. Blend
  // pixels, whatever color they snapped to, are never ends, and in flat
  // art they are the only pixels left to look at.
  // Squared distances throughout: Math.hypot is slow in WebKit.
  const match2 = BLEND_MATCH * BLEND_MATCH;
  const tolerance2 = BLEND_TOLERANCE * BLEND_TOLERANCE;
  const solid = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    if (ids[p] === -1) continue;
    const i = p * 4;
    const fill = fills[ids[p]];
    const dr = original[i] - ((fill >> 16) & 0xff);
    const dg = original[i + 1] - ((fill >> 8) & 0xff);
    const db = original[i + 2] - (fill & 0xff);
    if (dr * dr + dg * dg + db * db <= match2) solid[p] = 1;
  }
  // Rays read ids, so writing data as we go cannot feed later pixels.
  const seen = new Int32Array(BLEND_CANDIDATES);
  for (let p = 0; p < n; p++) {
    const own = ids[p];
    if (own === -1 || solid[p]) continue;
    const i = p * 4;
    const or = original[i];
    const og = original[i + 1];
    const ob = original[i + 2];
    const ownFill = fills[own];
    const cr = (ownFill >> 16) & 0xff;
    const cg = (ownFill >> 8) & 0xff;
    const cb = ownFill & 0xff;
    const ownDistance2 = (or - cr) ** 2 + (og - cg) ** 2 + (ob - cb) ** 2;
    const x0 = p % width;
    const y0 = (p - x0) / width;
    let count = 0;
    for (let d = 0; d < 16 && count < BLEND_CANDIDATES; d += 2) {
      const dx = directions[d];
      const dy = directions[d + 1];
      // Indexed: for-of over an array is several times slower in WebKit.
      for (let k = 0; k < stepCount; k++) {
        const step = steps[k];
        const x = x0 + dx * step;
        const y = y0 + dy * step;
        if (x < 0 || y < 0 || x >= width || y >= height) break;
        const q = y * width + x;
        const id = ids[q];
        if (id === -1) break;
        // Keep walking past the first fill: a blend shade the palette
        // picked up can sit between this pixel and the real fill.
        if (!solid[q] || id === own) continue;
        let known = false;
        for (let m = 0; m < count; m++) if (seen[m] === id) known = true;
        if (!known) seen[count++] = id;
        if (count === BLEND_CANDIDATES) break;
      }
    }
    if (count < 2) continue;
    let bestResidual2 = Math.min(ownDistance2, tolerance2);
    let pick = own;
    for (let m = 0; m < count; m++) {
      const a = fills[seen[m]];
      const ar = (a >> 16) & 0xff;
      const ag = (a >> 8) & 0xff;
      const ab = a & 0xff;
      for (let j = m + 1; j < count; j++) {
        const b = fills[seen[j]];
        const dr = ((b >> 16) & 0xff) - ar;
        const dg = ((b >> 8) & 0xff) - ag;
        const db = (b & 0xff) - ab;
        const len2 = dr * dr + dg * dg + db * db;
        if (!len2) continue;
        const t = ((or - ar) * dr + (og - ag) * dg + (ob - ab) * db) / len2;
        if (t < 0 || t > 1) continue;
        const residual2 =
          (or - ar - t * dr) ** 2 + (og - ag - t * dg) ** 2 + (ob - ab - t * db) ** 2;
        if (residual2 >= bestResidual2) continue;
        // The pixel's own fill partway between the two is a gradient
        // band. One next to an end is a blend shade the palette picked up.
        const u = ((cr - ar) * dr + (cg - ag) * dg + (cb - ab) * db) / len2;
        if (
          u >= BLEND_BAND_END &&
          u <= 1 - BLEND_BAND_END &&
          (cr - ar - u * dr) ** 2 + (cg - ag - u * dg) ** 2 + (cb - ab - u * db) ** 2 < tolerance2
        ) {
          continue;
        }
        bestResidual2 = residual2;
        pick = t < 0.5 ? seen[m] : seen[j];
      }
    }
    if (pick === own) continue;
    const color = palette[pick];
    data[i] = (color >> 16) & 0xff;
    data[i + 1] = (color >> 8) & 0xff;
    data[i + 2] = color & 0xff;
  }
  return img;
}

// despeckleColors: a thin region is kept as a line when this share of
// its boundary touches one color; a thin region whose color lies within
// SLIVER_DISTANCE (RGB) of the segment between its two main neighbors is
// a blend sliver left by color reduction.
const LINE_SIDE_SHARE = 0.8;
const SLIVER_DISTANCE = 40;

/**
 * Speck removal on a color-reduced image, in place of the tracer's own
 * filter. The tracer drops every region smaller than `size` x `size`
 * pixels and also every region whose perimeter reaches its area: each
 * line 2 px wide or thinner, however long. Here a small region merges
 * into the color it borders most (or turns transparent when that is
 * transparency), and a thin region goes only when it is a blend sliver
 * between two colors; lines on one color and outlines between two fills
 * stay. Repeats until nothing changes (at most 4 passes), since merged
 * specks can leave new ones. 4-connected, exact colors. Mutates img.
 * @param {ImageData} img
 * @param {number} size
 */
export function despeckleColors(img, size) {
  const minArea = size * size;
  if (minArea <= 1) return img;
  const { data, width, height } = img;
  const n = width * height;
  const keys = new Int32Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    keys[p] =
      data[i + 3] < ALPHA_THRESHOLD ? -1 : (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
  }
  const label = new Int32Array(n);
  const queue = new Int32Array(n);
  const neighbors = [0, 0, 0, 0];
  const around = new Map();
  for (let pass = 0; pass < 4; pass++) {
    label.fill(-1);
    /** @type {{ start: number, count: number, thin: boolean }[]} */
    const candidates = [];
    let next = 0;
    let end = 0;
    for (let s = 0; s < n; s++) {
      if (label[s] !== -1) continue;
      const key = keys[s];
      const start = end;
      label[s] = next;
      queue[end++] = s;
      let perimeter = 0;
      for (let head = start; head < end; head++) {
        const p = queue[head];
        const x = p % width;
        let k = 0;
        if (x > 0) neighbors[k++] = p - 1;
        if (x < width - 1) neighbors[k++] = p + 1;
        if (p >= width) neighbors[k++] = p - width;
        if (p + width < n) neighbors[k++] = p + width;
        for (let j = 0; j < k; j++) {
          const q = neighbors[j];
          if (keys[q] !== key) {
            perimeter += 1;
          } else if (label[q] === -1) {
            label[q] = next;
            queue[end++] = q;
          }
        }
      }
      const count = end - start;
      if (key !== -1 && (count < minArea || perimeter >= count)) {
        candidates.push({ start, count, thin: count >= minArea });
      }
      next += 1;
    }
    candidates.sort((a, b) => a.count - b.count);
    let changed = false;
    for (const { start, count, thin } of candidates) {
      const own = keys[queue[start]];
      around.clear();
      let total = 0;
      for (let m = start; m < start + count; m++) {
        const p = queue[m];
        const x = p % width;
        let k = 0;
        if (x > 0) neighbors[k++] = p - 1;
        if (x < width - 1) neighbors[k++] = p + 1;
        if (p >= width) neighbors[k++] = p - width;
        if (p + width < n) neighbors[k++] = p + width;
        for (let j = 0; j < k; j++) {
          const other = keys[neighbors[j]];
          if (other === own) continue;
          around.set(other, (around.get(other) || 0) + 1);
          total += 1;
        }
      }
      if (!total) continue;
      let fill = own;
      let best = 0;
      let second = own;
      let secondBest = 0;
      for (const [other, c] of around) {
        if (c > best) {
          second = fill;
          secondBest = best;
          fill = other;
          best = c;
        } else if (c > secondBest) {
          second = other;
          secondBest = c;
        }
      }
      if (thin) {
        if (best >= total * LINE_SIDE_SHARE) continue; // a line on one color
        if (fill === -1 || second === -1 || secondBest === 0) continue;
        if (!betweenColors(own, fill, second)) continue; // an outline
      }
      changed = true;
      for (let m = start; m < start + count; m++) keys[queue[m]] = fill;
    }
    if (!changed) break;
  }
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const key = keys[p];
    if (key === -1) {
      data[i + 3] = 0;
      continue;
    }
    data[i] = (key >> 16) & 0xff;
    data[i + 1] = (key >> 8) & 0xff;
    data[i + 2] = key & 0xff;
  }
  return img;
}

/**
 * Whether color `c` lies near the RGB segment from `a` to `b` (blend).
 * @param {number} c packed 0xRRGGBB
 * @param {number} a packed 0xRRGGBB
 * @param {number} b packed 0xRRGGBB
 */
function betweenColors(c, a, b) {
  /**
   * @param {number} key
   */
  const rgb = (key) => [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff];
  const [cr, cg, cb] = rgb(c);
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const dr = br - ar;
  const dg = bg - ag;
  const db = bb - ab;
  const len2 = dr * dr + dg * dg + db * db;
  if (!len2) return false;
  const t = ((cr - ar) * dr + (cg - ag) * dg + (cb - ab) * db) / len2;
  if (t <= 0 || t >= 1) return false;
  return Math.hypot(cr - (ar + t * dr), cg - (ag + t * dg), cb - (ab + t * db)) < SLIVER_DISTANCE;
}

/**
 * Matte choke: peel `passes` one-pixel rings off the opaque region,
 * clearing the alpha of opaque pixels 4-adjacent to transparency. Eats
 * the background-blend fringe left along subject boundaries after a
 * knockout, whatever color the fringe is; thin features shrink by the
 * same amount, so the amount is user-controlled. Mutates img in place.
 * @param {ImageData} img
 * @param {number} passes
 */
export function erodeAlpha(img, passes) {
  const { data, width, height } = img;
  for (let pass = 0; pass < passes; pass++) {
    const peel = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (data[p * 4 + 3] < ALPHA_THRESHOLD) continue;
        if (
          (x > 0 && data[(p - 1) * 4 + 3] < ALPHA_THRESHOLD) ||
          (x < width - 1 && data[(p + 1) * 4 + 3] < ALPHA_THRESHOLD) ||
          (y > 0 && data[(p - width) * 4 + 3] < ALPHA_THRESHOLD) ||
          (y < height - 1 && data[(p + width) * 4 + 3] < ALPHA_THRESHOLD)
        ) {
          peel.push(p);
        }
      }
    }
    if (peel.length === 0) break;
    for (const p of peel) data[p * 4 + 3] = 0;
  }
  return img;
}

/**
 * Two passes of a separable running-sum box blur with a (2r+1) window,
 * in place. Values past the edges repeat the nearest edge value.
 * @param {Float32Array} values
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 */
function boxBlur(values, width, height, radius) {
  const window = 2 * radius + 1;
  // One line at a time, padded by `radius` repeats of each end so the
  // running sum needs no bounds checks (slow in WebKit).
  const line = new Float32Array(width + 2 * radius + 1);
  /**
   * @param {number} length
   * @param {number} count
   * @param {number} stride
   * @param {number} step
   */
  const blur = (length, count, stride, step) => {
    for (let l = 0; l < count; l++) {
      const base = l * stride;
      const first = values[base];
      const last = values[base + (length - 1) * step];
      for (let k = 0; k < radius; k++) line[k] = first;
      for (let i = 0; i < length; i++) line[radius + i] = values[base + i * step];
      for (let k = radius + length; k <= length + 2 * radius; k++) line[k] = last;
      let sum = 0;
      for (let k = 0; k <= 2 * radius; k++) sum += line[k];
      for (let i = 0; i < length; i++) {
        values[base + i * step] = sum / window;
        sum += line[i + 2 * radius + 1] - line[i];
      }
    }
  };
  // Columns run a row at a time over a snapshot: walking a column one
  // stride apart misses the cache on every read.
  const source = new Float32Array(values.length);
  const sums = new Float64Array(width);
  /**
   * @param {number} y
   */
  const row = (y) => Math.min(height - 1, Math.max(0, y)) * width;
  const blurColumns = () => {
    source.set(values);
    sums.fill(0);
    for (let k = -radius; k <= radius; k++) {
      const r = row(k);
      for (let x = 0; x < width; x++) sums[x] += source[r + x];
    }
    for (let y = 0; y < height; y++) {
      const out = y * width;
      const add = row(y + radius + 1);
      const drop = row(y - radius);
      for (let x = 0; x < width; x++) {
        values[out + x] = sums[x] / window;
        sums[x] += source[add + x] - source[drop + x];
      }
    }
  };
  for (let pass = 0; pass < 2; pass++) {
    blur(width, height, width, 1);
    blurColumns();
  }
}

/**
 * Matte smoothing: box-blur the opaque mask twice with a (2r+1) window and
 * threshold it at half, so bumps and notches narrower than about `radius`
 * flatten while straight edges stay put; corners round by about `radius`
 * and features thinner than it vanish. Pixels outside the image count as
 * their nearest edge pixel, so the canvas border is not eaten. Newly
 * opaque pixels take the color of an adjacent opaque pixel. Mutates img.
 * @param {ImageData} img
 * @param {number} radius
 */
export function smoothAlpha(img, radius) {
  if (radius <= 0) return img;
  const { data, width, height } = img;
  const n = width * height;
  const mask = new Float32Array(n);
  for (let p = 0; p < n; p++) mask[p] = data[p * 4 + 3] >= ALPHA_THRESHOLD ? 1 : 0;
  boxBlur(mask, width, height, radius);

  /** @type {number[]} newly opaque pixels still waiting for a color */
  let pending = [];
  for (let p = 0; p < n; p++) {
    const was = data[p * 4 + 3] >= ALPHA_THRESHOLD;
    const now = mask[p] >= 0.5;
    if (was && !now) data[p * 4 + 3] = 0;
    else if (!was && now) pending.push(p);
  }
  const colored = new Uint8Array(n);
  for (let p = 0; p < n; p++) colored[p] = data[p * 4 + 3] >= ALPHA_THRESHOLD ? 1 : 0;
  // Grow colors ring by ring into the filled-in pixels.
  while (pending.length) {
    const next = [];
    const filled = [];
    for (const p of pending) {
      const x = p % width;
      const neighbours = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        p >= width ? p - width : -1,
        p < n - width ? p + width : -1,
      ];
      const source = neighbours.find((q) => q >= 0 && colored[q]);
      if (source === undefined) next.push(p);
      else filled.push([p, source]);
    }
    if (!filled.length) break;
    for (const [p, q] of filled) {
      data.copyWithin(p * 4, q * 4, q * 4 + 3);
      data[p * 4 + 3] = 255;
      colored[p] = 1;
    }
    pending = next;
  }
  return img;
}

/**
 * Distance in pixels from each set bit of a mask to the nearest unset bit
 * or the mask's edge (chamfer 3-4, so diagonals cost about √2). Unset
 * bits are 0.
 * @param {Uint8Array} bits
 * @param {number} width
 * @param {number} height
 */
function maskDepth(bits, width, height) {
  const far = 3 * (width + height);
  const depth = new Int32Array(width * height);
  for (let p = 0; p < depth.length; p++) depth[p] = bits[p] ? far : 0;
  /**
   * @param {number} x
   * @param {number} y
   */
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : depth[y * width + x]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!depth[p]) continue;
      depth[p] = Math.min(
        depth[p],
        at(x - 1, y) + 3,
        at(x, y - 1) + 3,
        at(x - 1, y - 1) + 4,
        at(x + 1, y - 1) + 4,
      );
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const p = y * width + x;
      if (!depth[p]) continue;
      depth[p] = Math.min(
        depth[p],
        at(x + 1, y) + 3,
        at(x, y + 1) + 3,
        at(x + 1, y + 1) + 4,
        at(x - 1, y + 1) + 4,
      );
    }
  }
  return Float32Array.from(depth, (d) => d / 3);
}

// smoothLabels: colors that take part in a stroke's vote, most common
// first. Reduced images have a handful; an unreduced photo has thousands,
// and its rare shades would only add cost.
const SMOOTH_COLORS = 16;
const SMOOTH_PASSES = 3;

/**
 * Smooth brush: inside each stroke, every pixel takes the color that most
 * of its surroundings have, so bumps, notches and stair steps narrower
 * than about `radius` flatten while longer edges stay put. Each color's
 * mask is box-blurred twice (as smoothAlpha does for the matte) over the
 * stroke's box grown by the blur's reach, the strongest color wins, and
 * the vote repeats `passes` times.
 * Transparency counts as a color, so erased edges smooth too, and no new
 * colors appear. `regions` hold a stroke's mask in image pixels: { x, y,
 * width, height, bits (1 inside), radius }. Mutates img in place.
 * @param {{ x: number, y: number, width: number, height: number, bits: Uint8Array, radius: number }[]} regions
 * @param {ImageData} img
 */
export function smoothLabels(img, regions, passes = SMOOTH_PASSES) {
  const { data, width, height } = img;
  for (const region of regions) {
    const radius = Math.max(1, Math.round(region.radius));
    const reach = 2 * radius;
    const x0 = Math.max(0, region.x - reach);
    const y0 = Math.max(0, region.y - reach);
    const x1 = Math.min(width, region.x + region.width + reach);
    const y1 = Math.min(height, region.y + region.height + reach);
    const boxWidth = x1 - x0;
    const boxHeight = y1 - y0;
    if (boxWidth <= 0 || boxHeight <= 0) continue;
    const area = boxWidth * boxHeight;
    const depth = maskDepth(region.bits, region.width, region.height);
    const keys = new Int32Array(area);
    const best = new Float32Array(area);
    const winner = new Int32Array(area);
    const own = new Float32Array(area);
    const weight = new Float32Array(area);
    // One vote moves edges but keeps each color's area, so a notch only
    // spreads into a shallow dip; repeating it flattens the dip, as
    // curvature flow does.
    for (let pass = 0; pass < passes; pass++) {
      // Color key per box pixel; -1 is transparent.
      const counts = new Map();
      for (let y = 0; y < boxHeight; y++) {
        for (let x = 0; x < boxWidth; x++) {
          const i = ((y + y0) * width + x + x0) * 4;
          const key =
            data[i + 3] < ALPHA_THRESHOLD ? -1 : (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
          keys[y * boxWidth + x] = key;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
      const colors = [...counts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, SMOOTH_COLORS)
        .map(([key]) => key);
      if (colors.length < 2) break;
      best.fill(-1);
      own.fill(0);
      for (const key of colors) {
        for (let p = 0; p < area; p++) weight[p] = keys[p] === key ? 1 : 0;
        boxBlur(weight, boxWidth, boxHeight, radius);
        for (let p = 0; p < area; p++) {
          if (keys[p] === key) own[p] = weight[p];
          if (weight[p] > best[p]) {
            best[p] = weight[p];
            winner[p] = key;
          }
        }
      }
      for (let y = 0; y < region.height; y++) {
        const by = y + region.y - y0;
        if (by < 0 || by >= boxHeight) continue;
        for (let x = 0; x < region.width; x++) {
          const bx = x + region.x - x0;
          if (bx < 0 || bx >= boxWidth || !region.bits[y * region.width + x]) continue;
          const p = by * boxWidth + bx;
          const key = winner[p];
          if (key === keys[p]) continue;
          // Fade in from the stroke's edge, so the edges it moves meet
          // the untouched ones outside without a step.
          const strength = Math.min(1, depth[y * region.width + x] / radius);
          if (strength * best[p] <= strength * own[p] + (1 - strength)) continue;
          const i = ((by + y0) * width + bx + x0) * 4;
          if (key === -1) {
            data[i + 3] = 0;
          } else {
            data[i] = (key >> 16) & 0xff;
            data[i + 1] = (key >> 8) & 0xff;
            data[i + 2] = key & 0xff;
            data[i + 3] = 255;
          }
        }
      }
    }
  }
  return img;
}

/**
 * Smooth outlines: one smoothLabels vote over the whole image at `radius`
 * (trace pixels), clearing the pixel-level steps and noise reduced flat
 * art leaves along its edges. One pass keeps lines a few pixels wide that
 * repeated votes would thin. Mutates img in place.
 * @param {ImageData} img
 * @param {number} radius
 */
export function smoothOutlines(img, radius) {
  if (radius <= 0) return img;
  const { width, height } = img;
  const bits = new Uint8Array(width * height).fill(1);
  return smoothLabels(img, [{ x: 0, y: 0, width, height, bits, radius }], 1);
}

/**
 * Matte defringe: recolor the outermost `depth` rings of the opaque
 * region from the colors one ring deeper, hiding background-blend fringe
 * without shrinking the shape. Complements erodeAlpha: trim deletes
 * boundary pixels (thin features shrink), defringe repaints them. Rings
 * are processed from the innermost fringe ring outward so interior colors
 * propagate to the edge; pixels with no deeper neighbor (features thinner
 * than 2*depth) keep their original color. With `keepPalette` a fringe
 * pixel takes the most common deeper color instead of their average, so a
 * color-reduced image gains no new colors. Mutates img in place.
 * @param {ImageData} img
 * @param {number} depth
 * @param {{ keepPalette?: boolean }} [options]
 */
export function defringeAlpha(img, depth, { keepPalette = false } = {}) {
  if (depth <= 0) return img;
  const { data, width, height } = img;
  const n = width * height;
  // BFS distance from transparency: 0 transparent, d for the d-th opaque
  // ring, -1 for opaque pixels deeper than `depth` (clean interior).
  const dist = new Int32Array(n).fill(-1);
  let queue = [];
  for (let p = 0; p < n; p++) {
    if (data[p * 4 + 3] < ALPHA_THRESHOLD) {
      dist[p] = 0;
      queue.push(p);
    }
  }
  if (queue.length === 0 || queue.length === n) return img;
  /**
   * @type {number[][]}
   */
  const rings = [];
  for (let d = 1; d <= depth && queue.length; d++) {
    /**
     * @type {number[]}
     */
    const next = [];
    for (const p of queue) {
      const x = p % width;
      const y = (p / width) | 0;
      /**
       * @param {number} q
       */
      const grow = (q) => {
        if (dist[q] === -1) {
          dist[q] = d;
          next.push(q);
        }
      };
      if (x > 0) grow(p - 1);
      if (x < width - 1) grow(p + 1);
      if (y > 0) grow(p - width);
      if (y < height - 1) grow(p + width);
    }
    rings.push(next);
    queue = next;
  }

  for (let d = rings.length; d >= 1; d--) {
    for (const p of rings[d - 1]) {
      const x = p % width;
      const y = (p / width) | 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      /** @type {Map<number, number>} deeper colors by vote, for keepPalette */
      const votes = new Map();
      let winner = -1;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const q = ny * width + nx;
          // Pull only from deeper rings (already repainted) or interior.
          if (q === p || (dist[q] !== -1 && dist[q] <= d)) continue;
          const j = q * 4;
          r += data[j];
          g += data[j + 1];
          b += data[j + 2];
          count += 1;
          if (keepPalette) {
            const key = (data[j] << 16) | (data[j + 1] << 8) | data[j + 2];
            const tally = (votes.get(key) ?? 0) + 1;
            votes.set(key, tally);
            if (winner < 0 || tally > (votes.get(winner) ?? 0)) winner = key;
          }
        }
      }
      if (count > 0) {
        const j = p * 4;
        if (keepPalette) {
          data[j] = (winner >> 16) & 0xff;
          data[j + 1] = (winner >> 8) & 0xff;
          data[j + 2] = winner & 0xff;
        } else {
          data[j] = r / count;
          data[j + 1] = g / count;
          data[j + 2] = b / count;
        }
      }
    }
  }
  return img;
}

/**
 * Threshold alpha to 0 or 255 so anti-aliased edge fringe cannot fragment
 * the trace into junk paths. Mutates img in place.
 * @param {ImageData} img
 */
export function binarizeAlpha(img) {
  const { data } = img;
  for (let i = 3; i < data.length; i += 4) {
    data[i] = data[i] >= ALPHA_THRESHOLD ? 255 : 0;
  }
  return img;
}

/**
 * Luminance (Rec. 601) grayscale conversion, alpha preserved. In place.
 * @param {ImageData} img
 */
export function toGrayscale(img) {
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) {
    const l = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = l;
  }
  return img;
}

/**
 * Convert an RGB color with the same luma calculation as toGrayscale.
 * @param {[number, number, number]} color
 * @returns {[number, number, number]}
 */
export function toGrayscaleColor([r, g, b]) {
  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  return [gray, gray, gray];
}

/**
 * 3x3 per-channel median filter on opaque RGB, repeated `passes` times.
 * Kills sensor/compression noise while preserving edges exactly, unlike
 * a blur which grays the very boundaries the tracer follows. Alpha is
 * untouched and transparent neighbors are excluded from the window.
 * @param {ImageData} img
 */
export function medianFilter(img, passes = 1) {
  const { data, width, height } = img;
  const out = new Uint8ClampedArray(data.length);
  // A 3x3 window holds at most nine samples per channel. One fixed buffer
  // plus an insertion sort avoids three Array#sort calls with a JS
  // comparator per pixel, which dominated the cost of this filter.
  const win = new Uint8Array(27);

  for (let pass = 0; pass < passes; pass++) {
    out.set(data);
    for (let y = 0; y < height; y++) {
      const yStart = y > 0 ? -1 : 0;
      const yEnd = y < height - 1 ? 1 : 0;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i + 3] < ALPHA_THRESHOLD) continue;
        const xStart = x > 0 ? -1 : 0;
        const xEnd = x < width - 1 ? 1 : 0;
        let count = 0;
        for (let dy = yStart; dy <= yEnd; dy++) {
          let j = ((y + dy) * width + x + xStart) * 4;
          for (let dx = xStart; dx <= xEnd; dx++, j += 4) {
            if (data[j + 3] < ALPHA_THRESHOLD) continue;
            win[count] = data[j];
            win[count + 9] = data[j + 1];
            win[count + 18] = data[j + 2];
            count += 1;
          }
        }
        const mid = count >> 1;
        for (let c = 0; c < 3; c++) {
          const base = c * 9;
          for (let k = base + 1; k < base + count; k++) {
            const value = win[k];
            let m = k - 1;
            while (m >= base && win[m] > value) {
              win[m + 1] = win[m];
              m -= 1;
            }
            win[m + 1] = value;
          }
          out[i + c] = win[base + mid];
        }
      }
    }
    data.set(out);
  }
  return img;
}

/**
 * 3x3 majority filter on opaque RGB values. Cleans single-pixel dithering
 * left along region boundaries after quantization, which otherwise traces
 * into hundreds of tiny paths. Alpha is untouched. Returns a new buffer
 * written back into img.
 * @param {ImageData} img
 */
export function modeFilter(img) {
  const { data, width, height } = img;
  const out = new Uint8ClampedArray(data);
  // At most nine neighbors, so a linear scan over fixed buffers beats
  // hashing each key through a Map that has to be cleared per pixel.
  const keys = new Int32Array(9);
  const tally = new Int32Array(9);
  for (let y = 0; y < height; y++) {
    const yStart = y > 0 ? -1 : 0;
    const yEnd = y < height - 1 ? 1 : 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < ALPHA_THRESHOLD) continue;
      const xStart = x > 0 ? -1 : 0;
      const xEnd = x < width - 1 ? 1 : 0;
      let unique = 0;
      let best = -1;
      let bestCount = 0;
      for (let dy = yStart; dy <= yEnd; dy++) {
        let j = ((y + dy) * width + x + xStart) * 4;
        for (let dx = xStart; dx <= xEnd; dx++, j += 4) {
          if (data[j + 3] < ALPHA_THRESHOLD) continue;
          const key = (data[j] << 16) | (data[j + 1] << 8) | data[j + 2];
          let slot = 0;
          while (slot < unique && keys[slot] !== key) slot += 1;
          if (slot === unique) {
            keys[slot] = key;
            tally[slot] = 0;
            unique += 1;
          }
          const n = ++tally[slot];
          if (n > bestCount) {
            bestCount = n;
            best = key;
          }
        }
      }
      // Replace only clear majorities so real detail survives.
      if (best >= 0 && bestCount >= 5) {
        out[i] = (best >> 16) & 0xff;
        out[i + 1] = (best >> 8) & 0xff;
        out[i + 2] = best & 0xff;
      }
    }
  }
  data.set(out);
  return img;
}
