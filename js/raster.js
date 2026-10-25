// Raster basics shared by the pipeline: the alpha cutoff and trace size limits.
// Pure functions: they run in Node (tests) and the browser (worker/app).

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

// "Ultra" ceiling for fabrication exports (laser, cutting): 4096 on the
// longest side is 16.8 MP, ~67 MB per RGBA copy. Desktop handles it;
// low-memory mobile devices may not, so Auto only reaches it for flat art
// that is already that large, never by upscaling.
export const MAX_TRACE_SIDE_ULTRA = 4096;

// Pixel settings (Smallest shape, clean specks, edge smooth, edge trim,
// defringe, wand expand) were tuned at the former 2x default trace scale,
// which large sources never reached: they traced at the size cap, below
// 2x, with these settings in plain trace pixels.
const REFERENCE_SCALE = 2;

/**
 * A pixel setting in trace pixels at `scale` (trace px per source px), so
 * it covers the same part of the image whatever the upscale. Below the
 * reference scale it stays in trace pixels, as it was tuned: shrinking it
 * with a large source's downscale would let edge noise through as specks
 * and ragged outlines. A set value never rounds away to nothing; 0 stays
 * off.
 * @param {number} value
 * @param {number} scale
 */
export function tracePixels(value, scale) {
  if (value <= 0) return 0;
  return Math.max(1, Math.round((value * Math.max(scale, REFERENCE_SCALE)) / REFERENCE_SCALE));
}

/**
 * Effective scale factor for tracing: the requested upscale, capped so
 * the longest side never exceeds maxSide. Below 1 the image is
 * downscaled before tracing.
 * @param {number} width
 * @param {number} height
 * @param {number} upscale
 */
export function fitTraceScale(width, height, upscale, maxSide = MAX_TRACE_SIDE) {
  return Math.min(upscale, maxSide / Math.max(width, height));
}

/**
 * Throw a readable error when width x height at the given upscale factor
 * exceeds MAX_TRACE_PIXELS. Returns the upscaled pixel count otherwise.
 * @param {number} width
 * @param {number} height
 * @param {number} upscale
 */
export function assertRasterBudget(width, height, upscale) {
  const pixels = width * upscale * height * upscale;
  if (pixels > MAX_TRACE_PIXELS) {
    /**
     * @param {number} n
     */
    const mp = (n) => `${Math.round(n / 1e6)} MP`;
    throw new Error(
      `Image is too large to trace at ${upscale}x (${mp(pixels)}; limit ${mp(MAX_TRACE_PIXELS)}). Lower the upscale factor or use a smaller image.`,
    );
  }
  return pixels;
}
