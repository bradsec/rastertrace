// Paints cleanup actions (fills and erases) into the raster before it
// is traced, so profiles and settings apply to them like the rest of the
// artwork: a fill is traced in its color, an erase leaves a hole. Smooth
// strokes act on the reduced colors instead, so they leave as masks for
// the worker.
import { cleanupMaskSvg } from "./eraser.js?v=13";
import { parseHexColor } from "./preprocess.js?v=84";

/** @typedef {{ mode?: string, color?: string, diameter?: number, points?: unknown[], type?: string }} CleanupAction */

/**
 * Coverage per action, cropped to its bounding box: { key, x, y, width,
 * height, bits }. A stroke grows while it is drawn, so the key includes
 * its point count.
 * @type {WeakMap<CleanupAction, { key: string, x: number, y: number, width: number, height: number, bits: Uint8Array }>}
 */
const masks = new WeakMap();

/** @param {CleanupAction} action */
async function coverage(action, width, height, pixelExact) {
  const key = `${width}x${height}:${pixelExact}:${action.points?.length ?? 0}`;
  const cached = masks.get(action);
  if (cached?.key === key) return cached;
  const svg = cleanupMaskSvg(action, width, height, { pixelExact });
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  let rgba;
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = new OffscreenCanvas(width, height);
    const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (
      canvas.getContext("2d", { willReadFrequently: true })
    );
    ctx.drawImage(image, 0, 0, width, height);
    rgba = ctx.getImageData(0, 0, width, height).data;
  } finally {
    URL.revokeObjectURL(url);
  }
  // Half coverage or more counts, so painted edges stay crisp instead of
  // adding anti-alias blends for the color reduction to sort out.
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4] < 128) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const boxWidth = Math.max(0, x1 - x0 + 1);
  const boxHeight = Math.max(0, y1 - y0 + 1);
  const bits = new Uint8Array(boxWidth * boxHeight);
  for (let y = 0; y < boxHeight; y++) {
    for (let x = 0; x < boxWidth; x++) {
      bits[y * boxWidth + x] = rgba[((y + y0) * width + x + x0) * 4] >= 128 ? 1 : 0;
    }
  }
  const mask = { key, x: x0, y: y0, width: boxWidth, height: boxHeight, bits };
  masks.set(action, mask);
  return mask;
}

/**
 * A copy of `imageData` with `actions` painted in order: a fill sets its
 * color fully opaque, an erase clears alpha, a smooth stroke is skipped
 * (see smoothRegions). `pixelExact` draws strokes
 * on the pixel grid, matching how Pixel exact traces.
 * @param {ImageData} imageData
 * @param {CleanupAction[]} actions
 */
export async function bakeCleanup(imageData, actions, { pixelExact = false } = {}) {
  const { width, height } = imageData;
  const data = new Uint8ClampedArray(imageData.data);
  for (const action of actions) {
    if (action.mode === "smooth") continue;
    const mask = await coverage(action, width, height, pixelExact);
    const color = action.mode === "fill" ? parseHexColor(action.color) : null;
    for (let y = 0; y < mask.height; y++) {
      for (let x = 0; x < mask.width; x++) {
        if (!mask.bits[y * mask.width + x]) continue;
        const i = ((y + mask.y) * width + x + mask.x) * 4;
        if (color) {
          data[i] = color[0];
          data[i + 1] = color[1];
          data[i + 2] = color[2];
          data[i + 3] = 255;
        } else {
          data[i + 3] = 0;
        }
      }
    }
  }
  return new ImageData(data, width, height);
}

// A smooth stroke flattens bumps up to about this share of its diameter.
const SMOOTH_SHARE = 1 / 4;

/**
 * The smooth strokes among `actions` as smoothLabels regions of an image
 * `width` by `height`, in drawing order.
 * @param {CleanupAction[]} actions
 */
export async function smoothRegions(actions, width, height, { pixelExact = false } = {}) {
  const regions = [];
  for (const action of actions) {
    if (action.mode !== "smooth") continue;
    const mask = await coverage(action, width, height, pixelExact);
    if (!mask.width || !mask.height) continue;
    const { x, y, bits } = mask;
    const radius = (action.diameter ?? 0) * Math.min(width, height) * SMOOTH_SHARE;
    regions.push({ x, y, width: mask.width, height: mask.height, bits, radius });
  }
  return regions;
}
