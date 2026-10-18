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

// Opt-in "Ultra" ceiling for fabrication exports (laser, cutting): 4096
// on the longest side is 16.8 MP, ~67 MB per RGBA copy. Desktop handles
// it; low-memory mobile devices may not, so it never becomes the default.
export const MAX_TRACE_SIDE_ULTRA = 4096;

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
  autoDetect: true,
  colors: 256,
  speckle: 8,
  layerDiff: 16,
  upscale: 2,
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
  lengthThreshold: 4,
  spliceThreshold: 45,
  straighten: 0,
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
  // 256 (no quantize/modeFilter pass — see js/worker.js) needs more
  // cleanup than 128, not less: raw source noise reaches the tracer
  // untouched, so despeckle/layer merging stay above the 128 entry
  // instead of continuing to taper off.
  256: { colors: 256, speckle: 3, layerDiff: 10 },
});

/**
 * Color settings auto-detection derives from one image's analyzeFlatness
 * result. Flat art snaps colors to the detected count and takes cleanup
 * from the nearest preset at or above it; photographic sources get the
 * defaults, so a photo loaded after flat art does not inherit its
 * reduced palette.
 */
export function detectedColorSettings({ flat, colorCount }) {
  if (!flat) {
    return { colors: DEFAULTS.colors, speckle: DEFAULTS.speckle, layerDiff: DEFAULTS.layerDiff };
  }
  const key = Object.keys(PRESETS)
    .map(Number)
    .sort((a, b) => a - b)
    .find((k) => k >= colorCount);
  const preset = PRESETS[key ?? 256];
  return { colors: colorCount, speckle: preset.speckle, layerDiff: preset.layerDiff };
}

// Purpose-based export profiles (SVG_EXPORT_RESEARCH.md). Values are
// applied to the visible controls like PRESETS: users can edit them
// afterwards. pathPrecision/spliceThreshold feed the tracer directly;
// minify/stencil toggle post-processing and binary color mode.
export const EXPORT_PROFILES = Object.freeze({
  web: {
    colors: 16,
    speckle: 10,
    layerDiff: 24,
    mode: "spline",
    cornerThreshold: 60,
    hierarchical: "stacked",
    pathPrecision: 1,
    upscale: 2,
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
    upscale: 2,
    straighten: 0.5,
    minify: false,
    stencil: false,
  },
  detail: {
    colors: 64,
    speckle: 2,
    layerDiff: 8,
    mode: "spline",
    cornerThreshold: 45,
    hierarchical: "stacked",
    pathPrecision: 4,
    spliceThreshold: 30,
    upscale: "auto",
    straighten: 0,
    minify: false,
    stencil: false,
  },
  maxDetail: {
    colors: 128,
    speckle: 1,
    layerDiff: 6,
    mode: "spline",
    cornerThreshold: 25,
    hierarchical: "stacked",
    pathPrecision: 4,
    spliceThreshold: 20,
    upscale: "auto",
    straighten: 0,
    minify: false,
    stencil: false,
  },
  // mode "none" (below) skips all curve/corner simplification, so colors
  // and speckle are the only levers bounding path count. 64 colors let a
  // photographic/noisy source explode into 100k+ paths and 50+ second
  // traces (observed: a 1.92 MP noisy source hit 134,243 paths, 34.5 MB,
  // 52s at colors:64/speckle:1; 8/12 tamed the same source to 1,719
  // paths, 5.9 MB, 9.9s) risking a browser tab crash, especially when the
  // slow in-flight trace gets killed and restarted by a further settings
  // change (js/pipeline.js Tracer.cancelPending). 8/12 mirrors the
  // print profile's proven low-color-count pairing.
  pixelExact: {
    colors: 8,
    speckle: 12,
    layerDiff: 6,
    mode: "none",
    cornerThreshold: 60,
    hierarchical: "stacked",
    pathPrecision: 4,
    spliceThreshold: 45,
    upscale: "auto",
    straighten: 0,
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
});

function stripInvalidXmlCharacters(value) {
  let result = "";
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    ) {
      result += character;
    }
  }
  return result;
}

/**
 * Post-process a finalized SVG for export. Options:
 * - minify: drop the XML declaration and generator comment, and compress
 *   path data (relative commands, baked translates).
 * - physicalWidth + physicalUnit ("px"|"mm"|"cm"|"in"): rewrite the root
 *   width/height to the requested unit, height from the pixel aspect ratio,
 *   keeping the viewBox so the file still scales.
 * - title: insert an escaped <title> as the first child and role="img".
 *
 * @param {string} svgText
 * @param {{ physicalWidth?: number, physicalUnit?: string, title?: string, minify?: boolean }} [options]
 */
export function applyExportOptions(svgText, { physicalWidth, physicalUnit, title, minify } = {}) {
  let out = svgText;
  if (minify) {
    out = compressSvgPaths(out.replace(/^<\?xml[^?]*\?>\s*/, "").replace(/^<!--.*?-->\s*/s, ""));
  }
  if (physicalWidth > 0 && physicalUnit) {
    out = out.replace(
      /(<svg[^>]*?) width="(\d+)" height="(\d+)"( viewBox="[^"]*")/,
      (_, head, w, h, vb) => {
        const height = Number((physicalWidth * (h / w)).toFixed(2));
        return `${head} width="${physicalWidth}${physicalUnit}" height="${height}${physicalUnit}"${vb}`;
      },
    );
  }
  if (title) {
    const escaped = stripInvalidXmlCharacters(title)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    out = out.replace(
      /(<svg[^>]*)>/,
      (_, head) => `${head} role="img">\n<title>${escaped}</title>`,
    );
  }
  return out;
}

// Compact decimal for compressed path data: at most 4 places, trailing
// zeros trimmed, "0.5" as ".5", "-0" as "0".
function compactNum(n) {
  let s = n
    .toFixed(4)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  if (s === "-0") s = "0";
  return s.replace(/^(-?)0\./, "$1.");
}

/**
 * Shrink traced SVG path data for export: bakes each path's
 * translate() into its coordinates, converts absolute M/L/C/Z commands
 * to relative ones with h/v/s shorthands and implicit repetition, and
 * trims number formatting. Paths with any other command or transform are
 * left untouched. The output is for the SVG download only; it no longer
 * matches the absolute shape parseSvgPaths expects.
 */
export function compressSvgPaths(svgText) {
  return svgText.replace(/<path\b[^>]*\/>/g, (path) => {
    const d = path.match(/\sd="([^"]*)"/)?.[1];
    if (!d) return path;
    const tr = path.match(/\stransform="([^"]*)"/)?.[1];
    let dx = 0;
    let dy = 0;
    if (tr) {
      const m = tr.match(/^translate\((-?[\d.]+)[, ](-?[\d.]+)\)$/);
      if (!m) return path;
      dx = Number(m[1]);
      dy = Number(m[2]);
    }
    const compressed = compressPathData(d, dx, dy);
    if (compressed === null) return path;
    return path
      .replace(/(\sd=")[^"]*(")/, (_, head, tail) => head + compressed + tail)
      .replace(/\s+transform="[^"]*"/, "");
  });
}

function compressPathData(d, dx, dy) {
  const tokens = d.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z]/g) || [];
  let out = "";
  let lastNum = "";
  let lastCmd = "";
  // Position a renderer of the emitted data has reached: deltas are
  // computed against it so rounding never accumulates into drift.
  let ex = 0;
  let ey = 0;
  let startX = 0;
  let startY = 0;
  let prevC2 = null; // absolute second control point of a preceding c/s
  let i = 0;
  const read = () => Number(tokens[i++]);

  const cmd = (letter) => {
    if (letter === lastCmd && (letter === "l" || letter === "c" || letter === "s")) return;
    out += letter;
    lastCmd = letter;
    lastNum = "";
  };
  const num = (n) => {
    const s = compactNum(n);
    if (lastNum && !s.startsWith("-") && !(s.startsWith(".") && lastNum.includes("."))) {
      out += " ";
    }
    out += s;
    lastNum = s;
  };

  let op = null;
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) {
      op = tokens[i++];
      if (op === "Z" || op === "z") {
        cmd("z");
        ex = startX;
        ey = startY;
        prevC2 = null;
        op = null;
        continue;
      }
    }
    switch (op) {
      case "M": {
        const x = read() + dx;
        const y = read() + dy;
        if (out === "") {
          out = "M";
          lastCmd = "M";
          lastNum = "";
          num(x);
          num(y);
        } else {
          cmd("m");
          lastCmd = ""; // pairs after m are implicit lineto, not m
          num(x - ex);
          num(y - ey);
          lastCmd = "l";
        }
        ex = x;
        ey = y;
        startX = x;
        startY = y;
        prevC2 = null;
        op = "L";
        break;
      }
      case "L": {
        const x = read() + dx;
        const y = read() + dy;
        const rx = Number(compactNum(x - ex));
        const ry = Number(compactNum(y - ey));
        if (ry === 0 && rx !== 0) {
          cmd("h");
          num(rx);
        } else if (rx === 0 && ry !== 0) {
          cmd("v");
          num(ry);
        } else {
          cmd("l");
          num(rx);
          num(ry);
        }
        ex += rx;
        ey += ry;
        prevC2 = null;
        break;
      }
      case "C": {
        const c1x = read() + dx;
        const c1y = read() + dy;
        const c2x = read() + dx;
        const c2y = read() + dy;
        const x = read() + dx;
        const y = read() + dy;
        const smooth =
          prevC2 &&
          Math.abs(2 * ex - prevC2.x - c1x) < 5e-5 &&
          Math.abs(2 * ey - prevC2.y - c1y) < 5e-5;
        const coords = smooth ? [c2x, c2y, x, y] : [c1x, c1y, c2x, c2y, x, y];
        cmd(smooth ? "s" : "c");
        const emitted = [];
        for (let k = 0; k < coords.length; k += 2) {
          const rx = Number(compactNum(coords[k] - ex));
          const ry = Number(compactNum(coords[k + 1] - ey));
          num(rx);
          num(ry);
          emitted.push([rx, ry]);
        }
        const [lx, ly] = emitted[emitted.length - 1];
        prevC2 = { x: ex + emitted[emitted.length - 2][0], y: ey + emitted[emitted.length - 2][1] };
        ex += lx;
        ey += ly;
        break;
      }
      default:
        return null; // unexpected command: leave the path untouched
    }
  }
  return out;
}

/**
 * Cut every pixel to pure black or white: r below the threshold goes
 * black, everything else white. Alpha is untouched. Run after
 * toGrayscale so r is luma; this makes the stencil threshold a user
 * control instead of vtracer's fixed cut at 128.
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
 * Recolor a binary stencil trace for white-ink output: swap the shape
 * fill to white and add an opaque black backing rect sized to the
 * trace's viewBox (not the root width/height, which can differ from it
 * under upscale). Binary stencil traces have exactly one fill value in
 * the whole document, so a blanket replace is safe. No-op for "black".
 */
export function applyStencilInk(svgText, ink) {
  if (ink !== "white") return svgText;
  const recolored = svgText.replace(/fill="#000000"/g, 'fill="#ffffff"');
  const [, w, h] = recolored.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/) || [];
  if (!w || !h) return recolored;
  return recolored.replace(/(<svg[^>]*>)/, `$1<rect width="${w}" height="${h}" fill="#000000"/>`);
}

// Validators for persisted settings. localStorage is untrusted input:
// each entry admits one control's value range and nothing else.
export function physicalWidthValue(value) {
  const width = Number(value);
  return Number.isFinite(width) && width > 0 && width <= 100000 ? width : null;
}

const SETTING_CHECKS = {
  profile: (v) => v === "" || v in EXPORT_PROFILES,
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
  straighten: (v) => Number.isFinite(v) && v >= 0 && v <= 4,
  exportSize: (v) => v === "px" || v === "physical",
  physicalWidth: (v) => typeof v === "number" && physicalWidthValue(v) !== null,
  physicalUnit: (v) => ["px", "mm", "cm", "in"].includes(v),
  minify: (v) => typeof v === "boolean",
};

/**
 * Reduce a parsed settings snapshot (e.g. from localStorage) to known
 * keys with in-range values. Anything unknown or invalid is dropped.
 */
export function sanitizeSettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, check] of Object.entries(SETTING_CHECKS)) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && check(raw[key])) {
      out[key] = raw[key];
    }
  }
  return out;
}

/** Parse "#RRGGBB" or "RRGGBB" into [r, g, b], or null. */
export function parseHexColor(value) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(value).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Format [r, g, b] as "#RRGGBB". */
export function toHexColor([r, g, b]) {
  return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0").toUpperCase()).join("");
}

export function sampleRasterColor(imageData, normalizedX, normalizedY) {
  if (!imageData?.width || !imageData?.height || !imageData.data) return null;
  const x = Math.min(imageData.width - 1, Math.max(0, Math.floor(normalizedX * imageData.width)));
  const y = Math.min(imageData.height - 1, Math.max(0, Math.floor(normalizedY * imageData.height)));
  const offset = (y * imageData.width + x) * 4;
  return [imageData.data[offset], imageData.data[offset + 1], imageData.data[offset + 2]];
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

/** @param {number[]} rgb */
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
 * Write the Oklab coordinates of an sRGB color into `out` (length 3).
 * Allocation-free for per-pixel use; same math as srgbToOklab.
 */
function oklabInto(lut, r, g, b, out) {
  const lr = lut[r];
  const lg = lut[g];
  const lb = lut[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  out[0] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

/** Fuzz-scale distance between two Oklab colors (see makeFuzzMatch). */
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
 */
function makeFuzzMatch(target, fuzz) {
  const [L1, A1, B1] = srgbToOklab(target);
  const lut = linearLut();
  let lastKey = -1;
  let lastResult = false;
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
 */
export function enclosedAreaLimit(size, scale) {
  return Math.max(1, Math.round((size * scale) ** 2));
}

/** Largest-enclosed-area slider value that means "no maximum". */
export const ENCLOSED_NO_LIMIT = 512;

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
  const steps = (from, i) => {
    if (data[i + 3] < ALPHA_THRESHOLD) return false;
    oklabInto(lut, data[i], data[i + 1], data[i + 2], toLab);
    return fuzzDistance(fromLab, toLab) <= stepLimit && fuzzDistance(seedLab, toLab) <= driftLimit;
  };

  const stack = new Uint32Array(width * height);
  let stackSize = 0;
  const take = (p) => {
    data[p * 4 + 3] = 0;
    stack[stackSize++] = p;
  };
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
  let target = null;
  if (transparent === "auto") target = detectBackgroundColor(img);
  else if (Array.isArray(transparent)) target = transparent;
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
 * pixel) for the enclosed-area limits.
 * Returns the removed color, or null. Mutates img in place.
 * @param {(label: string) => void} [stage] progress reporter
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
  } = background;
  const options = {
    contiguous,
    enclosedMinArea: enclosed ? enclosedAreaLimit(enclosedSize, scale) : 0,
    enclosedMaxArea:
      enclosedMaxSize >= ENCLOSED_NO_LIMIT ? Infinity : enclosedAreaLimit(enclosedMaxSize, scale),
    gradient,
  };
  const quantized = colors < 256;
  const reduce = () => {
    stage(`Reducing to ${colors} colors…`);
    quantize(img, colors);
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

/**
 * Speck cleanup after a knockout: clear opaque islands and fill enclosed
 * transparent pinholes smaller than `size` x `size` pixels (the same area
 * rule as the tracer's speckle filter). A pinhole takes the most common
 * opaque color around it, so quantized images keep their palette.
 * Transparent regions touching the border are background, never holes.
 * 4-connected. Mutates img in place.
 */
export function removeSpecks(img, size) {
  const maxArea = size * size;
  if (maxArea <= 1) return img;
  const { data, width, height } = img;
  const n = width * height;
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
 * Matte smoothing: box-blur the opaque mask twice with a (2r+1) window and
 * threshold it at half, so bumps and notches narrower than about `radius`
 * flatten while straight edges stay put; corners round by about `radius`
 * and features thinner than it vanish. Pixels outside the image count as
 * their nearest edge pixel, so the canvas border is not eaten. Newly
 * opaque pixels take the color of an adjacent opaque pixel. Mutates img.
 */
export function smoothAlpha(img, radius) {
  if (radius <= 0) return img;
  const { data, width, height } = img;
  const n = width * height;
  let mask = new Float32Array(n);
  for (let p = 0; p < n; p++) mask[p] = data[p * 4 + 3] >= ALPHA_THRESHOLD ? 1 : 0;
  const window = 2 * radius + 1;
  // Separable running-sum box blur with edge replication.
  const blur = (src, length, count, stride, step) => {
    const out = new Float32Array(n);
    for (let line = 0; line < count; line++) {
      const base = line * stride;
      const at = (i) => src[base + Math.min(length - 1, Math.max(0, i)) * step];
      let sum = 0;
      for (let i = -radius; i <= radius; i++) sum += at(i);
      for (let i = 0; i < length; i++) {
        out[base + i * step] = sum / window;
        sum += at(i + radius + 1) - at(i - radius);
      }
    }
    return out;
  };
  for (let pass = 0; pass < 2; pass++) {
    mask = blur(mask, width, height, width, 1);
    mask = blur(mask, height, width, 1, width);
  }

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
 * Matte defringe: recolor the outermost `depth` rings of the opaque
 * region from the colors one ring deeper, hiding background-blend fringe
 * without shrinking the shape. Complements erodeAlpha: trim deletes
 * boundary pixels (thin features shrink), defringe repaints them. Rings
 * are processed from the innermost fringe ring outward so interior colors
 * propagate to the edge; pixels with no deeper neighbor (features thinner
 * than 2*depth) keep their original color. With `keepPalette` a fringe
 * pixel takes the most common deeper color instead of their average, so a
 * color-reduced image gains no new colors. Mutates img in place.
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
 * Convert an RGB color with the same luma calculation as toGrayscale.
 * @param {[number, number, number]} color
 * @returns {[number, number, number]}
 */
export function toGrayscaleColor([r, g, b]) {
  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  return [gray, gray, gray];
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
  return {
    flat: topCoverage >= 0.9,
    colorCount: Math.min(32, Math.max(2, colorCount)),
  };
}

// Quantize clusters colors at 6 bits per channel: a 4 MP photo carries
// around two million unique colors, which made median cut and k-means
// take tens of seconds. Bins 4 levels wide are invisible after reducing
// to at most 128 colors, and cap the work at 2^18 entries.
const QUANT_SHIFT = 2;
const QUANT_BITS = 8 - QUANT_SHIFT;

/**
 * Median-cut color quantization to at most `colors` colors, refined with
 * k-means in Oklab. Images that already have at most `colors` exact
 * colors are left untouched. The palette comes from opaque pixels only:
 * hidden pixels carry garbage colors, and counting a large knocked-out
 * area as any one color would crowd small visible details out of the
 * palette. Transparent pixels are then painted with the dominant opaque
 * color's palette entry; alpha is untouched. Mutates img in place.
 */
export function quantize(img, colors) {
  const { data } = img;
  const exact = new Set();
  for (let i = 0; i < data.length && exact.size <= colors; i += 4) {
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    exact.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  }
  if (exact.size <= colors) return img;
  const backfill = dominantOpaqueColor(img);

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
  for (let bin = 0, e = 0; bin < binCount; bin++) {
    const h = hits[bin];
    if (!h) continue;
    const [L, A, B] = srgbToOklab([
      Math.round(sumR[bin] / h),
      Math.round(sumG[bin] / h),
      Math.round(sumB[bin] / h),
    ]);
    entryBin[e] = bin;
    count[e] = h;
    lab[0][e] = L;
    lab[1][e] = A;
    lab[2][e] = B;
    e += 1;
  }

  // Median cut: repeatedly split the box with the largest channel range.
  // A box's widest channel is computed once, when the box is created.
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
  const boxes = [makeBox(all)];
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
  const k = boxes.length;
  const palette = new Float64Array(k * 3);
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
  const minPopulation = count.reduce((total, w) => total + w, 0) * 0.001;
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

  // Every pixel maps through its bin to the (now converged) palette entry.
  const rgb = new Uint8Array(k * 3);
  for (let p = 0; p < k; p++) {
    rgb.set(oklabToSrgb([palette[p * 3], palette[p * 3 + 1], palette[p * 3 + 2]]), p * 3);
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
    if (fill) {
      while (
        j + 1 < matches.length &&
        fillOf(matches[j + 1][0]) === fill &&
        /^\s*$/.test(svgText.slice(matches[j].index + matches[j][0].length, matches[j + 1].index))
      ) {
        j++;
      }
    }
    if (j > i) {
      out += svgText.slice(cursor, matches[i].index) + `<g fill="${fill}">\n`;
      for (let k = i; k <= j; k++) {
        out += matches[k][0].replace(/\s+fill="[^"]*"/, "");
        out +=
          k < j
            ? svgText.slice(matches[k].index + matches[k][0].length, matches[k + 1].index)
            : "\n";
      }
      out += "</g>";
      cursor = matches[j].index + matches[j][0].length;
    }
    i = j + 1;
  }
  return out + svgText.slice(cursor);
}

/** Perpendicular distance from point p to the line through a and b. */
function distanceToChord(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len = Math.hypot(vx, vy);
  if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * vy - (p.y - a.y) * vx) / len;
}

const num = (n) => String(Number(n));

/**
 * Straighten traced path data: cubics whose control points sit within
 * `tolerance` of their chord become lines, and runs of consecutive lines
 * whose interior points sit within `tolerance` of the run's chord merge
 * into one line. Corners survive because merging stops as soon as a
 * point leaves the tolerance band. Output keeps the tracer's absolute
 * M/L/C/Z shape, so parseSvgPaths and the eraser keep working.
 */
export function straightenPaths(svgText, tolerance) {
  if (!(tolerance > 0)) return svgText;
  return svgText.replace(/(<path\b[^>]*?\sd=")([^"]*)(")/g, (_, head, d, tail) => {
    return head + straightenPathData(d, tolerance) + tail;
  });
}

function straightenPathData(d, tolerance) {
  const tokens = d.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z]/g) || [];
  let out = "";
  let i = 0;
  let cmd = null;
  let point = { x: 0, y: 0 };
  // Lines buffered for merging: linePoints[0] is the run's anchor.
  let linePoints = [];
  const read = () => Number(tokens[i++]);

  const flushLines = () => {
    while (linePoints.length > 1) {
      const anchor = linePoints[0];
      // Longest prefix whose interior points all fit the tolerance band.
      let end = 1;
      for (let j = 2; j < linePoints.length; j++) {
        let fits = true;
        for (let k = 1; k < j && fits; k++) {
          fits = distanceToChord(linePoints[k], anchor, linePoints[j]) <= tolerance;
        }
        if (fits) end = j;
        else break;
      }
      out += `L${num(linePoints[end].x)} ${num(linePoints[end].y)} `;
      linePoints = linePoints.slice(end);
    }
    linePoints = [];
  };

  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) {
      cmd = tokens[i++];
      if (cmd === "Z" || cmd === "z") {
        flushLines();
        out += "Z ";
        cmd = null;
        continue;
      }
    }
    switch (cmd) {
      case "M": {
        flushLines();
        point = { x: read(), y: read() };
        out += `M${num(point.x)} ${num(point.y)} `;
        cmd = "L"; // extra pairs after M are implicit lines
        break;
      }
      case "L": {
        const to = { x: read(), y: read() };
        if (!linePoints.length) linePoints.push(point);
        linePoints.push(to);
        point = to;
        break;
      }
      case "C": {
        const c1 = { x: read(), y: read() };
        const c2 = { x: read(), y: read() };
        const to = { x: read(), y: read() };
        const straight =
          distanceToChord(c1, point, to) <= tolerance &&
          distanceToChord(c2, point, to) <= tolerance;
        if (straight) {
          if (!linePoints.length) linePoints.push(point);
          linePoints.push(to);
        } else {
          flushLines();
          out += `C${num(c1.x)} ${num(c1.y)} ${num(c2.x)} ${num(c2.y)} ${num(to.x)} ${num(to.y)} `;
        }
        point = to;
        break;
      }
      default:
        return d; // unexpected command: leave the path untouched
    }
  }
  flushLines();
  return out;
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

/**
 * True when a worker/module failure message indicates a stale or
 * mismatched cached module (deploy caught mid-propagation, service
 * worker pinned the bad copy) rather than a tracing error.
 */
export function isStaleModuleError(message) {
  return /importing binding|does not provide an export|SyntaxError|import.* module/i.test(
    String(message || ""),
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
