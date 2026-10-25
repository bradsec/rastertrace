import { tracePixels } from "./preprocess.js?v=100";
import { floodRegion, growMask, maskLoops, unionMasks } from "./magicwand.js?v=54";

/**
 * @param {{ width: number, height: number, data: Uint8ClampedArray }} raster
 * @param {{ x: number, y: number }[]} seeds normalized
 * @param {number} tolerance
 * @param {number} expand source px
 * @param {number} sourceWidth
 */
export function coarseRegion(raster, seeds, tolerance, expand, sourceWidth) {
  /** @type {Uint8Array | null} */
  let mask = null;
  let width = 0;
  let height = 0;
  for (const seed of seeds) {
    const region = floodRegion(raster, seed.x, seed.y, tolerance);
    if (!region) continue;
    ({ width, height } = region);
    mask = mask ? unionMasks(mask, region.mask) : region.mask;
  }
  if (!mask) return null;
  let x0 = width;
  let y0 = height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1);
      y1 = Math.max(y1, y + 1);
    }
  }
  const margin = 2 + Math.ceil((expand * width) / sourceWidth);
  x0 = Math.max(0, x0 - margin);
  y0 = Math.max(0, y0 - margin);
  x1 = Math.min(width, x1 + margin);
  y1 = Math.min(height, y1 + margin);
  const detail = Math.min(8, Math.floor(Math.sqrt(12_000_000 / ((x1 - x0) * (y1 - y0)))));
  return { mask, width, height, x0, y0, x1, y1, detail };
}

/**
 * @param {NonNullable<ReturnType<typeof coarseRegion>>} coarse
 * @param {ImageData | null} refined
 * @param {{ x: number, y: number }[]} seeds normalized
 * @param {number} tolerance
 * @param {number} expand source px
 * @param {number} smooth source px
 * @param {number} sourceWidth
 */
export function finishRegion(coarse, refined, seeds, tolerance, expand, smooth, sourceWidth) {
  let { mask, width, height, x0, y0, x1, y1, detail } = coarse;
  /** @type {Uint8Array | null} */
  let refinedMask = null;
  if (detail > 1 && refined) {
    for (const seed of seeds) {
      const nx = (seed.x * width - x0) / (x1 - x0);
      const ny = (seed.y * height - y0) / (y1 - y0);
      const region = floodRegion(refined, nx, ny, tolerance);
      if (region) refinedMask = refinedMask ? unionMasks(refinedMask, region.mask) : region.mask;
    }
  }
  if (refinedMask && refined) {
    mask = refinedMask;
    width = refined.width;
    height = refined.height;
  } else {
    x0 = y0 = 0;
    x1 = width;
    y1 = height;
  }
  const scale = ((width / (x1 - x0)) * coarse.width) / sourceWidth;
  const grown = growMask(mask, width, height, tracePixels(expand, scale));
  const loops = maskLoops(grown, width, height, tracePixels(smooth, scale));
  return loops.map((loop) =>
    loop.map((point) => ({
      x: (x0 + point.x * (x1 - x0)) / coarse.width,
      y: (y0 + point.y * (y1 - y0)) / coarse.height,
    })),
  );
}
