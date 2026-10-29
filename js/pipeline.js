// Browser-side pipeline: decode, premultiplied upscale, worker round-trip.
import { assertRasterBudget, MAX_TRACE_SIDE } from "./raster.js?v=1";

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_SOURCE_PIXELS = 100_000_000;
export const MAX_SOURCE_SIDE = 32_768;

/**
 * @param {Blob} file
 */
export async function sniffImageSize(file) {
  const windowSize = 256 * 1024;
  let bytes = new Uint8Array(await file.slice(0, windowSize).arrayBuffer());
  let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /**
   * @param {number} offset
   * @param {number} length
   */
  const ascii = (offset, length) => String.fromCharCode(...bytes.slice(offset, offset + length));

  if (bytes.length >= 24 && ascii(1, 3) === "PNG") {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 10 && ascii(0, 3) === "GIF") {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length >= 26 && ascii(0, 2) === "BM") {
    return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
  }
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const type = ascii(12, 4);
    if (type === "VP8 ")
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    // Byte 20 is the 0x2f signature; the packed sizes start after it.
    if (type === "VP8L")
      return {
        width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
        height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6)),
      };
    if (type === "VP8X") {
      /**
       * @param {number} offset
       */
      const read24 = (offset) =>
        bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
      return { width: 1 + read24(24), height: 1 + read24(27) };
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // EXIF orientations 5-8 are 90-degree rotations. createImageBitmap
    // applies them during decode, so the sniffed size must be the
    // oriented one or resizeWidth would size the wrong side.
    let rotated = false;
    let base = 0; // file offset of bytes[0]
    for (let i = 2; ;) {
      // Metadata segments (ICC profiles, extended XMP) can push the frame
      // header past the first window. Slide it so a whole segment, at most
      // 64 KB, always fits.
      if (bytes.length - i < 0x10004 && base + bytes.length < file.size) {
        base += i;
        bytes = new Uint8Array(await file.slice(base, base + windowSize).arrayBuffer());
        view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        i = 0;
      }
      if (i + 9 >= bytes.length) break;
      if (bytes[i] !== 0xff) break;
      // T.81 B.1.1.2: any marker may be preceded by any number of 0xFF fill
      // bytes. Skipping them costs one loop; not skipping them reads the
      // next two bytes as a segment length and abandons a valid JPEG.
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      // Standalone markers carry no length field: TEM and the restart
      // markers. Treating their successor bytes as a length walks the scan
      // off into the entropy-coded data.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) break; // end of image, or start of scan
      const length = view.getUint16(i + 2);
      if (length < 2) break;
      if (marker === 0xe1 && ascii(i + 4, 6) === "Exif\0\0") {
        const orientation = exifOrientation(view, i + 10, i + 2 + length);
        rotated = orientation >= 5 && orientation <= 8;
      }
      // SOF0-SOF15 carry the frame dimensions; DHT, JPG and DAC share the
      // range but are not frame headers.
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        const width = view.getUint16(i + 7);
        const height = view.getUint16(i + 5);
        return rotated ? { width: height, height: width } : { width, height };
      }
      i += 2 + length;
    }
  }
  return null;
}

/**
 * EXIF orientation (1-8) from the TIFF block of a JPEG APP1 segment, or 0
 * when absent/malformed. `tiffStart` is the byte offset of the TIFF
 * header inside `view`; `end` bounds the segment.
 * @param {DataView} view
 * @param {number} tiffStart
 * @param {number} end
 */
function exifOrientation(view, tiffStart, end) {
  try {
    const byteOrder = view.getUint16(tiffStart);
    let little;
    if (byteOrder === 0x4949) little = true;
    else if (byteOrder === 0x4d4d) little = false;
    else return 0;
    if (view.getUint16(tiffStart + 2, little) !== 0x2a) return 0;
    const ifd = tiffStart + view.getUint32(tiffStart + 4, little);
    if (ifd + 2 > end) return 0;
    const entries = view.getUint16(ifd, little);
    for (let e = 0; e < entries; e++) {
      const entry = ifd + 2 + e * 12;
      if (entry + 12 > end) return 0;
      if (view.getUint16(entry, little) === 0x0112) {
        return view.getUint16(entry + 8, little);
      }
    }
  } catch {
    // truncated segment: treat as no orientation info
  }
  return 0;
}

/**
 * @param {number} width
 * @param {number} height
 */
export function fitDecodeSize(width, height, maxSide = MAX_TRACE_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Decode a File/Blob into an ImageBitmap. Throws a readable error for
 * unsupported or corrupt files.
 * @param {{ width: number, height: number } | null} [knownSize]
 * @param {File} file
 */
export async function decodeImage(file, maxSide = MAX_TRACE_SIDE, knownSize = null) {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image files must be ${MAX_IMAGE_BYTES / 1024 / 1024} MB or smaller.`);
  }
  const size = knownSize ?? (await sniffImageSize(file));
  if (!size) {
    throw new Error("Use a PNG, JPEG, WebP, GIF, or BMP image.");
  }
  if (
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0 ||
    size.width > MAX_SOURCE_SIDE ||
    size.height > MAX_SOURCE_SIDE ||
    size.width * size.height > MAX_SOURCE_PIXELS
  ) {
    throw new Error("Image dimensions are invalid or exceed the 100 megapixel source limit.");
  }
  try {
    const resized = fitDecodeSize(size.width, size.height, maxSide);
    // Browsers differ on which formats' EXIF orientation they apply
    // (Chromium honors it in PNG, WebKit does not), so never force both
    // sides: a fitting image decodes as-is, and a width alone lets the
    // browser keep the oriented aspect. capBitmap trims any overshoot.
    if (resized.width === size.width && resized.height === size.height) {
      return await createImageBitmap(file);
    }
    return await createImageBitmap(file, {
      resizeWidth: resized.width,
      resizeQuality: "high",
    });
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
 * @param {ImageBitmap} bitmap
 */
export async function capBitmap(bitmap, maxSide = MAX_TRACE_SIDE) {
  const scale = maxSide / Math.max(bitmap.width, bitmap.height);
  if (scale >= 1) return bitmap;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext("2d"));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return createImageBitmap(canvas);
}

/**
 * Rotate a bitmap 90 degrees. The caller retains ownership of the source
 * and must close it after replacing it with the returned bitmap.
 * @param {ImageBitmap} bitmap
 */
export async function rotateBitmap(bitmap, clockwise = true) {
  const canvas = new OffscreenCanvas(bitmap.height, bitmap.width);
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext("2d"));
  if (clockwise) {
    ctx.translate(bitmap.height, 0);
    ctx.rotate(Math.PI / 2);
  } else {
    ctx.translate(0, bitmap.width);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(bitmap, 0, 0);
  const rotated = await createImageBitmap(canvas);
  return rotated;
}

/**
 * Invert the RGB channels of an RGBA buffer in place. Alpha is left as-is
 * so transparent pixels stay transparent. Inversion is its own inverse:
 * applying it twice restores the original pixels.
 * @param {Uint8ClampedArray} data
 */
export function invertRGBA(data) {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i];
    data[i + 1] = 255 - data[i + 1];
    data[i + 2] = 255 - data[i + 2];
  }
}

/**
 * Return a negative copy of the bitmap. The caller retains ownership of the
 * source and must close it after replacing it with the returned bitmap.
 * @param {ImageBitmap} bitmap
 */
export async function invertBitmap(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext("2d"));
  ctx.drawImage(bitmap, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  invertRGBA(image.data);
  ctx.putImageData(image, 0, 0);
  const inverted = await createImageBitmap(canvas);
  return inverted;
}

/**
 * @param {{ loadToken: number, bitmap: ImageBitmap | null }} state
 * @param {number} loadToken
 * @param {ImageBitmap} bitmap
 */
export function bitmapOperationIsCurrent(state, loadToken, bitmap) {
  return state.loadToken === loadToken && state.bitmap === bitmap;
}

/**
 * Draw the bitmap at the given scale factor and return raw RGBA pixels.
 * Canvas interpolates in premultiplied alpha space, which is exactly the
 * halo-free resample the pipeline needs for transparent images. Scale may
 * be fractional or below 1 (device memory fit). `nearest` switches
 * upscales to nearest-neighbor for pixel-exact sources; anti-aliased
 * sources must keep smooth resampling or their edge gradients turn into
 * uneven stair-steps that trace as jagged outlines. Downscales always
 * resample smoothly: nearest-neighbor would drop pixels.
 * @param {ImageBitmap} bitmap
 * @param {number} scale
 */
export function rasterize(bitmap, scale, nearest = false) {
  assertRasterBudget(bitmap.width, bitmap.height, scale);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext("2d"));
  ctx.imageSmoothingEnabled = scale !== 1 && !(nearest && scale > 1);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/**
 * Serialize trace requests to a single worker. Only the latest request
 * matters: stale responses are dropped so slider scrubbing never shows
 * an out-of-date result. A superseded request younger than
 * `terminateAfterMs` keeps the worker alive (its late reply is dropped);
 * older ones terminate the worker to reclaim the CPU, paying one wasm
 * re-init instead of one per scrub step.
 */
export class Tracer {
  /**
   * @param {string | URL} workerUrl
   * @param {{ terminateAfterMs?: number }} [options]
   */
  constructor(workerUrl, { terminateAfterMs = 1000 } = {}) {
    this.workerUrl = workerUrl;
    this.terminateAfterMs = terminateAfterMs;
    this.nextId = 0;
    this.pending = new Map();
    /**
     * @type {((stage: string) => void) | null}
     */
    this.onProgress = null; // (stageLabel) => void, latest request only
    this.startWorker();
  }

  startWorker() {
    const worker = new Worker(this.workerUrl, { type: "module" });
    this.worker = worker;
    worker.onmessage = (event) => {
      if (this.worker !== worker) return;
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
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      for (const entry of this.pending.values()) {
        entry.reject(new Error(event.message || "Worker failed"));
      }
      this.pending.clear();
      worker.terminate();
      this.worker = null;
    };
  }

  dropPending() {
    for (const entry of this.pending.values()) entry.resolve(null);
    this.pending.clear();
  }

  cancelPending() {
    this.dropPending();
    this.worker?.terminate();
    this.startWorker();
  }

  /**
   * Trace ImageData with the given settings. Resolves to
   * { svg, ms, knockedOut } or null when superseded by a newer request.
   * @param {ImageData} imageData
   * @param {Record<string, any>} settings
   * @param {number} sourceWidth
   * @param {number} sourceHeight
   */
  trace(imageData, settings, sourceWidth, sourceHeight) {
    if (!this.worker) this.startWorker();
    if (this.pending.size) {
      const oldest = this.pending.values().next().value;
      if (Date.now() - oldest.postedAt > this.terminateAfterMs) this.cancelPending();
      else this.dropPending();
    }
    const id = this.nextId++;
    // Copy: the buffer transfers to the worker and would detach the
    // caller's ImageData otherwise.
    const img = {
      data: new Uint8ClampedArray(imageData.data),
      width: imageData.width,
      height: imageData.height,
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, postedAt: Date.now() });
      // Set above: startWorker() runs whenever the worker is missing.
      /** @type {Worker} */ (this.worker).postMessage(
        { id, img, settings, sourceWidth, sourceHeight },
        [img.data.buffer],
      );
    });
  }
}
