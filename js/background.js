// Background removal: border detection, knockout, fringe repair, and the
// reduce-then-remove step that combines them with quantization.
// Pure functions: they run in Node (tests) and the browser (worker/app).
// Images are plain { data: Uint8ClampedArray, width, height } RGBA buffers.

import { linearLut, oklabInto, srgbToOklab } from "./color.js?v=2";
import { BLEND_REACH, modeFilter, unblendEdges } from "./filters.js?v=1";
import { mapToPalette, quantize } from "./quantize.js?v=2";
import { ALPHA_THRESHOLD, tracePixels } from "./raster.js?v=1";
import { DEFAULTS, ENCLOSED_NO_LIMIT } from "./settings-schema.js?v=2";

/**
 * Dominant border color, or null when the border is mostly transparent.
 * Samples the border ring plus 4x4 corner patches and bins samples
 * coarsely (16 levels per channel), returning the average color of the
 * dominant bin: single corner pixels are one JPEG artifact or watermark
 * away from the wrong answer, and binning absorbs compression noise.
 * @returns {[number, number, number] | null}
 * @param {ImageData} img
 */
export function detectBackgroundColor(img) {
  const { data, width, height } = img;
  /**
   * @type {number[]} byte offsets of sampled pixels
   */
  const samples = [];
  let total = 0;
  /**
   * @param {number} x
   * @param {number} y
   */
  const take = (x, y) => {
    total += 1;
    const i = (y * width + x) * 4;
    if (data[i + 3] >= ALPHA_THRESHOLD) samples.push(i);
  };
  const stride = Math.max(1, Math.floor((2 * (width + height)) / 2048));
  for (let x = 0; x < width; x += stride) {
    take(x, 0);
    take(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += stride) {
    take(0, y);
    take(width - 1, y);
  }
  const k = Math.min(4, width, height);
  for (const [cx, cy] of [
    [0, 0],
    [width - k, 0],
    [0, height - k],
    [width - k, height - k],
  ]) {
    for (let y = cy; y < cy + k; y++) {
      for (let x = cx; x < cx + k; x++) take(x, y);
    }
  }
  // Mostly transparent border: any opaque border pixels are subject, not
  // background.
  if (samples.length < total / 2) return null;

  /**
   * @param {number} i
   */
  const bin = (i) => ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
  const bins = new Map();
  let bestKey = -1;
  let bestCount = 0;
  for (const i of samples) {
    const key = bin(i);
    const n = (bins.get(key) || 0) + 1;
    bins.set(key, n);
    if (n > bestCount) {
      bestCount = n;
      bestKey = key;
    }
  }
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const i of samples) {
    if (bin(i) !== bestKey) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n += 1;
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/**
 * Fuzz-scale distance between two Oklab colors (see makeFuzzMatch).
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 */
function fuzzDistance(a, b) {
  const dL = a[0] - b[0];
  const dA = (a[1] - b[1]) * 2;
  const dB = (a[2] - b[2]) * 2;
  return Math.sqrt(dL * dL + dA * dA + dB * dB) * 255;
}

/**
 * Perceptual fuzz matcher: chroma-weighted Oklab distance to `target`,
 * scaled so 0-255 fuzz values stay comparable to the old per-channel
 * scale. Doubling the a/b (chroma) axes keeps hue shifts (subject edges)
 * protected while letting pure lightness noise (shadows, JPEG artifacts)
 * count as background. Allocation-free per call: runs per pixel, and
 * remembers the last color, since flat art repeats it along whole runs.
 * @param {number[]} target
 * @param {number} fuzz
 */
function makeFuzzMatch(target, fuzz) {
  const [L1, A1, B1] = srgbToOklab(target);
  const lut = linearLut();
  let lastKey = -1;
  let lastResult = false;
  /**
   * @param {number} r
   * @param {number} g
   * @param {number} b
   */
  return (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    if (key === lastKey) return lastResult;
    lastKey = key;
    const lr = lut[r];
    const lg = lut[g];
    const lb = lut[b];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    const dL = L1 - (0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s);
    const dA = (A1 - (1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s)) * 2;
    const dB = (B1 - (0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s)) * 2;
    lastResult = Math.sqrt(dL * dL + dA * dA + dB * dB) * 255 <= fuzz;
    return lastResult;
  };
}

/**
 * Set alpha to 0 wherever the image matches color within fuzz
 * (perceptual distance, see makeFuzzMatch). Mutates img in place.
 * @param {ImageData} img
 * @param {number[]} color
 * @param {number} fuzz
 */
export function knockOutColor(img, color, fuzz) {
  const { data } = img;
  const matches = makeFuzzMatch(color, fuzz);
  for (let i = 0; i < data.length; i += 4) {
    if (matches(data[i], data[i + 1], data[i + 2])) data[i + 3] = 0;
  }
  return img;
}

/**
 * Enclosed-area limit in trace pixels: `size` source pixels across,
 * squared at the trace `scale`. The "enclosed" option removes regions
 * between a user-set minimum and maximum, because no fixed limit
 * separates letter counters (small) from same-color subject areas such
 * as a blank screen (large).
 * @param {number} size
 * @param {number} scale
 */
export function enclosedAreaLimit(size, scale) {
  return Math.max(1, Math.round((size * scale) ** 2));
}

/**
 * Gradient flood limits, as multiples of fuzz. A real backdrop gradient
 * changes by a fraction of a unit per pixel; what the step limit must
 * reject is the jump across a subject edge. The drift cap bounds how far
 * a chain of small steps can wander from the seed, so a soft,
 * low-contrast edge cannot carry the fill through the whole subject.
 */
const GRADIENT_STEP_SCALE = 0.5;
const GRADIENT_DRIFT_SCALE = 4;

/**
 * Flood-fill knockout: zero the alpha of every pixel CONNECTED to the
 * image border whose color matches `color` within fuzz (perceptual
 * distance). Pixels of the same color inside the subject stay opaque
 * because they are not connected to the edge, unless `enclosedMinArea` is
 * positive: then enclosed matching regions of at least that many pixels,
 * and at most `enclosedMaxArea` (letter counters, gaps between shapes),
 * are removed too. With
 * `gradient`, the fill spreads by small steps between neighbors instead
 * of matching the seed directly, so vignettes and lit backdrops go too
 * (see GRADIENT_STEP_SCALE); enclosed regions still match the seed.
 * Mutates img in place.
 * @param {ImageData} img
 * @param {number[]} color
 * @param {number} fuzz
 * @param {number} enclosedMinArea
 * @param {{ gradient?: boolean, enclosedMaxArea?: number }} [options]
 */
export function knockOutConnected(
  img,
  color,
  fuzz,
  enclosedMinArea = 0,
  { gradient = false, enclosedMaxArea = Infinity } = {},
) {
  const { data, width, height } = img;
  const fuzzMatch = makeFuzzMatch(color, fuzz);
  /**
   * @param {number} i
   */
  const matches = (i) =>
    data[i + 3] >= ALPHA_THRESHOLD && fuzzMatch(data[i], data[i + 1], data[i + 2]);

  // Gradient mode: a neighbor joins when it is within the step limit of
  // the pixel it was reached from and within the drift cap of the seed.
  const lut = linearLut();
  const seedLab = srgbToOklab(color);
  const fromLab = new Float64Array(3);
  const toLab = new Float64Array(3);
  const stepLimit = fuzz * GRADIENT_STEP_SCALE;
  const driftLimit = fuzz * GRADIENT_DRIFT_SCALE;
  /**
   * @param {ArrayLike<number>} from Oklab color of the pixel the fill came from
   * @param {number} i
   */
  const steps = (from, i) => {
    if (data[i + 3] < ALPHA_THRESHOLD) return false;
    oklabInto(lut, data[i], data[i + 1], data[i + 2], toLab);
    return fuzzDistance(fromLab, toLab) <= stepLimit && fuzzDistance(seedLab, toLab) <= driftLimit;
  };

  const stack = new Uint32Array(width * height);
  let stackSize = 0;
  /**
   * @param {number} p
   */
  const take = (p) => {
    data[p * 4 + 3] = 0;
    stack[stackSize++] = p;
  };
  /**
   * @param {number} x
   * @param {number} y
   */
  const seedPush = (x, y) => {
    const p = y * width + x;
    if (matches(p * 4)) take(p);
  };
  for (let x = 0; x < width; x++) {
    seedPush(x, 0);
    seedPush(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    seedPush(0, y);
    seedPush(width - 1, y);
  }
  while (stackSize) {
    const p = stack[--stackSize];
    const x = p % width;
    const y = (p / width) | 0;
    if (gradient) {
      // Alpha is already 0 on taken pixels; their color is intact.
      const i = p * 4;
      oklabInto(lut, data[i], data[i + 1], data[i + 2], fromLab);
      for (const q of [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ]) {
        if (q >= 0 && steps(fromLab, q * 4)) take(q);
      }
    } else {
      if (x > 0) seedPush(x - 1, y);
      if (x < width - 1) seedPush(x + 1, y);
      if (y > 0) seedPush(x, y - 1);
      if (y < height - 1) seedPush(x, y + 1);
    }
  }
  if (enclosedMinArea <= 0) return img;

  // Everything still matching is enclosed. Label each region; the BFS
  // queue doubles as the member list, so a region's pixels sit in
  // stack[0..size) when its search ends.
  const seen = new Uint8Array(width * height);
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || !matches(start * 4)) continue;
    seen[start] = 1;
    stack[0] = start;
    let size = 1;
    for (let head = 0; head < size; head++) {
      const p = stack[head];
      const x = p % width;
      const y = (p / width) | 0;
      for (const q of [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ]) {
        if (q >= 0 && !seen[q] && matches(q * 4)) {
          seen[q] = 1;
          stack[size++] = q;
        }
      }
    }
    if (size >= enclosedMinArea && size <= enclosedMaxArea) {
      for (let k = 0; k < size; k++) data[stack[k] * 4 + 3] = 0;
    }
  }
  return img;
}

/**
 * Edge knockout seeded by the detected border color (see
 * detectBackgroundColor and knockOutConnected). Returns the seed color,
 * or null when the border is already transparent. Mutates img in place.
 * @param {ImageData} img
 * @param {number} fuzz
 * @param {number} enclosedMinArea
 * @param {{ gradient?: boolean, enclosedMaxArea?: number }} [options]
 */
export function knockOutEdges(
  img,
  fuzz,
  enclosedMinArea = 0,
  { gradient = false, enclosedMaxArea = Infinity } = {},
) {
  const seed = detectBackgroundColor(img);
  if (!seed) return null;
  knockOutConnected(img, seed, fuzz, enclosedMinArea, { gradient, enclosedMaxArea });
  return seed;
}

/**
 * Nearest opaque color in the image to target (max per-channel distance),
 * or null when nothing is within maxDistance. Intended for quantized
 * images, where snapping the knockout color to the palette removes the
 * whole cluster instead of only pixels inside the fuzz radius.
 * @param {ImageData} img
 * @param {number[]} rgb
 * @param {number} maxDistance
 */
export function snapToImageColor(img, [r, g, b], maxDistance) {
  const { data } = img;
  const seen = new Set();
  /** @type {[number, number, number] | null} */
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (seen.has(key)) continue;
    seen.add(key);
    const d = Math.max(Math.abs(data[i] - r), Math.abs(data[i + 1] - g), Math.abs(data[i + 2] - b));
    if (d < bestDist) {
      bestDist = d;
      best = [data[i], data[i + 1], data[i + 2]];
    }
  }
  return bestDist <= maxDistance ? best : null;
}

/**
 * Apply the selected background-removal mode. `transparent` is "edges",
 * "auto", an [r, g, b] color, or null/"" for none. For quantized images
 * the target snaps to the nearest palette color so the whole flat
 * cluster goes; fuzz still applies around the snapped color, because an
 * anti-aliased boundary quantizes into several near-background shades
 * that would otherwise survive as a halo outline around the subject.
 * `contiguous` limits a picked color to regions connected to the border,
 * like edges mode; a positive `enclosedMinArea` then also removes
 * enclosed regions of at least that many pixels and at most
 * `enclosedMaxArea` (edges and contiguous only), and `gradient` lets those modes follow a gradient backdrop (see
 * knockOutConnected). Returns the removed color, or null when nothing
 * was removed.
 * @param {ImageData} img
 * @param {string | number[]} transparent "auto", "edges" or an [r, g, b] color
 * @param {number} fuzz
 * @param {boolean} quantized
 * @param {{ contiguous?: boolean, enclosedMinArea?: number, enclosedMaxArea?: number, gradient?: boolean }} [options]
 */
export function removeBackground(
  img,
  transparent,
  fuzz,
  quantized,
  { contiguous = false, enclosedMinArea = 0, enclosedMaxArea = Infinity, gradient = false } = {},
) {
  if (transparent === "edges") {
    return knockOutEdges(img, fuzz, enclosedMinArea, { gradient, enclosedMaxArea });
  }
  /** @type {[number, number, number] | null} */
  let target = null;
  if (transparent === "auto") target = detectBackgroundColor(img);
  else if (Array.isArray(transparent))
    target = /** @type {[number, number, number]} */ (transparent);
  if (!target) return null;
  let color = target;
  if (quantized) {
    const snapped = snapToImageColor(img, target, Math.max(fuzz, 48));
    if (snapped) color = snapped;
  }
  if (contiguous && Array.isArray(transparent)) {
    knockOutConnected(img, color, fuzz, enclosedMinArea, { gradient, enclosedMaxArea });
  } else {
    knockOutColor(img, color, fuzz);
  }
  return color;
}

/**
 * After a knockout made before quantizing: clear opaque pixels along the
 * cutout that looked more like the background than like the palette
 * color they were quantized to. Those are anti-aliased blends that the
 * knockout's fuzz missed; without a background palette slot to absorb
 * them they would trace as an outline. `original` holds the colors from
 * before quantizing. Grows at most `rings` pixels in from the cutout, and
 * only through reclaimed pixels, so the subject cannot be eaten.
 * Mutates img in place.
 * @param {ImageData} img
 * @param {Uint8ClampedArray} original
 * @param {number[]} seed
 * @param {number} rings
 */
export function reclaimFringe(img, original, seed, rings) {
  const { data, width, height } = img;
  const lut = linearLut();
  const seedLab = srgbToOklab(seed);
  const was = new Float64Array(3);
  const now = new Float64Array(3);
  for (let ring = 0; ring < rings; ring++) {
    const clear = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const i = p * 4;
        if (data[i + 3] < ALPHA_THRESHOLD) continue;
        if (
          !(
            (x > 0 && data[i - 4 + 3] < ALPHA_THRESHOLD) ||
            (x < width - 1 && data[i + 4 + 3] < ALPHA_THRESHOLD) ||
            (y > 0 && data[i - width * 4 + 3] < ALPHA_THRESHOLD) ||
            (y < height - 1 && data[i + width * 4 + 3] < ALPHA_THRESHOLD)
          )
        ) {
          continue;
        }
        oklabInto(lut, original[i], original[i + 1], original[i + 2], was);
        oklabInto(lut, data[i], data[i + 1], data[i + 2], now);
        if (fuzzDistance(was, seedLab) < fuzzDistance(was, now)) clear.push(i);
      }
    }
    if (clear.length === 0) break;
    for (const i of clear) data[i + 3] = 0;
  }
  return img;
}

/** How far reclaimFringe may reach into the subject, in pixels. */
export const FRINGE_RINGS = 2;

/**
 * Color reduction (when `colors` < 256) plus background removal, in the
 * order each mode needs. Border-connected modes (edges, contiguous pick)
 * build the mask BEFORE quantizing: a light subject edge that shares the
 * background's palette slot would otherwise let the flood leak into the
 * subject; reclaimFringe then clears the blend fringe the earlier mask
 * leaves. Global color modes quantize first so off-white highlights that
 * collapse into the background's palette slot go with it ("N colors
 * where one is transparent"). `background` holds transparent, fuzz,
 * contiguous and gradient as removeBackground takes them, plus enclosed,
 * enclosedSize and enclosedMaxSize (source pixels across;
 * ENCLOSED_NO_LIMIT for no maximum) and scale (trace pixels per source
 * pixel) for the enclosed-area limits. `flatArt` (the source was
 * detected as flat art) repairs soft edges even when the palette was
 * clustered rather than seeded.
 * Returns the removed color, or null. Mutates img in place.
 * @param {(label: string) => void} [stage] progress reporter
 * @param {ImageData} img
 * @param {number} colors
 * @param {Record<string, any>} background
 */
export function reduceAndRemoveBackground(img, colors, background, stage = () => {}) {
  const {
    transparent,
    fuzz,
    contiguous = false,
    enclosed = false,
    enclosedSize = DEFAULTS.enclosedSize,
    enclosedMaxSize = DEFAULTS.enclosedMaxSize,
    gradient = false,
    scale = 1,
    swatches = null,
    layerDiff = 0,
    seeds = null,
    keep = null,
    flatArt = false,
  } = background;
  const options = {
    contiguous,
    enclosedMinArea: enclosed ? enclosedAreaLimit(enclosedSize, scale) : 0,
    enclosedMaxArea:
      enclosedMaxSize >= ENCLOSED_NO_LIMIT ? Infinity : enclosedAreaLimit(enclosedMaxSize, scale),
    gradient,
  };
  const custom = Array.isArray(swatches) && swatches.length > 0;
  const quantized = custom || colors < 256;
  const reduce = () => {
    const before = new Uint8ClampedArray(img.data);
    // Soft edges only snap to a wrong third color when the palette is a
    // few flat colors; photo palettes would pay seconds for nothing.
    let flat = custom;
    if (custom) {
      stage("Matching your colors…");
      mapToPalette(img, swatches);
    } else {
      stage(`Reducing to ${colors} colors…`);
      const result = quantize(img, colors, { layerDiff, seeds, keep });
      // Nothing remapped means no dither to clean: lone pixels are detail.
      if (!result) return;
      // Compressed flat art clusters without seeds (Colors set by hand),
      // but its edges blur all the same.
      flat = result === "flat" || flatArt;
    }
    // Only upscaled art has soft edges to repair: at its own size or
    // scaled down, edges are a pixel or two wide, which nearest-color
    // snapping already splits, and repairing them only steps diagonals.
    if (flat && scale > 1) unblendEdges(img, before, tracePixels(BLEND_REACH, scale));
    modeFilter(img);
  };
  const connected = transparent === "edges" || (Array.isArray(transparent) && contiguous);
  if (quantized && connected) {
    stage("Removing background…");
    const seed = removeBackground(img, transparent, fuzz, false, options);
    const original = seed ? new Uint8ClampedArray(img.data) : null;
    reduce();
    if (seed && original) reclaimFringe(img, original, seed, FRINGE_RINGS);
    return seed;
  }
  if (quantized) reduce();
  if (!transparent) return null;
  stage("Removing background…");
  return removeBackground(img, transparent, fuzz, quantized, options);
}
