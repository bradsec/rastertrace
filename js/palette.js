// Palette editing: read the traced colors out of the SVG and swap fill
// values. Edits recolor existing shapes only; geometry never changes.
import { ALPHA_THRESHOLD, parseHexColor, srgbToOklab, toHexColor } from "./preprocess.js?v=52";

/** Largest palette the swatch grid lists; above this, pick from the result. */
export const PALETTE_GRID_MAX = 16;

const FILL_ATTR = /\sfill="([^"]*)"/g;

/** @param {string} value @returns {string | null} "#RRGGBB" or null for non-hex fills */
function normalizeFill(value) {
  const rgb = /** @type {[number, number, number] | null} */ (parseHexColor(value));
  return rgb ? toHexColor(rgb) : null;
}

/**
 * Distinct hex fills in the SVG, most used first. Counts fill attributes
 * (on paths, groups and backing rects), not painted area.
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
 * Rewrite fills through `edits` (original "#RRGGBB" to new). One pass
 * over the attributes, so swapping two colors cannot chain into one.
 * @param {string} svgText
 * @param {Map<string, string>} edits
 */
export function recolorSvg(svgText, edits) {
  if (edits.size === 0) return svgText;
  return svgText.replace(FILL_ATTR, (attr, value) => {
    const fill = normalizeFill(value);
    const edited = fill && edits.get(fill);
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
