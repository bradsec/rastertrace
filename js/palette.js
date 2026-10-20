// Palette editing: read the traced colors out of the SVG and swap fill
// values. Edits recolor existing shapes only; geometry never changes.
import { ALPHA_THRESHOLD, parseHexColor, srgbToOklab, toHexColor } from "./preprocess.js?v=84";

/** Largest palette the swatch grid lists; above this, pick from the result. */
export const PALETTE_GRID_MAX = 32;

const FILL_ATTR = /\sfill="([^"]*)"/g;

/** @param {string} value @returns {string | null} "#RRGGBB" or null for non-hex fills */
function normalizeFill(value) {
  const rgb = /** @type {[number, number, number] | null} */ (parseHexColor(value));
  return rgb ? toHexColor(rgb) : null;
}

/**
 * Distinct hex fills in the SVG, most used first. Counts fill attributes
 * (on paths, groups and rects), not painted area.
 * @param {string} svgText
 * @returns {{ fill: string, count: number }[]}
 */
export function svgPalette(svgText) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const [, value] of svgText.matchAll(FILL_ATTR)) {
    const fill = normalizeFill(value);
    if (fill) counts.set(fill, (counts.get(fill) ?? 0) + 1);
  }
  return [...counts]
    .map(([fill, count]) => ({ fill, count }))
    .sort((a, b) => b.count - a.count || (a.fill < b.fill ? -1 : a.fill > b.fill ? 1 : 0));
}

/**
 * Distinct opaque colors of the reduced raster, most used first, or null
 * when there are more than `maxColors` (color reduction off). This is the
 * real palette: vtracer averages each region's pixels, so one reduced
 * color reaches the SVG as many near-identical fills.
 * @param {{ width: number, height: number, data: Uint8ClampedArray } | null} imageData
 * @param {number} [maxColors]
 * @returns {{ fill: string, count: number }[] | null}
 */
export function rasterPalette(imageData, maxColors = 256) {
  if (!imageData?.data) return null;
  const { data } = imageData;
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (counts.size > maxColors) return null;
  }
  return [...counts]
    .map(([key, count]) => ({
      fill: toHexColor([(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff]),
      count,
    }))
    .sort((a, b) => b.count - a.count || (a.fill < b.fill ? -1 : a.fill > b.fill ? 1 : 0));
}

/**
 * Each distinct SVG fill to its nearest palette color in Oklab.
 * @param {string} svgText
 * @param {{ fill: string }[]} palette
 * @returns {Map<string, string>}
 */
export function paletteMapping(svgText, palette) {
  /** @type {Map<string, string>} */
  const mapping = new Map();
  for (const { fill } of svgPalette(svgText)) {
    const rgb = /** @type {[number, number, number]} */ (parseHexColor(fill));
    mapping.set(fill, nearestFill(rgb, palette) ?? fill);
  }
  return mapping;
}

/**
 * Snap every hex fill to its nearest palette color. vtracer fills each
 * shape with its pixels' average, so a trace of an 8-color raster can
 * carry dozens of near-duplicate fills; this leaves only the 8.
 * @param {string} svgText
 * @param {{ fill: string }[]} palette
 */
export function snapFills(svgText, palette) {
  const mapping = paletteMapping(svgText, palette);
  return svgText.replace(FILL_ATTR, (attr, value) => {
    const fill = normalizeFill(value);
    const snapped = fill && mapping.get(fill);
    return snapped ? ` fill="${snapped}"` : attr;
  });
}

/**
 * Rewrite fills through `edits` (palette "#RRGGBB" to new hex or "none"). `mapping`
 * resolves each SVG fill to its palette color first; without it, fills
 * match edits exactly. One pass over the attributes, so swapping two
 * colors cannot chain into one.
 * @param {string} svgText
 * @param {Map<string, string>} edits
 * @param {Map<string, string> | null} [mapping]
 */
export function recolorSvg(svgText, edits, mapping = null) {
  if (edits.size === 0) return svgText;
  return svgText.replace(FILL_ATTR, (attr, value) => {
    const fill = normalizeFill(value);
    const key = fill && (mapping?.get(fill) ?? fill);
    const edited = key && edits.get(key);
    return edited ? ` fill="${edited}"` : attr;
  });
}

/**
 * Palette fill closest to `rgb` in Oklab. vtracer may emit fills that
 * differ slightly from the raster's cluster colors, so picks snap.
 * @param {[number, number, number]} rgb
 * @param {{ fill: string }[]} palette
 * @returns {string | null}
 */
export function nearestFill(rgb, palette) {
  const [L, a, b] = srgbToOklab(rgb);
  let best = null;
  let bestDist = Infinity;
  for (const { fill } of palette) {
    const parsed = parseHexColor(fill);
    if (!parsed) continue;
    const [L2, a2, b2] = srgbToOklab(parsed);
    const dist = (L - L2) ** 2 + (a - a2) ** 2 + (b - b2) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = fill;
    }
  }
  return best;
}

/**
 * RGB at normalized coordinates, or null where the pixel is transparent
 * (knocked-out background has no traced fill to edit).
 * @param {{ width: number, height: number, data: Uint8ClampedArray } | null} imageData
 * @param {number} nx
 * @param {number} ny
 * @returns {[number, number, number] | null}
 */
export function pickColor(imageData, nx, ny) {
  if (!imageData?.width || !imageData?.height || !imageData.data) return null;
  const x = Math.min(imageData.width - 1, Math.max(0, Math.floor(nx * imageData.width)));
  const y = Math.min(imageData.height - 1, Math.max(0, Math.floor(ny * imageData.height)));
  const offset = (y * imageData.width + x) * 4;
  const { data } = imageData;
  if (data[offset + 3] < ALPHA_THRESHOLD) return null;
  return [data[offset], data[offset + 1], data[offset + 2]];
}

/**
 * Fill under a stencil raster sample. The worker's stencil raster is
 * black ink on white whatever the ink; white ink only swaps the shape fill
 * in the SVG to #FFFFFF, so nearestFill on the raw sample would open the
 * inverse color. Neither ink has a background fill, so white samples pick
 * nothing.
 * @param {[number, number, number]} rgb
 * @param {string} ink "black" or "white"
 * @returns {string | null}
 */
export function stencilFill([r], ink) {
  const dark = r < 128;
  if (!dark) return null;
  return ink === "white" ? "#FFFFFF" : "#000000";
}

/**
 * Drop edits whose original color no longer appears in the trace. Exact
 * match only: a regenerated palette has no reliable correspondence.
 * @param {Map<string, string>} edits mutated in place
 * @param {{ fill: string }[]} palette
 * @returns {number} how many edits were removed
 */
export function pruneEdits(edits, palette) {
  const present = new Set(palette.map((entry) => entry.fill));
  let removed = 0;
  for (const fill of [...edits.keys()]) {
    if (!present.has(fill)) {
      edits.delete(fill);
      removed++;
    }
  }
  return removed;
}

/**
 * Swatches for the palette grid: colors edited to the same value are one
 * merged swatch, named by its largest member. Hidden colors stay apart.
 * @param {{ fill: string }[]} palette sorted largest area first
 * @param {Map<string, string>} edits
 * @returns {{ fill: string, color: string, members: string[] }[]}
 */
export function mergeGroups(palette, edits) {
  const groups = [];
  /** @type {Map<string, { fill: string, color: string, members: string[] }>} */
  const byColor = new Map();
  for (const { fill } of palette) {
    const color = edits.get(fill) ?? fill;
    const group = color !== "none" && byColor.get(color);
    if (group) {
      group.members.push(fill);
      continue;
    }
    const created = { fill, color, members: [fill] };
    groups.push(created);
    if (color !== "none") byColor.set(color, created);
  }
  return groups;
}

/**
 * Merge `fills` into one color: the current color of the largest visible
 * one. Records an edit for every other member and returns the color.
 * @param {Map<string, string>} edits
 * @param {{ fill: string }[]} palette sorted largest area first
 * @param {string[]} fills
 * @returns {string}
 */
export function mergeEdits(edits, palette, fills) {
  const chosen = new Set(fills);
  const ordered = palette.map((entry) => entry.fill).filter((fill) => chosen.has(fill));
  const largest = ordered.find((fill) => (edits.get(fill) ?? fill) !== "none");
  const color = largest ? (edits.get(largest) ?? largest) : ordered[0];
  for (const fill of ordered) {
    if (fill === color) edits.delete(fill);
    else edits.set(fill, color);
  }
  return color;
}
