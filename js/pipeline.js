// Browser-side pipeline: decode, premultiplied upscale, worker round-trip.
import { assertRasterBudget } from "./preprocess.js?v=7";

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
 * Draw the bitmap at the given scale factor and return raw RGBA pixels.
 * Canvas interpolates in premultiplied alpha space, which is exactly the
 * halo-free resample the pipeline needs for transparent images. Scale may
 * be fractional or below 1 (device memory fit).
 */
export function rasterize(bitmap, scale) {
  assertRasterBudget(bitmap.width, bitmap.height, scale);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = scale !== 1;
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
