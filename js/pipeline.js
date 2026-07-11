// Browser-side pipeline: decode, premultiplied upscale, worker round-trip.
import { assertRasterBudget, MAX_TRACE_SIDE } from "./preprocess.js?v=16";

/**
 * Decode a File/Blob into an ImageBitmap. Throws a readable error for
 * unsupported or corrupt files.
 */
export async function decodeImage(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error(`Cannot read "${file.name}" as an image.`);
  }
}

/**
 * Cap a decoded bitmap at MAX_TRACE_SIDE on its longest side, closing the
 * original. Tracing never uses more pixels than that, and the bitmap is
 * retained for the app lifetime: without the cap a 100 MP panorama would
 * hold ~400 MB, enough to kill an iOS tab on its own. Returns the bitmap
 * unchanged when it already fits.
 */
export async function capBitmap(bitmap) {
  const scale = MAX_TRACE_SIDE / Math.max(bitmap.width, bitmap.height);
  if (scale >= 1) return bitmap;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return createImageBitmap(canvas);
}

/**
 * Rotate a bitmap 90 degrees, closing the original.
 */
export async function rotateBitmap(bitmap, clockwise = true) {
  const canvas = new OffscreenCanvas(bitmap.height, bitmap.width);
  const ctx = canvas.getContext("2d");
  if (clockwise) {
    ctx.translate(bitmap.height, 0);
    ctx.rotate(Math.PI / 2);
  } else {
    ctx.translate(0, bitmap.width);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return createImageBitmap(canvas);
}

/**
 * Draw the bitmap at the given scale factor and return raw RGBA pixels.
 * Canvas interpolates in premultiplied alpha space, which is exactly the
 * halo-free resample the pipeline needs for transparent images. Scale may
 * be fractional or below 1 (device memory fit). `crisp` disables
 * interpolation entirely (nearest-neighbor) so flat-color sources keep
 * hard edges instead of gaining manufactured gradient pixels.
 */
export function rasterize(bitmap, scale, crisp = false) {
  assertRasterBudget(bitmap.width, bitmap.height, scale);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = scale !== 1 && !crisp;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/**
 * Serialize trace requests to a single worker. Only the latest request
 * matters: stale responses are dropped so slider scrubbing never shows
 * an out-of-date result.
 */
export class Tracer {
  constructor(workerUrl) {
    this.worker = new Worker(workerUrl, { type: "module" });
    this.nextId = 0;
    this.pending = new Map();
    this.onProgress = null; // (stageLabel) => void, latest request only
    this.worker.onmessage = (event) => {
      const { id, stage } = event.data;
      if (stage !== undefined) {
        if (id === this.nextId - 1) this.onProgress?.(stage);
        return;
      }
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (id !== this.nextId - 1) return entry.resolve(null); // stale
      if (event.data.error) entry.reject(new Error(event.data.error));
      else entry.resolve(event.data);
    };
    this.worker.onerror = (event) => {
      for (const entry of this.pending.values()) {
        entry.reject(new Error(event.message || "Worker failed"));
      }
      this.pending.clear();
    };
  }

  /**
   * Trace ImageData with the given settings. Resolves to
   * { svg, ms, knockedOut } or null when superseded by a newer request.
   */
  trace(imageData, settings, sourceWidth, sourceHeight) {
    const id = this.nextId++;
    // Copy: the buffer transfers to the worker and would detach the
    // caller's ImageData otherwise.
    const img = {
      data: new Uint8ClampedArray(imageData.data),
      width: imageData.width,
      height: imageData.height,
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, img, settings, sourceWidth, sourceHeight }, [
        img.data.buffer,
      ]);
    });
  }
}
