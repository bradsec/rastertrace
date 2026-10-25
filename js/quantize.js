// Color reduction: flat-art detection and palette quantization.
// Pure functions: they run in Node (tests) and the browser (worker/app).
// Images are plain { data: Uint8ClampedArray, width, height } RGBA buffers.

import { colorDistance, oklabToSrgb, parseHexColor, srgbToOklab } from "./color.js?v=2";
import { ALPHA_THRESHOLD } from "./raster.js?v=1";

/**
 * Most common opaque color, sampled with a stride for speed.
 * @param {ImageData} img
 */
export function dominantOpaqueColor(img) {
  const { data } = img;
  const pixelCount = data.length / 4;
  const stride = Math.max(1, Math.floor(pixelCount / 4096)) * 4;
  const counts = new Map();
  /** @type {number | null} */
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

// Solid color thresholds for analyzeFlatness. The two shares are of all
// opaque samples; the interior share is of the color's own samples.
// Measured on anti-aliased flat art: real colors have 29% or more interior
// pixels (thin lines included), edge blends 6% or fewer.
const SOLID_MIN_SHARE = 0.001;
const SOLID_LINE_SHARE = 0.01;
const SOLID_MIN_INTERIOR = 0.2;
// Exact solid colors must cover this share of samples to be trusted;
// below it (JPEG, resampling, noise) similarFlatness clusters instead.
// Clean flat PNGs measure 0.979 or more, compressed or resampled 0.967 or less.
const EXACT_SOLID_SHARE = 0.975;
// similarFlatness: least neighbor tolerance (sum of RGB differences),
// least share of samples inside areas, Oklab cluster radius, widest mean
// cluster spread (gradients measure 0.0085, compressed flat art 0.0054 or
// less), and the share that makes a color a thin line.
const SIMILAR_MIN_TOLERANCE = 24;
const SIMILAR_MIN_INSIDE = 0.5;
const SIMILAR_CLUSTER_DISTANCE = 0.03;
const SIMILAR_MAX_SPREAD = 0.007;
const SIMILAR_LINE_SHARE = 0.02;

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
 *
 * Flat results also list `solids`, the colors of the artwork as [r, g, b]:
 * every color with at least SOLID_MIN_SHARE of the samples that either
 * fills areas (some samples have all four neighbors the same color) or is
 * common enough to be a thin line. Anti-alias blends sit only on edges,
 * so they rarely have interior pixels. colorCount counts the solids, so
 * small accents past 95% coverage still get a palette slot.
 * @param {ImageData} img
 */
export function analyzeFlatness(img) {
  const { solidShare, ...exact } = exactFlatness(img);
  if (exact.solids && (solidShare ?? 0) >= EXACT_SOLID_SHARE) return exact;
  return similarFlatness(img) ?? exact;
}

// withoutBlendShades: how close (RGB) a color must sit to the segment
// between two fills to count as their mix, and how far along it (share
// of the way from either end) it must be.
const SHADE_TOLERANCE = 24;
const SHADE_END = 0.08;
// A real color fills areas: this share of its pixels have neighbors all
// within the image's noise of their own color. Blur shades change from
// pixel to pixel across an edge, and anti-alias shades are lines a pixel
// or two wide. Measured: blur and anti-alias shades 0.04 or less, while
// textured real colors in large AI art (hair, gun-metal greys) measure
// 0.08 to 0.19 and must keep their own color.
const SHADE_MIN_INTERIOR = 0.05;
// A halftone or textured area (dotted hair, screened shading) fails the
// interior test too, but covers an area of its own: a shade is also only
// dropped when this share of its pixels have both of its ends within
// SHADE_REACH pixels, as a soft edge's band between two fills does.
const SHADE_MIN_BETWEEN = 0.6;
const SHADE_REACH = 12;

/**
 * Detected colors without the shades a soft edge leaves between two
 * fills. Blurred or resampled flat art grows bands of every mix of the
 * two colors along each edge, and the common ones pass for colors. A
 * color that is a mix of two other detected colors is dropped when its
 * pixels rarely fill areas and mostly lie where those two colors meet. `solids` are ordered most common first; the
 * least common are tested first and only kept colors serve as ends.
 * @param {ImageData} img
 * @param {number[][]} solids
 */
function withoutBlendShades(img, solids) {
  if (solids.length < 3) return solids;
  const { data, width } = img;
  const pixelCount = data.length / 4;
  const height = pixelCount / width;
  let stride = Math.max(1, Math.ceil(pixelCount / 200_000));
  if (stride % 2 === 0) stride += 1;
  const row = width * 4;
  /**
   * @param {number} i
   * @param {number} j
   */
  const step = (i, j) =>
    Math.abs(data[i] - data[j]) +
    Math.abs(data[i + 1] - data[j + 1]) +
    Math.abs(data[i + 2] - data[j + 2]);
  // Noise level as similarFlatness measures it, for the interior test.
  const steps = [];
  for (let p = 0; p < pixelCount; p += stride * 7) {
    if (p % width < width - 1 && data[p * 4 + 3] >= ALPHA_THRESHOLD) {
      steps.push(step(p * 4, p * 4 + 4));
    }
  }
  steps.sort((a, b) => a - b);
  const flatStep = Math.max(6, 2 * (steps[steps.length >> 1] ?? 0));
  const tolerance2 = SHADE_TOLERANCE * SHADE_TOLERANCE;
  /**
   * @param {number[]} c
   * @param {number[]} a
   * @param {number[]} b
   */
  const along = (c, a, b) => {
    const dr = b[0] - a[0];
    const dg = b[1] - a[1];
    const db = b[2] - a[2];
    const len2 = dr * dr + dg * dg + db * db;
    if (!len2) return null;
    const t = ((c[0] - a[0]) * dr + (c[1] - a[1]) * dg + (c[2] - a[2]) * db) / len2;
    const residual2 =
      (c[0] - a[0] - t * dr) ** 2 + (c[1] - a[1] - t * dg) ** 2 + (c[2] - a[2] - t * db) ** 2;
    return { t, residual2 };
  };
  /**
   * @param {number} i
   * @param {number[][]} colors
   */
  const nearest = (i, colors) => {
    let best = -1;
    let bestDistance = Infinity;
    for (let k = 0; k < colors.length; k++) {
      const c = colors[k];
      const d = (data[i] - c[0]) ** 2 + (data[i + 1] - c[1]) ** 2 + (data[i + 2] - c[2]) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        best = k;
      }
    }
    return best;
  };
  // Share of the color's pixels whose four neighbors match their own.
  /**
   * @param {number[][]} colors
   * @param {number} k
   */
  const measure = (colors, k) => {
    let count = 0;
    let interior = 0;
    for (let p = 0; p < pixelCount; p += stride) {
      const i = p * 4;
      if (data[i + 3] < ALPHA_THRESHOLD || nearest(i, colors) !== k) continue;
      count += 1;
      const x = p % width;
      const y = (p - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) continue;
      if (
        step(i, i - 4) <= flatStep &&
        step(i, i + 4) <= flatStep &&
        step(i, i - row) <= flatStep &&
        step(i, i + row) <= flatStep
      ) {
        interior += 1;
      }
    }
    return count ? interior / count : 0;
  };
  // Share of the color's pixels with both `a` and `b` within SHADE_REACH:
  // a soft edge's shade lies in the band where they meet.
  /**
   * @param {number[][]} colors
   * @param {number} k
   * @param {number} a
   * @param {number} b
   */
  const between = (colors, k, a, b) => {
    let count = 0;
    let found = 0;
    for (let p = 0; p < pixelCount; p += stride * 3) {
      const i = p * 4;
      if (data[i + 3] < ALPHA_THRESHOLD || nearest(i, colors) !== k) continue;
      count += 1;
      const x0 = p % width;
      const y0 = (p - x0) / width;
      let seenA = false;
      let seenB = false;
      for (
        let y = Math.max(0, y0 - SHADE_REACH);
        y <= Math.min(height - 1, y0 + SHADE_REACH);
        y++
      ) {
        for (
          let x = Math.max(0, x0 - SHADE_REACH);
          x <= Math.min(width - 1, x0 + SHADE_REACH);
          x++
        ) {
          const j = (y * width + x) * 4;
          if (data[j + 3] < ALPHA_THRESHOLD) continue;
          const near = nearest(j, colors);
          if (near === a) seenA = true;
          else if (near === b) seenB = true;
        }
        if (seenA && seenB) break;
      }
      if (seenA && seenB) found += 1;
    }
    return count ? found / count : 0;
  };
  const kept = [...solids];
  for (let k = kept.length - 1; k >= 2; k--) {
    const color = kept[k];
    const ends = kept.filter((_, j) => j !== k);
    let shade = false;
    for (let m = 0; m < ends.length && !shade; m++) {
      for (let j = m + 1; j < ends.length && !shade; j++) {
        const fit = along(color, ends[m], ends[j]);
        if (!fit || fit.residual2 > tolerance2) continue;
        if (fit.t < SHADE_END || fit.t > 1 - SHADE_END) continue;
        shade =
          measure(kept, k) < SHADE_MIN_INTERIOR &&
          between(kept, k, kept.indexOf(ends[m]), kept.indexOf(ends[j])) >= SHADE_MIN_BETWEEN;
        if (/** @type {any} */ (globalThis).SHADE_DEBUG)
          console.log(
            "CAND",
            JSON.stringify(color),
            "interior",
            measure(kept, k).toFixed(2),
            "between",
            between(kept, k, kept.indexOf(ends[m]), kept.indexOf(ends[j])).toFixed(2),
          );
      }
    }
    if (shade) kept.splice(k, 1);
  }
  return kept;
}

/**
 * Solid colors of flat art whose colors are not exact: JPEG compression,
 * resampling or light noise spread each flat color over many near
 * shades. A sample is inside an area when its four neighbors are within
 * a tolerance that follows the image's own noise level (anti-alias
 * blends sit between colors that differ sharply, so they drop out), and
 * those samples are grouped into perceptual (Oklab) clusters. Returns
 * null when the clusters do not describe flat art: too many, too wide
 * (smooth gradients), or too little of the image inside areas (photos).
 * @param {ImageData} img
 */
function similarFlatness(img) {
  const { data, width } = img;
  const pixelCount = data.length / 4;
  const height = pixelCount / width;
  let stride = Math.max(1, Math.ceil(pixelCount / 200_000));
  if (stride % 2 === 0) stride += 1;
  /**
   * @param {number} i
   * @param {number} j
   */
  const distance = (i, j) =>
    Math.abs(data[i] - data[j]) +
    Math.abs(data[i + 1] - data[j + 1]) +
    Math.abs(data[i + 2] - data[j + 2]);
  // Noise level: the median difference to the right-hand neighbor, which
  // flat areas dominate in flat art.
  const steps = [];
  for (let p = 0; p < pixelCount; p += stride * 7) {
    if (p % width < width - 1) steps.push(distance(p * 4, p * 4 + 4));
  }
  steps.sort((a, b) => a - b);
  const tolerance = Math.max(SIMILAR_MIN_TOLERANCE, 3 * (steps[steps.length >> 1] ?? 0));

  // 5-bit bins hold running sums so each cluster gets its mean color.
  /**
   * @param {Map<number, number[]>} bins
   * @param {number} i
   */
  const bin = (bins, i) => {
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    let entry = bins.get(key);
    if (!entry) bins.set(key, (entry = [0, 0, 0, 0]));
    entry[0] += data[i];
    entry[1] += data[i + 1];
    entry[2] += data[i + 2];
    entry[3] += 1;
  };
  const inside = new Map();
  const everywhere = new Map();
  const row = width * 4;
  let opaque = 0;
  let insideCount = 0;
  for (let p = 0; p < pixelCount; p += stride) {
    const i = p * 4;
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    opaque += 1;
    bin(everywhere, i);
    const x = p % width;
    const y = (p - x) / width;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) continue;
    if (
      distance(i, i - 4) > tolerance ||
      distance(i, i + 4) > tolerance ||
      distance(i, i - row) > tolerance ||
      distance(i, i + row) > tolerance
    ) {
      continue;
    }
    insideCount += 1;
    bin(inside, i);
  }
  if (opaque === 0 || insideCount < opaque * SIMILAR_MIN_INSIDE) return null;

  // Greedy by frequency: a bin joins the nearest cluster seed within
  // SIMILAR_CLUSTER_DISTANCE, else seeds a cluster of its own.
  /**
   * @param {Map<number, number[]>} bins
   */
  const cluster = (bins) => {
    const clusters = [];
    for (const [r, g, b, count] of [...bins.values()].sort((x, y) => y[3] - x[3])) {
      const lab = srgbToOklab([
        Math.round(r / count),
        Math.round(g / count),
        Math.round(b / count),
      ]);
      /** @type {{ lab: number[], sum: number[], count: number, spread: number } | null} */
      let best = null;
      let bestDistance = SIMILAR_CLUSTER_DISTANCE;
      for (const c of clusters) {
        const d = Math.hypot(c.lab[0] - lab[0], c.lab[1] - lab[1], c.lab[2] - lab[2]);
        if (d < bestDistance) {
          bestDistance = d;
          best = c;
        }
      }
      if (best) {
        best.sum[0] += r;
        best.sum[1] += g;
        best.sum[2] += b;
        best.count += count;
        best.spread += bestDistance * count;
      } else {
        clusters.push({ lab, sum: [r, g, b], count, spread: 0 });
      }
    }
    return clusters;
  };
  const areas = cluster(inside);
  const solidClusters = areas.filter((c) => c.count >= opaque * SOLID_MIN_SHARE);
  const covered = solidClusters.reduce((sum, c) => sum + c.count, 0);
  const spread = areas.reduce((sum, c) => sum + c.spread, 0) / insideCount;
  if (covered < insideCount * 0.9 || spread >= SIMILAR_MAX_SPREAD) return null;
  // Thin lines have no inside samples: a common color anywhere that is
  // not near an area color still counts.
  /**
   * @param {{ lab: number[] }} a
   * @param {{ lab: number[] }} b
   */
  const near = (a, b) =>
    Math.hypot(a.lab[0] - b.lab[0], a.lab[1] - b.lab[1], a.lab[2] - b.lab[2]) <
    SIMILAR_CLUSTER_DISTANCE;
  for (const c of cluster(everywhere)) {
    if (c.count >= opaque * SIMILAR_LINE_SHARE && !solidClusters.some((s) => near(s, c))) {
      solidClusters.push(c);
    }
  }
  // A small area far from every other color is an accent, not a shade.
  for (const c of areas) {
    if (
      c.count < opaque * SOLID_MIN_SHARE &&
      c.count >= opaque * SOLID_MIN_SHARE * FLAT_ACCENT_SHARE &&
      solidClusters.every(
        (s) =>
          Math.hypot(s.lab[0] - c.lab[0], s.lab[1] - c.lab[1], s.lab[2] - c.lab[2]) >=
          FLAT_ACCENT_DISTANCE,
      )
    ) {
      solidClusters.push(c);
    }
  }
  if (solidClusters.length > 32) return null;
  const solids = withoutBlendShades(
    img,
    solidClusters
      .sort((a, b) => b.count - a.count)
      .map((c) => c.sum.map((v) => Math.round(v / c.count))),
  );
  return { flat: true, colorCount: Math.max(2, solids.length), solids };
}

/**
 * analyzeFlatness on exact colors (described above), plus `solidShare`:
 * the share of samples whose exact color is one of the solids.
 * @param {ImageData} img
 */
function exactFlatness(img) {
  const { data, width } = img;
  const pixelCount = data.length / 4;
  const height = pixelCount / width;
  /**
   * @param {number} i
   */
  const keyAt = (i) => (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
  // Odd pixel stride so sampling does not lock to even image widths and
  // hit the same columns every row.
  let stride = Math.max(1, Math.ceil(pixelCount / 200_000));
  if (stride % 2 === 0) stride += 1;
  const counts = new Map();
  const interior = new Map();
  let total = 0;
  for (let p = 0; p < pixelCount; p += stride) {
    const i = p * 4;
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    const key = keyAt(i);
    counts.set(key, (counts.get(key) || 0) + 1);
    total += 1;
    const x = p % width;
    const y = (p - x) / width;
    if (
      x > 0 &&
      x < width - 1 &&
      y > 0 &&
      y < height - 1 &&
      keyAt(i - 4) === key &&
      keyAt(i + 4) === key &&
      keyAt(i - width * 4) === key &&
      keyAt(i + width * 4) === key
    ) {
      interior.set(key, (interior.get(key) || 0) + 1);
    }
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
  /**
   * @param {number} key
   */
  const toRgb = (key) => [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff];
  if (counts.size <= 32 && topCoverage < 0.9) {
    return {
      flat: true,
      colorCount: Math.max(2, counts.size),
      solids: [...counts.keys()].map(toRgb),
      solidShare: 1,
    };
  }
  if (topCoverage < 0.9) {
    const clusters = new Map();
    for (const [key, count] of counts) {
      const r = (key >> 16) & 0xff;
      const g = (key >> 8) & 0xff;
      const b = key & 0xff;
      const clusterKey = ((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6);
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
  if (topCoverage < 0.9) return { flat: false, colorCount: Math.min(32, Math.max(2, colorCount)) };
  const kept = [...counts]
    .filter(([key, count]) => {
      const share = count / total;
      if (share < SOLID_MIN_SHARE) return false;
      return share >= SOLID_LINE_SHARE || (interior.get(key) || 0) / count >= SOLID_MIN_INTERIOR;
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 32);
  const solidShare = kept.reduce((sum, [, count]) => sum + count, 0) / total;
  const solids = withoutBlendShades(
    img,
    kept.map(([key]) => toRgb(key)),
  );
  return { flat: true, colorCount: Math.max(2, solids.length), solids, solidShare };
}

/**
 * Snap every opaque pixel to the nearest of `swatches` ("#RRGGBB") in
 * Oklab: a fixed palette (brand colors, stocked inks) in place of
 * quantize's automatic one. Transparent pixels get the dominant opaque
 * color's swatch, as quantize backfills them. Mutates img in place.
 * @param {ImageData} img
 * @param {string[]} swatches
 */
export function mapToPalette(img, swatches) {
  const palette = swatches.map((hex) => {
    const rgb = /** @type {[number, number, number]} */ (parseHexColor(hex));
    return { rgb, lab: srgbToOklab(rgb) };
  });
  /** @type {Map<number, [number, number, number]>} */
  const nearest = new Map();
  /**
   * @param {number} r
   * @param {number} g
   * @param {number} b
   */
  const snap = (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    let hit = nearest.get(key);
    if (!hit) {
      const [L, A, B] = srgbToOklab([r, g, b]);
      let best = Infinity;
      for (const { rgb, lab } of palette) {
        const d = (L - lab[0]) ** 2 + (A - lab[1]) ** 2 + (B - lab[2]) ** 2;
        if (d < best) {
          best = d;
          hit = rgb;
        }
      }
      // Callers pass at least one swatch, so the loop always picks one.
      nearest.set(key, /** @type {[number, number, number]} */ (hit));
    }
    return /** @type {[number, number, number]} */ (hit);
  };
  const { data } = img;
  const dominant = dominantOpaqueColor(img);
  const backfill = dominant ? snap(dominant[0], dominant[1], dominant[2]) : palette[0].rgb;
  for (let i = 0; i < data.length; i += 4) {
    const rgb = data[i + 3] < ALPHA_THRESHOLD ? backfill : snap(data[i], data[i + 1], data[i + 2]);
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
  }
  return img;
}

// Quantize clusters colors at 6 bits per channel: a 4 MP photo carries
// around two million unique colors, which made median cut and k-means
// take tens of seconds. Bins 4 levels wide are invisible after reducing
// to at most 128 colors, and cap the work at 2^18 entries.
const QUANT_SHIFT = 2;
const QUANT_BITS = 8 - QUANT_SHIFT;
// Share of opaque pixels the most common colors must cover to seed quantize.
const FLAT_SEED_COVERAGE = 0.9;
// Oklab distance under which a common color is a near-duplicate seed: about
// one quantize bin, so resampling blends next to a solid color merge with it.
const FLAT_SEED_MIN_DISTANCE = 0.015;
// Least share of opaque pixels a flat color needs to take a palette slot.
const FLAT_SEED_MIN_SHARE = 0.001;
// Flat art seeding is for small palettes: auto-detect caps flat art at 32.
const FLAT_SEED_MAX_COLORS = 32;
// A flat color under FLAT_SEED_MIN_SHARE still takes a spare slot when it
// stands this far (Oklab) from every other color, as a small pink tongue
// does among browns and creams, and covers at least this share of that
// minimum. Highlights and shading sit closer to their own color.
const FLAT_ACCENT_DISTANCE = 0.1;
const FLAT_ACCENT_SHARE = 0.25;
// A distinct color under this share of the pixels counts as an accent when
// pixels are assigned (see accentReach2 in quantize).
const FLAT_ACCENT_MAX_SHARE = 0.005;
// Rare color groups tracked for accents, most common first.
const FLAT_ACCENT_CANDIDATES = 64;

/**
 * Median-cut color quantization to at most `colors` colors, refined with
 * k-means in Oklab. Flat art, where the `colors` most common colors cover
 * almost every pixel, keeps exactly those colors instead. Images that
 * already have at most `colors` exact colors are left untouched. A flat
 * color within `layerDiff` (the tracer's Merge) of a more common one gets
 * no slot, since the tracer would merge it away. `seeds` ([r, g, b], at
 * most `colors` used) replace that search when auto-detect already found
 * the art's colors, as compressed sources have no exact colors to seed
 * from. The palette comes from
 * opaque pixels only: hidden pixels carry garbage colors, and counting a
 * large knocked-out area as any one color would crowd small visible
 * details out of the palette. Transparent pixels are then painted with the dominant opaque
 * color's palette entry; alpha is untouched. `keep` ([r, g, b], painted
 * fill colors) join the palette exactly, on top of `colors`. Mutates img
 * in place and returns false when it remapped nothing, "flat" when the
 * palette is the art's own flat colors (seeded), otherwise "clustered".
 * @param {ImageData} img
 * @param {number} colors
 * @param {{ layerDiff?: number, seeds?: number[][] | null, keep?: number[][] | null }} [options]
 * @returns {false | "flat" | "clustered"}
 */
export function quantize(img, colors, { layerDiff = 0, seeds = null, keep = null } = {}) {
  const { data } = img;
  const kept = keep ?? [];
  const exact = new Set();
  for (let i = 0; i < data.length && exact.size <= colors + kept.length; i += 4) {
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    exact.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  }
  if (exact.size <= colors + kept.length) return false;
  const backfill = dominantOpaqueColor(img);

  /**
   * @param {number} r
   * @param {number} g
   * @param {number} b
   */
  const binOf = (r, g, b) =>
    ((r >> QUANT_SHIFT) << (2 * QUANT_BITS)) |
    ((g >> QUANT_SHIFT) << QUANT_BITS) |
    (b >> QUANT_SHIFT);
  const binCount = 1 << (3 * QUANT_BITS);
  const sumR = new Float64Array(binCount);
  const sumG = new Float64Array(binCount);
  const sumB = new Float64Array(binCount);
  const hits = new Uint32Array(binCount);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    const bin = binOf(data[i], data[i + 1], data[i + 2]);
    sumR[bin] += data[i];
    sumG[bin] += data[i + 1];
    sumB[bin] += data[i + 2];
    hits[bin] += 1;
  }

  // One entry per occupied bin, at the bin's mean color. Clustering runs
  // in Oklab so splits and distances are perceptual: low color counts
  // keep visually distinct hues apart instead of merging them by raw RGB
  // proximity.
  let n = 0;
  for (let bin = 0; bin < binCount; bin++) if (hits[bin]) n += 1;
  const entryBin = new Int32Array(n);
  const count = new Float64Array(n);
  const lab = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const means = new Array(n);
  for (let bin = 0, e = 0; bin < binCount; bin++) {
    const h = hits[bin];
    if (!h) continue;
    means[e] = [Math.round(sumR[bin] / h), Math.round(sumG[bin] / h), Math.round(sumB[bin] / h)];
    const [L, A, B] = srgbToOklab(means[e]);
    entryBin[e] = bin;
    count[e] = h;
    lab[0][e] = L;
    lab[1][e] = A;
    lab[2][e] = B;
    e += 1;
  }

  // Median cut: repeatedly split the box with the largest channel range.
  // A box's widest channel is computed once, when the box is created.
  /**
   * @param {Int32Array} members
   */
  const makeBox = (members) => {
    let range = -1;
    let channel = 0;
    if (members.length >= 2) {
      for (let c = 0; c < 3; c++) {
        // Oklab, not RGB: a and b are signed and routinely negative, so RGB
        // sentinels leave max pinned at 0 and report an all-negative axis as
        // |min|, which wins splits it should lose.
        const values = lab[c];
        let min = Infinity;
        let max = -Infinity;
        for (const e of members) {
          if (values[e] < min) min = values[e];
          if (values[e] > max) max = values[e];
        }
        if (max - min > range) {
          range = max - min;
          channel = c;
        }
      }
    }
    return { members, range, channel };
  };
  const all = new Int32Array(n);
  for (let e = 0; e < n; e++) all[e] = e;
  // Flat art: when the most common colors already cover almost every
  // pixel, each gets its own one-color box and the splitting below stops
  // at once. Anti-alias blends stretch box ranges, so median cut would
  // split them off ahead of small solid accents. Near-duplicates of a
  // color already picked (resampling blends), and colors the tracer would
  // merge into it, count toward its coverage instead of taking a slot.
  // Rare colors take no slot either: when Max colors exceeds the art's
  // real colors, spare slots would go to edge blends and add fills.
  const opaqueCount = count.reduce((total, w) => total + w, 0);
  /**
   * @type {number[]}
   */
  const common = [];
  let commonCount = 0;
  const candidates = colors <= FLAT_SEED_MAX_COLORS ? Array.from(all) : [];
  candidates.sort((a, b) => count[b] - count[a]);
  /**
   * @param {number} e
   * @param {number} p
   */
  const near = (e, p) =>
    (lab[0][e] - lab[0][p]) ** 2 + (lab[1][e] - lab[1][p]) ** 2 + (lab[2][e] - lab[2][p]) ** 2 <
      FLAT_SEED_MIN_DISTANCE ** 2 || colorDistance(means[e], means[p]) <= layerDiff;
  for (const e of candidates) {
    if (common.some((p) => near(e, p))) commonCount += count[e];
    else if (common.length < colors && count[e] >= opaqueCount * FLAT_SEED_MIN_SHARE) {
      common.push(e);
      commonCount += count[e];
    }
  }
  // Flat art with spare slots: colors too rare for one, grouped within
  // half the accent distance, since a small accent's shading spreads it
  // over many bins that only add up together.
  /** @type {{ head: number, mass: number }[]} */
  const rare = [];
  if (common.length < colors && commonCount >= opaqueCount * FLAT_SEED_COVERAGE) {
    const chosen = new Set(common);
    for (const e of candidates) {
      if (chosen.has(e) || common.some((p) => near(e, p))) continue;
      const group = rare.find(
        ({ head }) =>
          (lab[0][e] - lab[0][head]) ** 2 +
            (lab[1][e] - lab[1][head]) ** 2 +
            (lab[2][e] - lab[2][head]) ** 2 <
          (FLAT_ACCENT_DISTANCE / 2) ** 2,
      );
      if (group) group.mass += count[e];
      else if (rare.length < FLAT_ACCENT_CANDIDATES) rare.push({ head: e, mass: count[e] });
    }
  }
  if (rare.length) {
    const accents = rare.filter(
      ({ head, mass }) =>
        mass >= opaqueCount * FLAT_SEED_MIN_SHARE * FLAT_ACCENT_SHARE &&
        common.every(
          (p) =>
            Math.hypot(
              lab[0][head] - lab[0][p],
              lab[1][head] - lab[1][p],
              lab[2][head] - lab[2][p],
            ) >= FLAT_ACCENT_DISTANCE,
        ),
    );
    accents.sort((a, b) => b.mass - a.mass);
    if (accents.length) {
      // Soft edges and stray pixels also leave far-off colors, but only a
      // real accent fills an area: some of its pixels have all four
      // neighbors in its own group.
      const groupOf = new Int32Array(binCount).fill(-1);
      accents.forEach((accent, g) => {
        for (const e of all) {
          if (
            (lab[0][e] - lab[0][accent.head]) ** 2 +
              (lab[1][e] - lab[1][accent.head]) ** 2 +
              (lab[2][e] - lab[2][accent.head]) ** 2 <
            (FLAT_ACCENT_DISTANCE / 2) ** 2
          ) {
            groupOf[entryBin[e]] = g;
          }
        }
      });
      const { width } = img;
      const height = data.length / 4 / width;
      /**
       * @param {number} p
       */
      const group = (p) => {
        const i = p * 4;
        return data[i + 3] < ALPHA_THRESHOLD
          ? -1
          : groupOf[binOf(data[i], data[i + 1], data[i + 2])];
      };
      const seen = new Float64Array(accents.length);
      const inside = new Float64Array(accents.length);
      for (let p = 0; p < width * height; p++) {
        const g = group(p);
        if (g < 0) continue;
        seen[g] += 1;
        const x = p % width;
        if (x === 0 || x === width - 1 || p < width || p >= width * (height - 1)) continue;
        if (
          group(p - 1) === g &&
          group(p + 1) === g &&
          group(p - width) === g &&
          group(p + width) === g
        ) {
          inside[g] += 1;
        }
      }
      accents.forEach((accent, g) => {
        if (common.length >= colors || inside[g] < seen[g] * SOLID_MIN_INTERIOR) return;
        common.push(accent.head);
      });
    }
  }
  const given = seeds?.length ? seeds.slice(0, colors) : null;
  const seeded = given !== null || commonCount >= opaqueCount * FLAT_SEED_COVERAGE;
  const boxes = given ? [] : seeded ? common.map((e) => makeBox(Int32Array.of(e))) : [makeBox(all)];
  while (boxes.length < colors) {
    let boxIndex = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].range >= 0 && (boxIndex === -1 || boxes[i].range > boxes[boxIndex].range)) {
        boxIndex = i;
      }
    }
    if (boxIndex === -1) break;
    const { members, channel } = boxes[boxIndex];
    const values = lab[channel];
    members.sort((a, b) => values[a] - values[b]);
    // Split at the pixel-weighted median so dominant colors get their own
    // box instead of being averaged away with rare neighbors.
    let totalCount = 0;
    for (const e of members) totalCount += count[e];
    let acc = 0;
    let half = 0;
    while (half < members.length - 1 && acc + count[members[half]] < totalCount / 2) {
      acc += count[members[half]];
      half += 1;
    }
    if (half === 0) half = 1;
    boxes.splice(boxIndex, 1, makeBox(members.subarray(0, half)), makeBox(members.subarray(half)));
  }

  // Weighted average color per box seeds the palette.
  const k = given ? given.length : boxes.length;
  const palette = new Float64Array(k * 3);
  given?.forEach((rgb, p) => palette.set(srgbToOklab(rgb), p * 3));
  boxes.forEach(({ members }, b) => {
    let total = 0;
    for (const e of members) {
      palette[b * 3] += lab[0][e] * count[e];
      palette[b * 3 + 1] += lab[1][e] * count[e];
      palette[b * 3 + 2] += lab[2][e] * count[e];
      total += count[e];
    }
    for (let c = 0; c < 3; c++) palette[b * 3 + c] /= total;
  });

  // Lloyd (k-means) refinement over the entries. Median-cut alone leaves
  // centroids off the natural clusters, so gradient pixels flip between
  // adjacent palette entries and trace into thousands of ragged paths.
  const assign = new Int32Array(n).fill(-1);
  const sums = new Float64Array(k * 4);
  const errors = new Float64Array(n);
  const minPopulation = opaqueCount * 0.001;
  // A small distinct flat color (an accent) does not take the blends of a
  // soft edge between two other fills, which often pass nearest to it and
  // would trace as slivers of it along those edges. Its own shades, and
  // blends of it with a neighbor, stay with it.
  const accentReach2 = (FLAT_ACCENT_DISTANCE / 2) ** 2;
  const accent = new Uint8Array(k);
  if (seeded) {
    for (let p = 0; p < k; p++) {
      let mass = 0;
      for (let e = 0; e < n; e++) {
        const dist =
          (lab[0][e] - palette[p * 3]) ** 2 +
          (lab[1][e] - palette[p * 3 + 1]) ** 2 +
          (lab[2][e] - palette[p * 3 + 2]) ** 2;
        if (dist < accentReach2) mass += count[e];
      }
      let nearest = Infinity;
      for (let q = 0; q < k; q++) {
        if (q === p) continue;
        nearest = Math.min(
          nearest,
          (palette[q * 3] - palette[p * 3]) ** 2 +
            (palette[q * 3 + 1] - palette[p * 3 + 1]) ** 2 +
            (palette[q * 3 + 2] - palette[p * 3 + 2]) ** 2,
        );
      }
      accent[p] =
        mass < opaqueCount * FLAT_ACCENT_MAX_SHARE && nearest >= FLAT_ACCENT_DISTANCE ** 2 ? 1 : 0;
    }
  }
  // Whether entry e lies between two palette colors other than p, as a
  // soft edge's blend does (RGB, with withoutBlendShades' tolerances).
  /**
   * @type {number[][]}
   */
  const paletteRgb = [];
  for (let p = 0; p < k; p++) {
    paletteRgb.push(oklabToSrgb([palette[p * 3], palette[p * 3 + 1], palette[p * 3 + 2]]));
  }
  /**
   * @param {number} e
   * @param {number} p
   */
  const mixOfOthers = (e, p) => {
    const c = means[e];
    for (let a = 0; a < k; a++) {
      if (a === p) continue;
      for (let b = a + 1; b < k; b++) {
        if (b === p) continue;
        const from = paletteRgb[a];
        const to = paletteRgb[b];
        const dr = to[0] - from[0];
        const dg = to[1] - from[1];
        const db = to[2] - from[2];
        const len2 = dr * dr + dg * dg + db * db;
        if (!len2) continue;
        const t = ((c[0] - from[0]) * dr + (c[1] - from[1]) * dg + (c[2] - from[2]) * db) / len2;
        if (t <= SHADE_END || t >= 1 - SHADE_END) continue;
        const residual2 =
          (c[0] - from[0] - t * dr) ** 2 +
          (c[1] - from[1] - t * dg) ** 2 +
          (c[2] - from[2] - t * db) ** 2;
        if (residual2 <= SHADE_TOLERANCE * SHADE_TOLERANCE) return true;
      }
    }
    return false;
  };
  for (let iter = 0; iter < 10; iter++) {
    let changed = false;
    for (let e = 0; e < n; e++) {
      const L = lab[0][e];
      const A = lab[1][e];
      const B = lab[2][e];
      let best = 0;
      let bestDist = Infinity;
      for (let p = 0; p < k; p++) {
        const dL = L - palette[p * 3];
        const dA = A - palette[p * 3 + 1];
        const dB = B - palette[p * 3 + 2];
        const dist = dL * dL + dA * dA + dB * dB;
        if (dist < bestDist && accent[p] && dist >= accentReach2 && mixOfOthers(e, p)) continue;
        if (dist < bestDist) {
          bestDist = dist;
          best = p;
        }
      }
      errors[e] = bestDist * count[e];
      if (assign[e] !== best) {
        assign[e] = best;
        changed = true;
      }
    }
    // Seeded flat colors are the artwork's own: keep them exact rather
    // than letting the blends assigned to them pull them off.
    if (seeded) break;
    sums.fill(0);
    for (let e = 0; e < n; e++) {
      const p = assign[e] * 4;
      sums[p] += lab[0][e] * count[e];
      sums[p + 1] += lab[1][e] * count[e];
      sums[p + 2] += lab[2][e] * count[e];
      sums[p + 3] += count[e];
    }
    for (let p = 0; p < k; p++) {
      const w = sums[p * 4 + 3];
      if (w > 0) {
        palette[p * 3] = sums[p * 4] / w;
        palette[p * 3 + 1] = sums[p * 4 + 1] / w;
        palette[p * 3 + 2] = sums[p * 4 + 2] / w;
      }
    }
    // Reclaim slots below 0.1% coverage for the largest weighted error.
    // Leave a final assignment pass after reseeding before emitting pixels.
    if (iter < 9) {
      for (let p = 0; p < k; p++) {
        if (sums[p * 4 + 3] >= minPopulation) continue;
        let worst = -1;
        let worstError = 1e-12;
        for (let e = 0; e < n; e++) {
          if (sums[assign[e] * 4 + 3] >= minPopulation && errors[e] > worstError) {
            worst = e;
            worstError = errors[e];
          }
        }
        if (worst === -1) continue;
        for (let c = 0; c < 3; c++) palette[p * 3 + c] = lab[c][worst];
        errors[worst] = 0;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Painted fill colors join after clustering, exact and fixed, so they
  // neither take the image's own slots nor pull its colors off.
  const rgb = new Uint8Array((k + kept.length) * 3);
  for (let p = 0; p < k; p++) {
    rgb.set(oklabToSrgb([palette[p * 3], palette[p * 3 + 1], palette[p * 3 + 2]]), p * 3);
  }
  if (kept.length) {
    const keptLab = kept.map((color) => srgbToOklab(color));
    kept.forEach((color, j) => rgb.set(color, (k + j) * 3));
    for (let e = 0; e < n; e++) {
      let bestDist = Infinity;
      for (let p = 0; p < k; p++) {
        const dist =
          (lab[0][e] - palette[p * 3]) ** 2 +
          (lab[1][e] - palette[p * 3 + 1]) ** 2 +
          (lab[2][e] - palette[p * 3 + 2]) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          assign[e] = p;
        }
      }
      keptLab.forEach(([L, A, B], j) => {
        const dist = (lab[0][e] - L) ** 2 + (lab[1][e] - A) ** 2 + (lab[2][e] - B) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          assign[e] = k + j;
        }
      });
    }
  }
  const binToPalette = new Int32Array(binCount);
  for (let e = 0; e < n; e++) binToPalette[entryBin[e]] = assign[e];
  const backfillEntry = binToPalette[binOf(backfill[0], backfill[1], backfill[2])] * 3;
  for (let i = 0; i < data.length; i += 4) {
    const p =
      data[i + 3] < ALPHA_THRESHOLD
        ? backfillEntry
        : binToPalette[binOf(data[i], data[i + 1], data[i + 2])] * 3;
    data[i] = rgb[p];
    data[i + 1] = rgb[p + 1];
    data[i + 2] = rgb[p + 2];
  }
  return seeded ? "flat" : "clustered";
}
