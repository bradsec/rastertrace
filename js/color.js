// Color parsing and conversion: hex, sRGB to Oklab and back, swatch files.
// Pure functions: they run in Node (tests) and the browser (worker/app).

/**
 * The tracer's color difference: the sum of the RGB channel differences.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 */
export function colorDistance(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/** Most swatches a fixed palette may hold, like the 256-color ceiling. */
export const SWATCHES_MAX = 256;

/**
 * Swatches from pasted text or a text swatch file: a .gpl
 * palette ("R G B name" rows), otherwise every #RGB, #RRGGBB or bare
 * RRGGBB code in order. Returns unique "#RRGGBB", at most SWATCHES_MAX.
 * @param {string} text
 */
export function parseSwatchText(text) {
  const colors = [];
  if (/^\s*GIMP Palette/.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(?:\s|$)/.exec(line);
      const rgb = m && /** @type {[number, number, number]} */ ([
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
      ]);
      if (rgb && rgb.every((c) => c <= 255)) colors.push(toHexColor(rgb));
    }
  } else {
    for (const [, hex] of text.matchAll(
      /(?:^|[^0-9a-zA-Z#])#?([0-9a-fA-F]{6}|(?<=#)[0-9a-fA-F]{3})(?![0-9a-zA-Z])/g,
    )) {
      const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
      colors.push(`#${full.toUpperCase()}`);
    }
  }
  return [...new Set(colors)].slice(0, SWATCHES_MAX);
}

/**
 * CIE Lab (D50, as .ase files store it) to sRGB [0-255], clamped.
 * @param {number[]} lab
 */
function labD50ToSrgb([L, a, b]) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  /**
   * @param {number} t
   */
  const inv = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const x = 0.96422 * inv(fx);
  const y = 1 * inv(fy);
  const z = 0.82521 * inv(fz);
  // XYZ D50 to linear sRGB (D65), Bradford-adapted matrix.
  const lr = 3.1338561 * x - 1.6168667 * y - 0.4906146 * z;
  const lg = -0.9787684 * x + 1.9161415 * y + 0.033454 * z;
  const lb = 0.0719453 * x - 0.2289914 * y + 1.4052427 * z;
  /**
   * @param {number} v
   */
  const gam = (v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  };
  return [gam(lr), gam(lg), gam(lb)];
}

/**
 * Swatches from a swatch exchange (.ase) file. RGB entries are exact. CMYK, Lab, gray and
 * spot entries convert to screen RGB without a color profile, so
 * `approximate` is true when any appear. Throws on anything else.
 * @param {Uint8Array} bytes
 * @returns {{ swatches: string[], approximate: boolean }}
 */
export function parseAse(bytes) {
  /** @type {() => never} */
  const fail = () => {
    throw new Error("Not a readable swatch exchange (.ase) file.");
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colors = [];
  let approximate = false;
  try {
    if (String.fromCharCode(...bytes.subarray(0, 4)) !== "ASEF") fail();
    const blocks = view.getUint32(8);
    let o = 12;
    for (let n = 0; n < blocks; n++) {
      const type = view.getUint16(o);
      const length = view.getUint32(o + 2);
      const start = o + 6;
      o = start + length;
      if (o > bytes.length) fail();
      if (type !== 0x0001) continue; // group start/end
      let p = start + 2 + view.getUint16(start) * 2;
      const model = String.fromCharCode(...bytes.subarray(p, p + 4));
      p += 4;
      /**
       * @param {number} i
       */
      const f = (i) => {
        const value = view.getFloat32(p + i * 4);
        // NaN would format as "#NANNANNAN" and pass for a swatch.
        if (!Number.isFinite(value)) fail();
        return value;
      };
      /**
       * @param {number} v
       */
      const unit = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
      /**
       * @type {number[]}
       */
      let rgb;
      if (model === "RGB ") {
        rgb = [unit(f(0)), unit(f(1)), unit(f(2))];
        p += 12;
      } else if (model === "CMYK") {
        const k = 1 - f(3);
        rgb = [unit((1 - f(0)) * k), unit((1 - f(1)) * k), unit((1 - f(2)) * k)];
        approximate = true;
        p += 16;
      } else if (model === "LAB ") {
        rgb = labD50ToSrgb([f(0) * 100, f(1), f(2)]);
        approximate = true;
        p += 12;
      } else if (model === "Gray") {
        rgb = [unit(f(0)), unit(f(0)), unit(f(0))];
        approximate = true;
        p += 4;
      } else {
        fail();
      }
      if (p + 2 > o) fail();
      if (view.getUint16(p) === 1) approximate = true; // spot color
      colors.push(toHexColor(rgb));
    }
  } catch (err) {
    if (err instanceof RangeError) fail();
    throw err;
  }
  return { swatches: [...new Set(colors)].slice(0, SWATCHES_MAX), approximate };
}

/**
 * Parse "#RRGGBB" or "RRGGBB" into [r, g, b], or null.
 * @param {unknown} value any input; non-strings never match
 * @returns {[number, number, number] | null}
 */
export function parseHexColor(value) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(value).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Format [r, g, b] as "#RRGGBB".
 * @param {Iterable<number>} rgb
 */
export function toHexColor([r, g, b]) {
  return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0").toUpperCase()).join("");
}

/**
 * @param {{ width: number, height: number, data: Uint8ClampedArray } | null} imageData
 * @param {number} normalizedX
 * @param {number} normalizedY
 */
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
/** @type {Float64Array | undefined} */
let SRGB_LINEAR;
export function linearLut() {
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

/**
 * Oklab [L, a, b] back to sRGB [0-255], clamped and rounded.
 * @param {number[]} lab
 */
export function oklabToSrgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  /**
   * @param {number} v
   */
  const gam = (v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  };
  return [gam(lr), gam(lg), gam(lb)];
}

/**
 * Write the Oklab coordinates of an sRGB color into `out` (length 3).
 * Allocation-free for per-pixel use; same math as srgbToOklab.
 * @param {Float64Array} lut
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {Float64Array | number[]} out
 */
export function oklabInto(lut, r, g, b, out) {
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
