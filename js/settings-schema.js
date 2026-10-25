// Trace settings: defaults, presets, export profiles, Simplify levels, and
// validation of saved settings and presets.
// Pure functions: they run in Node (tests) and the browser (worker/app).

import { colorDistance, SWATCHES_MAX } from "./color.js?v=2";

export const DEFAULTS = Object.freeze({
  autoDetect: true,
  colors: 256,
  speckle: 8,
  layerDiff: 16,
  upscale: "auto",
  mode: "spline",
  cornerThreshold: 60,
  hierarchical: "stacked",
  grayscale: false,
  denoise: false,
  transparent: "",
  fuzz: 16,
  contiguous: false,
  enclosed: false,
  enclosedSize: 16,
  enclosedMaxSize: 512, // ENCLOSED_NO_LIMIT: declared below DEFAULTS
  gradient: false,
  specks: 0,
  edgeTrim: 0,
  edgeSmooth: 0,
  defringe: 0,
  stencil: false,
  stencilThreshold: 128,
  stencilInk: "black",
  pathPrecision: 3,
  lengthThreshold: 6,
  spliceThreshold: 60,
  straighten: 1,
  smoothOutlines: 1,
});

// Keyed by color count. Speckle and layer difference scale inversely:
// fewer colors means flat print-style output, so cleanup gets more
// aggressive; more colors means detail retention matters.
/**
 * @type {Readonly<Record<string, { colors: number, speckle: number, layerDiff: number }>>}
 */
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
  // 256 (no quantize/modeFilter pass — see js/worker.js) needs more
  // cleanup than 128, not less: raw source noise reaches the tracer
  // untouched, so despeckle/layer merging stay above the 128 entry
  // instead of continuing to taper off.
  256: { colors: 256, speckle: 3, layerDiff: 10 },
});

// The Simplify slider: one control over
// both curve-fitting tolerances, from most detail to simplest. Level 3 is
// the default pair, and the detail profiles' pairs are levels too, so a
// profile never shows as Custom.
export const SIMPLIFY_LEVELS = Object.freeze([
  { lengthThreshold: 3.5, spliceThreshold: 10 },
  { lengthThreshold: 4, spliceThreshold: 20 },
  { lengthThreshold: 4, spliceThreshold: 30 },
  { lengthThreshold: 4, spliceThreshold: 45 },
  { lengthThreshold: 6, spliceThreshold: 60 },
  { lengthThreshold: 8, spliceThreshold: 75 },
  { lengthThreshold: 10, spliceThreshold: 90 },
]);

/**
 * Index of the Simplify level with exactly these tolerances, or -1.
 * @param {number} lengthThreshold
 * @param {number} spliceThreshold
 */
export function simplifyLevel(lengthThreshold, spliceThreshold) {
  return SIMPLIFY_LEVELS.findIndex(
    (l) => l.lengthThreshold === lengthThreshold && l.spliceThreshold === spliceThreshold,
  );
}

// The lowest Merge auto-detect sets (sum of RGB channel differences).
// Shades closer than this look the same: kept apart, as a near-black
// outline and a dark background about 10 apart were, their noisy shared
// edge breaks the outline into ragged pieces. Kept low so real nearby
// shades (skin tones, hair highlights) keep their own colors; Smooth
// outlines clears the remaining edge noise.
const DETECTED_MERGE_FLOOR = 12;

/**
 * Color settings auto-detection derives from one image's analyzeFlatness
 * result. Flat art snaps colors to the detected count and takes cleanup
 * from the nearest preset at or above it; photographic sources get the
 * defaults, so a photo loaded after flat art does not inherit its
 * reduced palette.
 *
 * @param {{ flat: boolean, colorCount: number, solids?: number[][] }} analysis
 */
export function detectedColorSettings({ flat, colorCount, solids }) {
  if (!flat) {
    return { colors: DEFAULTS.colors, speckle: DEFAULTS.speckle, layerDiff: DEFAULTS.layerDiff };
  }
  const key = Object.keys(PRESETS)
    .map(Number)
    .sort((a, b) => a - b)
    .find((k) => k >= colorCount);
  const preset = PRESETS[key ?? 256];
  // The tracer merges neighboring layers whose colors differ by no more
  // than Merge, so stay under half the closest pair of detected colors,
  // but no lower than DETECTED_MERGE_FLOOR: shades closer than that look
  // the same, and kept apart their noisy shared edge breaks up outlines.
  let layerDiff = preset.layerDiff;
  if (solids && solids.length > 1) {
    let closest = Infinity;
    for (let i = 0; i < solids.length; i++) {
      for (let j = i + 1; j < solids.length; j++) {
        closest = Math.min(closest, colorDistance(solids[i], solids[j]));
      }
    }
    // The floor wins over the preset too: many-color presets set a low
    // Merge that would keep near-identical shades apart again.
    layerDiff = Math.max(DETECTED_MERGE_FLOOR, Math.min(layerDiff, Math.floor(closest / 2)));
    // Shades within Merge share a color, so they take no slot of their own.
    return {
      colors: distinctColorCount(solids, layerDiff),
      speckle: preset.speckle,
      layerDiff,
    };
  }
  return { colors: colorCount, speckle: preset.speckle, layerDiff };
}

/**
 * Color settings for an auto-detect profile on one image: flat art keeps
 * its own color count (never above the profile's) with Merge below its
 * closest pair of colors; photos keep the profile's values. Smallest
 * shape is always the profile's, as it sets the profile's detail level.
 *
 * @param {{ colors: number, speckle: number, layerDiff: number }} profile
 * @param {{ flat: boolean, colorCount: number, solids?: number[][] }} analysis
 */
export function profileColorSettings(profile, analysis) {
  if (!analysis.flat) {
    return { colors: profile.colors, speckle: profile.speckle, layerDiff: profile.layerDiff };
  }
  const detected = detectedColorSettings(analysis);
  return {
    colors: Math.min(detected.colors, profile.colors),
    speckle: profile.speckle,
    layerDiff: Math.min(detected.layerDiff, profile.layerDiff),
  };
}

/**
 * How many of the detected `solids` (most common first) keep a color of
 * their own once Merge applies: each is dropped when within `layerDiff`
 * of a more common color already kept, as quantize seeds flat art. Never
 * below the Max colors minimum of 2.
 * @param {number[][]} solids
 * @param {number} layerDiff
 */
export function distinctColorCount(solids, layerDiff) {
  return Math.max(2, distinctColors(solids, layerDiff).length);
}

/**
 * The `solids` distinctColorCount keeps, most common first.
 * @param {number[][]} solids
 * @param {number} layerDiff
 */
export function distinctColors(solids, layerDiff) {
  /**
   * @type {number[][]}
   */
  const kept = [];
  for (const color of solids) {
    if (kept.every((other) => colorDistance(color, other) > layerDiff)) kept.push(color);
  }
  return kept;
}

// Purpose-based export profiles (SVG_EXPORT_RESEARCH.md). `autoDetect`
// profiles keep color auto-detection on: flat art takes its own colors
// within the profile (profileColorSettings), photos the profile's values. Values are
// applied to the visible controls like PRESETS: users can edit them
// afterwards. pathPrecision/spliceThreshold feed the tracer directly;
// minify/stencil toggle post-processing and binary color mode.
/**
 * @typedef {{ colors: number, speckle: number, layerDiff: number, mode: string, cornerThreshold: number,
 *   hierarchical: string, pathPrecision: number, upscale: string | number, straighten: number,
 *   minify: boolean, stencil: boolean, autoDetect?: boolean, lengthThreshold?: number,
 *   spliceThreshold?: number, stencilInk?: string, smoothOutlines?: number,
 *   stencilThreshold?: number, denoise?: boolean }} ExportProfile
 * @type {Readonly<Record<string, ExportProfile>>}
 */
export const EXPORT_PROFILES = Object.freeze({
  web: {
    colors: 16,
    speckle: 10,
    layerDiff: 24,
    mode: "spline",
    cornerThreshold: 60,
    hierarchical: "stacked",
    pathPrecision: 1,
    upscale: "auto",
    straighten: 1,
    minify: true,
    stencil: false,
  },
  balanced: {
    colors: 256,
    speckle: 8,
    layerDiff: 16,
    mode: "spline",
    cornerThreshold: 60,
    hierarchical: "stacked",
    pathPrecision: 2,
    upscale: "auto",
    straighten: 0.5,
    minify: false,
    stencil: false,
    autoDetect: true,
  },
  detail: {
    colors: 64,
    speckle: 2,
    layerDiff: 8,
    mode: "spline",
    cornerThreshold: 45,
    hierarchical: "stacked",
    pathPrecision: 4,
    lengthThreshold: 4,
    spliceThreshold: 30,
    upscale: "auto",
    straighten: 0,
    minify: false,
    stencil: false,
    autoDetect: true,
  },
  maxDetail: {
    colors: 128,
    speckle: 1,
    layerDiff: 6,
    mode: "spline",
    cornerThreshold: 25,
    hierarchical: "stacked",
    pathPrecision: 4,
    lengthThreshold: 4,
    spliceThreshold: 20,
    upscale: "auto",
    straighten: 0,
    minify: false,
    stencil: false,
    autoDetect: true,
  },
  // mode "none" (below) skips all curve/corner simplification, so colors
  // are the only lever bounding path count. Speckle must be 0: at any other
  // value the tracer drops every region whose perimeter is at least its
  // area, which is every lone pixel and block up to 4x4, the very detail
  // pixel art is made of. Upscale 1: pixel edges need no resampling, and
  // each source pixel stays one trace pixel. 16 colors covers most pixel
  // art palettes; a photographic source still explodes (measured: a
  // 1.92 MP noisy source gave 154,902 paths / 17 MB in 3.8s at 16 colors)
  // but stays traceable, where 64 colors risked a tab crash.
  pixelExact: {
    colors: 16,
    speckle: 0,
    layerDiff: 6,
    mode: "none",
    cornerThreshold: 60,
    hierarchical: "stacked",
    pathPrecision: 4,
    lengthThreshold: 4,
    spliceThreshold: 45,
    upscale: 1,
    straighten: 0,
    smoothOutlines: 0,
    minify: false,
    stencil: false,
  },
  print: {
    colors: 8,
    speckle: 12,
    layerDiff: 28,
    mode: "spline",
    cornerThreshold: 45,
    hierarchical: "stacked",
    pathPrecision: 3,
    upscale: "auto",
    straighten: 1,
    minify: false,
    stencil: false,
  },
  monoBlack: {
    colors: 2,
    speckle: 6,
    layerDiff: 48,
    mode: "spline",
    cornerThreshold: 25,
    hierarchical: "stacked",
    pathPrecision: 4,
    upscale: "auto",
    straighten: 1,
    minify: false,
    stencil: true,
    stencilInk: "black",
  },
  monoWhite: {
    colors: 2,
    speckle: 6,
    layerDiff: 48,
    mode: "spline",
    cornerThreshold: 25,
    hierarchical: "stacked",
    pathPrecision: 4,
    upscale: "auto",
    straighten: 1,
    minify: false,
    stencil: true,
    stencilInk: "white",
  },
  laser: {
    colors: 2,
    speckle: 12,
    layerDiff: 48,
    mode: "spline",
    cornerThreshold: 30,
    hierarchical: "stacked",
    pathPrecision: 3,
    upscale: "auto",
    straighten: 1.5,
    minify: false,
    stencil: true,
  },
  // Multi-color vinyl (Cricut, Silhouette, plotters): Cutout layering
  // makes each color its own pieces with no overlap, so layers weed and
  // stack cleanly; strong despeckle spares tiny pieces nobody can weed.
  vinyl: {
    colors: 6,
    speckle: 16,
    layerDiff: 28,
    mode: "spline",
    cornerThreshold: 45,
    hierarchical: "cutout",
    pathPrecision: 3,
    upscale: "auto",
    straighten: 1.5,
    minify: false,
    stencil: false,
  },
  // Scanned sketches and ink drawings: denoise clears paper grain before
  // the threshold, and a lighter threshold than 128 keeps pencil strokes.
  lineArt: {
    colors: 2,
    speckle: 8,
    layerDiff: 48,
    mode: "spline",
    cornerThreshold: 45,
    hierarchical: "stacked",
    pathPrecision: 3,
    upscale: "auto",
    straighten: 0.5,
    minify: false,
    stencil: true,
    stencilInk: "black",
    stencilThreshold: 180,
    denoise: true,
  },
  // Logos and icons: flat colors, crisp corners, long straight runs and
  // few nodes, minified for the smallest file.
  icon: {
    colors: 8,
    speckle: 10,
    layerDiff: 24,
    mode: "spline",
    cornerThreshold: 45,
    hierarchical: "stacked",
    pathPrecision: 1,
    lengthThreshold: 6,
    spliceThreshold: 60,
    upscale: "auto",
    straighten: 2,
    minify: true,
    stencil: false,
  },
});

// Validators for persisted settings. localStorage is untrusted input:
// each entry admits one control's value range and nothing else.
/**
 * @param {unknown} value
 */
export function physicalWidthValue(value) {
  const width = Number(value);
  return Number.isFinite(width) && width > 0 && width <= 100000 ? width : null;
}

/**
 * @type {Record<string, (v: any) => boolean>}
 */
const SETTING_CHECKS = {
  profile: (v) =>
    v === "" || v in EXPORT_PROFILES || (typeof v === "string" && userPresetName(v) !== null),
  preset: (v) => typeof v === "string",
  autoDetect: (v) => typeof v === "boolean",
  colors: (v) => Number.isFinite(v) && v >= 2 && v <= 256,
  speckle: (v) => Number.isFinite(v) && v >= 0 && v <= 32,
  layerDiff: (v) => Number.isFinite(v) && v >= 0 && v <= 128,
  cornerThreshold: (v) => Number.isFinite(v) && v >= 0 && v <= 120,
  hierarchical: (v) => v === "stacked" || v === "cutout",
  upscale: (v) => [1, 2, 3, 4, "auto", "ultra"].includes(v),
  mode: (v) => ["spline", "polygon", "none"].includes(v),
  grayscale: (v) => typeof v === "boolean",
  denoise: (v) => typeof v === "boolean",
  stencil: (v) => typeof v === "boolean",
  stencilThreshold: (v) => Number.isFinite(v) && v >= 1 && v <= 254,
  stencilInk: (v) => v === "black" || v === "white",
  transparent: (v) => ["", "edges", "auto", "custom"].includes(v),
  knockoutColor: (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v),
  fuzz: (v) => Number.isFinite(v) && v >= 0 && v <= 255,
  contiguous: (v) => typeof v === "boolean",
  enclosed: (v) => typeof v === "boolean",
  enclosedSize: (v) => Number.isFinite(v) && v >= 1 && v <= 64,
  enclosedMaxSize: (v) => Number.isFinite(v) && v >= 8 && v <= ENCLOSED_NO_LIMIT,
  gradient: (v) => typeof v === "boolean",
  specks: (v) => Number.isFinite(v) && v >= 0 && v <= 16,
  edgeTrim: (v) => Number.isFinite(v) && v >= 0 && v <= 16,
  edgeSmooth: (v) => Number.isFinite(v) && v >= 0 && v <= 8,
  defringe: (v) => Number.isFinite(v) && v >= 0 && v <= 8,
  pathPrecision: (v) => Number.isFinite(v) && v >= 1 && v <= 4,
  lengthThreshold: (v) => Number.isFinite(v) && v >= 3.5 && v <= 10,
  spliceThreshold: (v) => Number.isFinite(v) && v >= 10 && v <= 90,
  straighten: (v) => Number.isFinite(v) && v >= 0 && v <= 16,
  smoothOutlines: (v) => Number.isInteger(v) && v >= 0 && v <= 4,
  exportSize: (v) => v === "px" || v === "physical",
  physicalWidth: (v) => typeof v === "number" && physicalWidthValue(v) !== null,
  physicalUnit: (v) => ["px", "mm", "cm", "in"].includes(v),
  minify: (v) => typeof v === "boolean",
  colorSource: (v) => v === "auto" || v === "custom",
  swatches: (v) =>
    Array.isArray(v) &&
    v.length <= SWATCHES_MAX &&
    v.every((c) => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)),
};

/**
 * Reduce a parsed settings snapshot (e.g. from localStorage) to known
 * keys with in-range values. Anything unknown or invalid is dropped.
 * @param {any} raw untrusted, e.g. parsed JSON
 * @returns {Record<string, any>}
 */
export function sanitizeSettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, check] of Object.entries(SETTING_CHECKS)) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && check(raw[key])) {
      out[key] = raw[key];
    }
  }
  return out;
}

export const PRESET_NAME_MAX = 40;
export const PRESETS_MAX = 50;
/** Export profile select value for a saved user preset. */
export const USER_PRESET_PREFIX = "user:";
// A preset stands in for the profile select and turns color auto-detection
// off when applied, so neither is stored inside it.
const PRESET_SESSION_KEYS = ["profile", "autoDetect"];

/**
 * Trimmed preset name without control characters, or null when unusable.
 * @param {unknown} value
 */
export function presetName(value) {
  if (typeof value !== "string") return null;
  // oxlint-disable-next-line no-control-regex -- stripping them is the point
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name && name.length <= PRESET_NAME_MAX ? name : null;
}

/**
 * Preset name from a "user:<name>" profile value, or null.
 * @param {string} profile
 */
export function userPresetName(profile) {
  return profile.startsWith(USER_PRESET_PREFIX)
    ? presetName(profile.slice(USER_PRESET_PREFIX.length))
    : null;
}

/**
 * @param {string} a
 * @param {string} b
 */
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * Validate saved or imported presets: a bare array or an export file's
 * { presets }. Names compare case-insensitively and the first one wins;
 * each preset's settings pass sanitizeSettings. Capped at PRESETS_MAX.
 * @returns {{ name: string, settings: object }[]}
 * @param {any} raw untrusted, e.g. parsed JSON
 */
export function sanitizePresets(raw) {
  const entries = Array.isArray(raw) ? raw : Array.isArray(raw?.presets) ? raw.presets : [];
  /** @type {{ name: string, settings: Record<string, any> }[]} */
  const out = [];
  for (const entry of entries) {
    if (out.length >= PRESETS_MAX) break;
    const name = presetName(entry?.name);
    if (!name || out.some((p) => sameName(p.name, name))) continue;
    const settings = sanitizeSettings(entry.settings);
    for (const key of PRESET_SESSION_KEYS) delete settings[key];
    out.push({ name, settings });
  }
  return out;
}

/**
 * Add `incoming` presets to `list` without mutating it. A same-named
 * preset is replaced in place (or skipped with replace: false); new names
 * append while the list is under PRESETS_MAX.
 * @param {{ name: string, settings: object }[]} list
 * @param {{ name: string, settings: object }[]} incoming
 * @param {{ replace?: boolean }} [options]
 */
export function mergePresets(list, incoming, { replace = true } = {}) {
  const presets = [...list];
  const added = [];
  const replaced = [];
  const skipped = [];
  for (const preset of incoming) {
    const index = presets.findIndex((p) => sameName(p.name, preset.name));
    if (index >= 0 && replace) {
      presets[index] = preset;
      replaced.push(preset.name);
    } else if (index < 0 && presets.length < PRESETS_MAX) {
      presets.push(preset);
      added.push(preset.name);
    } else {
      skipped.push(preset.name);
    }
  }
  return { presets, added, replaced, skipped };
}

/** Largest-enclosed-area slider value that means "no maximum". */
export const ENCLOSED_NO_LIMIT = 512;

/**
 * Resolve preset + explicit values the same way the CLI does:
 * explicit user values win over preset values, preset over defaults.
 * `explicit` holds only the keys the user actually set.
 * @param {string | number | null | undefined} preset PRESETS key
 * @param {Record<string, unknown>} [explicit]
 */
export function resolveSettings(preset, explicit = {}) {
  /** @type {Record<string, unknown>} */
  const merged = { ...DEFAULTS, ...(preset ? PRESETS[preset] : {}) };
  for (const [key, value] of Object.entries(explicit)) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  return merged;
}
