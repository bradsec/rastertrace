// Pure pixel and string operations for the RasterTrace pipeline.
// Every function here runs in Node (tests) and the browser (worker/app):
// images are plain { data: Uint8ClampedArray, width, height } RGBA buffers.

export const ALPHA_THRESHOLD = 128;

// Upper bound on upscaled pixels sent to the tracer. Beyond this the
// RGBA buffers alone run to hundreds of MB and canvas/wasm allocation
// fails with opaque platform errors, so fail early with a clear one.
export const MAX_TRACE_PIXELS = 64_000_000;

// Longest side sent to the tracer, on every device. Upscale never pushes
// past it and larger sources are reduced to it, proportions kept: tracing
// gains no detail beyond this, and a 12 MP camera photo at 2x (49 MP,
// ~200 MB per RGBA copy) crashed iOS Safari, which kills a tab around
// 1-1.5 GB. 2048x2048 tops out at 4.2 MP.
export const MAX_TRACE_SIDE = 2048;

/**
 * Effective scale factor for tracing: the requested upscale, capped so
 * the longest side never exceeds maxSide. Below 1 the image is
 * downscaled before tracing.
 */
export function fitTraceScale(width, height, upscale, maxSide = MAX_TRACE_SIDE) {
  return Math.min(upscale, maxSide / Math.max(width, height));
}

/**
 * Throw a readable error when width x height at the given upscale factor
 * exceeds MAX_TRACE_PIXELS. Returns the upscaled pixel count otherwise.
 */
export function assertRasterBudget(width, height, upscale) {
  const pixels = width * upscale * height * upscale;
  if (pixels > MAX_TRACE_PIXELS) {
    const mp = (n) => `${Math.round(n / 1e6)} MP`;
    throw new Error(
      `Image is too large to trace at ${upscale}x (${mp(pixels)}; limit ${mp(MAX_TRACE_PIXELS)}). Lower the upscale factor or use a smaller image.`,
    );
  }
  return pixels;
}

export const DEFAULTS = Object.freeze({
  colors: 256,
  speckle: 8,
  layerDiff: 16,
  upscale: 2,
  mode: "spline",
  cornerThreshold: 60,
  hierarchical: "stacked",
  grayscale: false,
  denoise: false,
  crisp: false,
  transparent: "",
  fuzz: 16,
  edgeTrim: 0,
  defringe: 0,
});

// Keyed by color count. Speckle and layer difference scale inversely:
// fewer colors means flat print-style output, so cleanup gets more
// aggressive; more colors means detail retention matters.
export const PRESETS = Object.freeze({
  2: { colors: 2, speckle: 16, layerDiff: 48 },
  3: { colors: 3, speckle: 16, layerDiff: 32 },
  4: { colors: 4, speckle: 12, layerDiff: 28 },
  6: { colors: 6, speckle: 10, layerDiff: 26 },
  8: { colors: 8, speckle: 8, layerDiff: 24 },
  16: { colors: 16, speckle: 8, layerDiff: 16 },
  32: { colors: 32, speckle: 4, layerDiff: 16 },
  64: { colors: 64, speckle: 4, layerDiff: 12 },
  128: { colors: 128, speckle: 2, layerDiff: 8 },
  256: { colors: 256, speckle: 8, layerDiff: 16 },
});

/** Parse "#RRGGBB" or "RRGGBB" into [r, g, b], or null. */
export function parseHexColor(value) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(value).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Format [r, g, b] as "#RRGGBB". */
export function toHexColor([r, g, b]) {
  return (
    "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0").toUpperCase()).join("")
  );
}

/**
 * sRGB [0-255] channels to Oklab [L, a, b]. Oklab is perceptually
 * uniform: Euclidean distances here track how different two colors look,
 * unlike raw sRGB where dark and saturated regions are over-weighted.
 */
let SRGB_LINEAR;
function linearLut() {
  if (!SRGB_LINEAR) {
    SRGB_LINEAR = new Float64Array(256);
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      SRGB_LINEAR[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }
  }
  return SRGB_LINEAR;
}

export function srgbToOklab([r, g, b]) {
  const lut = linearLut();
  const lr = lut[r];
  const lg = lut[g];
  const lb = lut[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Oklab [L, a, b] back to sRGB [0-255], clamped and rounded. */
export function oklabToSrgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const gam = (v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  };
  return [gam(lr), gam(lg), gam(lb)];
}

/**
 * Dominant border color, or null when the border is mostly transparent.
 * Samples the border ring plus 4x4 corner patches and bins samples
 * coarsely (16 levels per channel), returning the average color of the
 * dominant bin: single corner pixels are one JPEG artifact or watermark
 * away from the wrong answer, and binning absorbs compression noise.
 */
export function detectBackgroundColor(img) {
  const { data, width, height } = img;
  const samples = [];
  let total = 0;
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
  for (const [cx, cy] of [[0, 0], [width - k, 0], [0, height - k], [width - k, height - k]]) {
    for (let y = cy; y < cy + k; y++) {
      for (let x = cx; x < cx + k; x++) take(x, y);
    }
  }
  // Mostly transparent border: any opaque border pixels are subject, not
  // background.
  if (samples.length < total / 2) return null;

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
 * Perceptual fuzz matcher: chroma-weighted Oklab distance to `target`,
 * scaled so 0-255 fuzz values stay comparable to the old per-channel
 * scale. Doubling the a/b (chroma) axes keeps hue shifts (subject edges)
 * protected while letting pure lightness noise (shadows, JPEG artifacts)
 * count as background. Allocation-free per call: runs per pixel.
 */
function makeFuzzMatch(target, fuzz) {
  const [L1, A1, B1] = srgbToOklab(target);
  const lut = linearLut();
  return (r, g, b) => {
    const lr = lut[r];
    const lg = lut[g];
    const lb = lut[b];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    const dL = L1 - (0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s);
    const dA = (A1 - (1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s)) * 2;
    const dB = (B1 - (0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s)) * 2;
    return Math.sqrt(dL * dL + dA * dA + dB * dB) * 255 <= fuzz;
  };
}

/**
 * Set alpha to 0 wherever the image matches color within fuzz
 * (perceptual distance, see makeFuzzMatch). Mutates img in place.
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
 * Flood-fill background removal: zero the alpha of every pixel CONNECTED
 * to the image border whose color matches the border seed within fuzz
 * (perceptual distance). Pixels of the same color inside the
 * subject stay opaque because they are not connected to the edge.
 * Seed color comes from the most common opaque corner; every border
 * pixel matching it seeds the fill. Returns the seed color, or null when
 * the corners are already transparent. Mutates img in place.
 */
export function knockOutEdges(img, fuzz) {
  const { data, width, height } = img;
  const seed = detectBackgroundColor(img);
  if (!seed) return null;
  const fuzzMatch = makeFuzzMatch(seed, fuzz);
  const matches = (i) =>
    data[i + 3] >= ALPHA_THRESHOLD && fuzzMatch(data[i], data[i + 1], data[i + 2]);

  const visited = new Uint8Array(width * height);
  const stack = [];
  const push = (x, y) => {
    const p = y * width + x;
    if (!visited[p] && matches(p * 4)) {
      visited[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  while (stack.length) {
    const p = stack.pop();
    data[p * 4 + 3] = 0;
    const x = p % width;
    const y = (p / width) | 0;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  return seed;
}

/**
 * Nearest opaque color in the image to target (max per-channel distance),
 * or null when nothing is within maxDistance. Intended for quantized
 * images, where snapping the knockout color to the palette removes the
 * whole cluster instead of only pixels inside the fuzz radius.
 */
export function snapToImageColor(img, [r, g, b], maxDistance) {
  const { data } = img;
  const seen = new Set();
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (seen.has(key)) continue;
    seen.add(key);
    const d = Math.max(
      Math.abs(data[i] - r),
      Math.abs(data[i + 1] - g),
      Math.abs(data[i + 2] - b),
    );
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
 * Returns the removed color, or null when nothing was removed.
 */
export function removeBackground(img, transparent, fuzz, quantized) {
  if (transparent === "edges") return knockOutEdges(img, fuzz);
  let target = null;
  if (transparent === "auto") target = detectBackgroundColor(img);
  else if (Array.isArray(transparent)) target = transparent;
  if (!target) return null;
  let color = target;
  if (quantized) {
    const snapped = snapToImageColor(img, target, Math.max(fuzz, 48));
    if (snapped) color = snapped;
  }
  knockOutColor(img, color, fuzz);
  return color;
}

/**
 * Matte choke: peel `passes` one-pixel rings off the opaque region,
 * clearing the alpha of opaque pixels 4-adjacent to transparency. Eats
 * the background-blend fringe left along subject boundaries after a
 * knockout, whatever color the fringe is; thin features shrink by the
 * same amount, so the amount is user-controlled. Mutates img in place.
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
 * Matte defringe: recolor the outermost `depth` rings of the opaque
 * region from the colors one ring deeper, hiding background-blend fringe
 * without shrinking the shape. Complements erodeAlpha: trim deletes
 * boundary pixels (thin features shrink), defringe repaints them. Rings
 * are processed from the innermost fringe ring outward so interior colors
 * propagate to the edge; pixels with no deeper neighbor (features thinner
 * than 2*depth) keep their original color. Mutates img in place.
 */
export function defringeAlpha(img, depth) {
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
  const rings = [];
  for (let d = 1; d <= depth && queue.length; d++) {
    const next = [];
    for (const p of queue) {
      const x = p % width;
      const y = (p / width) | 0;
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
        }
      }
      if (count > 0) {
        const j = p * 4;
        data[j] = r / count;
        data[j + 1] = g / count;
        data[j + 2] = b / count;
      }
    }
  }
  return img;
}

/**
 * Threshold alpha to 0 or 255 so anti-aliased edge fringe cannot fragment
 * the trace into junk paths. Mutates img in place.
 */
export function binarizeAlpha(img) {
  const { data } = img;
  for (let i = 3; i < data.length; i += 4) {
    data[i] = data[i] >= ALPHA_THRESHOLD ? 255 : 0;
  }
  return img;
}

/** Luminance (Rec. 601) grayscale conversion, alpha preserved. In place. */
export function toGrayscale(img) {
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) {
    const l = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = l;
  }
  return img;
}

/** Most common opaque color, sampled with a stride for speed. */
export function dominantOpaqueColor(img) {
  const { data } = img;
  const pixelCount = data.length / 4;
  const stride = Math.max(1, Math.floor(pixelCount / 4096)) * 4;
  const counts = new Map();
  let best = null;
  let bestCount = 0;
  for (let i = 0; i < data.length; i += stride) {
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > bestCount) {
      bestCount = n;
      best = key;
    }
  }
  if (best === null) return [255, 255, 255];
  return [(best >> 16) & 0xff, (best >> 8) & 0xff, best & 0xff];
}

/**
 * Coverage-based flatness heuristic. Flat-color sources (logos, text,
 * screenshots, pixel art) concentrate almost all pixels in a handful of
 * colors even when anti-aliasing adds thousands of rare fringe colors, so
 * coverage is tested before unique counts: flat when the 16 most common
 * sampled colors cover >= 90% of opaque samples. Exact sampled images below
 * 256 colors are also flat, and noisy flat art can still pass when its
 * colors collapse into a few dominant RGB clusters. Clustered art starts with
 * a less aggressive color budget so distressed details survive.
 * Transparent pixels are ignored; a fully
 * transparent image is not flat.
 */
export function analyzeFlatness(img) {
  const { data } = img;
  const pixelCount = data.length / 4;
  // Odd pixel stride so sampling does not lock to even image widths and
  // hit the same columns every row.
  let stride = Math.max(1, Math.ceil(pixelCount / 200_000));
  if (stride % 2 === 0) stride += 1;
  const counts = new Map();
  let total = 0;
  for (let p = 0; p < pixelCount; p += stride) {
    const i = p * 4;
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
    total += 1;
  }
  if (total === 0) return { flat: false, colorCount: 256 };
  const sorted = [...counts.values()].sort((a, b) => b - a);
  let covered = 0;
  let topCoverage = 0;
  let colorCount = sorted.length;
  let counted = false;
  for (let i = 0; i < sorted.length; i++) {
    covered += sorted[i];
    if (i < 16) topCoverage = covered / total;
    if (!counted && covered / total >= 0.95) {
      colorCount = i + 1;
      counted = true;
    }
    if (counted && i >= 16) break;
  }
  if (counts.size <= 32 && topCoverage < 0.9) {
    return { flat: true, colorCount: Math.max(2, counts.size) };
  }
  if (topCoverage < 0.9) {
    const clusters = new Map();
    for (const [key, count] of counts) {
      const r = (key >> 16) & 0xff;
      const g = (key >> 8) & 0xff;
      const b = key & 0xff;
      const clusterKey = (r >> 6) << 4 | (g >> 6) << 2 | (b >> 6);
      clusters.set(clusterKey, (clusters.get(clusterKey) || 0) + count);
    }
    const clusterCounts = [...clusters.values()].sort((a, b) => b - a);
    let clusterCovered = 0;
    let clusterColorCount = clusterCounts.length;
    for (let i = 0; i < Math.min(8, clusterCounts.length); i++) {
      clusterCovered += clusterCounts[i];
      if (clusterCovered / total >= 0.95) {
        clusterColorCount = i + 1;
        break;
      }
    }
    if (clusterCovered / total >= 0.9 && clusterCounts[0] / total >= 0.35) {
      return { flat: true, colorCount: Math.min(32, Math.max(8, clusterColorCount * 2)) };
    }
  }
  return {
    flat: topCoverage >= 0.9,
    colorCount: Math.min(32, Math.max(2, colorCount)),
  };
}

/**
 * Median-cut color quantization to at most `colors` colors. Transparent
 * areas are backfilled with the dominant opaque color before the palette
 * is computed so hidden pixels do not pollute it; alpha is untouched.
 * Mutates img in place.
 */
export function quantize(img, colors) {
  const { data } = img;
  const backfill = dominantOpaqueColor(img);

  // Histogram of unique colors (transparent pixels count as backfill).
  const hist = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const key =
      data[i + 3] < ALPHA_THRESHOLD
        ? (backfill[0] << 16) | (backfill[1] << 8) | backfill[2]
        : (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  if (hist.size <= colors) return img;

  // Clustering runs in Oklab so splits and distances are perceptual:
  // low color counts keep visually distinct hues apart instead of
  // merging them by raw RGB proximity.
  const entries = [...hist.entries()].map(([key, count]) => {
    const rgb = [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff];
    const [L, A, B] = srgbToOklab(rgb);
    return { key, L, A, B, count };
  });

  // Median cut: repeatedly split the box with the largest channel range.
  const boxes = [entries];
  while (boxes.length < colors) {
    let boxIndex = -1;
    let boxRange = -1;
    let boxChannel = "L";
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      for (const ch of ["L", "A", "B"]) {
        let min = 255;
        let max = 0;
        for (const e of boxes[i]) {
          if (e[ch] < min) min = e[ch];
          if (e[ch] > max) max = e[ch];
        }
        const range = max - min;
        if (range > boxRange) {
          boxRange = range;
          boxIndex = i;
          boxChannel = ch;
        }
      }
    }
    if (boxIndex === -1) break;
    const box = boxes[boxIndex];
    box.sort((a, b) => a[boxChannel] - b[boxChannel]);
    // Split at the pixel-weighted median so dominant colors get their own
    // box instead of being averaged away with rare neighbors.
    const totalCount = box.reduce((sum, e) => sum + e.count, 0);
    let acc = 0;
    let half = 0;
    while (half < box.length - 1 && acc + box[half].count < totalCount / 2) {
      acc += box[half].count;
      half += 1;
    }
    if (half === 0) half = 1;
    boxes.splice(boxIndex, 1, box.slice(0, half), box.slice(half));
  }

  // Weighted average color per box seeds the palette.
  let palette = boxes.map((box) => {
    let L = 0;
    let A = 0;
    let B = 0;
    let total = 0;
    for (const e of box) {
      L += e.L * e.count;
      A += e.A * e.count;
      B += e.B * e.count;
      total += e.count;
    }
    return [L / total, A / total, B / total];
  });

  // Lloyd (k-means) refinement over the histogram. Median-cut alone leaves
  // centroids off the natural clusters, so gradient pixels flip between
  // adjacent palette entries and trace into thousands of ragged paths.
  const assign = new Int32Array(entries.length);
  for (let iter = 0; iter < 10; iter++) {
    let changed = false;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      let best = 0;
      let bestDist = Infinity;
      for (let k = 0; k < palette.length; k++) {
        const dL = e.L - palette[k][0];
        const dA = e.A - palette[k][1];
        const dB = e.B - palette[k][2];
        const dist = dL * dL + dA * dA + dB * dB;
        if (dist < bestDist) {
          bestDist = dist;
          best = k;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    }
    if (!changed && iter > 0) break;
    const sums = palette.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const s = sums[assign[i]];
      s[0] += e.L * e.count;
      s[1] += e.A * e.count;
      s[2] += e.B * e.count;
      s[3] += e.count;
    }
    palette = sums.map((s, k) => (s[3] > 0 ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : palette[k]));
  }

  // Every unique color maps to its (now converged) nearest palette entry.
  const rounded = palette.map(oklabToSrgb);
  const colorToPalette = new Map();
  for (let i = 0; i < entries.length; i++) {
    colorToPalette.set(entries[i].key, rounded[assign[i]]);
  }

  for (let i = 0; i < data.length; i += 4) {
    const key =
      data[i + 3] < ALPHA_THRESHOLD
        ? (backfill[0] << 16) | (backfill[1] << 8) | backfill[2]
        : (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    const [r, g, b] = colorToPalette.get(key);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
  return img;
}

/**
 * 3x3 per-channel median filter on opaque RGB, repeated `passes` times.
 * Kills sensor/compression noise while preserving edges exactly, unlike
 * a blur which grays the very boundaries the tracer follows. Alpha is
 * untouched and transparent neighbors are excluded from the window.
 */
export function medianFilter(img, passes = 1) {
  const { data, width, height } = img;
  const out = new Uint8ClampedArray(data.length);
  const win = [[], [], []];

  for (let pass = 0; pass < passes; pass++) {
    out.set(data);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i + 3] < ALPHA_THRESHOLD) continue;
        win[0].length = win[1].length = win[2].length = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const j = (ny * width + nx) * 4;
            if (data[j + 3] < ALPHA_THRESHOLD) continue;
            win[0].push(data[j]);
            win[1].push(data[j + 1]);
            win[2].push(data[j + 2]);
          }
        }
        for (let c = 0; c < 3; c++) {
          win[c].sort((a, b) => a - b);
          out[i + c] = win[c][win[c].length >> 1];
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
 */
export function modeFilter(img) {
  const { data, width, height } = img;
  const out = new Uint8ClampedArray(data);
  const counts = new Map();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < ALPHA_THRESHOLD) continue;
      counts.clear();
      let best = -1;
      let bestCount = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const j = (ny * width + nx) * 4;
          if (data[j + 3] < ALPHA_THRESHOLD) continue;
          const key = (data[j] << 16) | (data[j + 1] << 8) | data[j + 2];
          const n = (counts.get(key) || 0) + 1;
          counts.set(key, n);
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

/**
 * Wrap runs of adjacent same-fill <path> elements in a shared
 * <g fill="..."> and drop the per-path fill attributes. Only paths
 * separated by whitespace count as adjacent, and only adjacent runs
 * merge: stacked output relies on document order for z-order, so
 * non-adjacent same-fill paths must stay where they are.
 */
export function groupSvgFills(svgText) {
  const fillOf = (path) => (path.match(/\sfill="([^"]*)"/) || [])[1] || null;
  const matches = [...svgText.matchAll(/<path\b[^>]*\/>/g)];
  let out = "";
  let cursor = 0;
  let i = 0;
  while (i < matches.length) {
    const fill = fillOf(matches[i][0]);
    let j = i;
    while (
      fill &&
      j + 1 < matches.length &&
      fillOf(matches[j + 1][0]) === fill &&
      /^\s*$/.test(svgText.slice(matches[j].index + matches[j][0].length, matches[j + 1].index))
    ) {
      j++;
    }
    if (j > i) {
      out += svgText.slice(cursor, matches[i].index) + `<g fill="${fill}">\n`;
      for (let k = i; k <= j; k++) {
        out += matches[k][0].replace(/\s+fill="[^"]*"/, "");
        out += k < j ? svgText.slice(matches[k].index + matches[k][0].length, matches[k + 1].index) : "\n";
      }
      out += "</g>";
      cursor = matches[j].index + matches[j][0].length;
    }
    i = j + 1;
  }
  return out + svgText.slice(cursor);
}

/**
 * Rewrite the SVG root so the document keeps the source pixel dimensions
 * with a viewBox, hiding the internal upscale factor, and group same-fill
 * paths to shrink the file. Returns the root unchanged when it does not
 * match the expected vtracer shape.
 */
export function finalizeSvg(svgText, width, height) {
  return groupSvgFills(svgText).replace(
    /(<svg[^>]*?) width="(\d+)" height="(\d+)">/,
    (_, head, w, h) => `${head} width="${width}" height="${height}" viewBox="0 0 ${w} ${h}">`,
  );
}

/** Count path elements in an SVG string. */
export function countPaths(svgText) {
  return (svgText.match(/<path\b/g) || []).length;
}

/**
 * Resolve preset + explicit values the same way the CLI does:
 * explicit user values win over preset values, preset over defaults.
 * `explicit` holds only the keys the user actually set.
 */
export function resolveSettings(preset, explicit = {}) {
  const merged = { ...DEFAULTS, ...(preset ? PRESETS[preset] : {}) };
  for (const [key, value] of Object.entries(explicit)) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  return merged;
}
