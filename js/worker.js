// Web Worker: runs preprocessing + wasm tracing off the main thread.
import init, { trace } from "../pkg/rastertrace_wasm.js?v=43";
import {
  applyStencilInk,
  binarizeAlpha,
  defringeAlpha,
  erodeAlpha,
  fillTransparent,
  finalizeSvg,
  medianFilter,
  reduceAndRemoveBackground,
  removeSpecks,
  smoothAlpha,
  straightenPaths,
  thresholdImage,
  toGrayscale,
} from "./preprocess.js?v=59";
import { rasterPalette, snapFills } from "./palette.js?v=13";

// Explicit versioned URL: the glue's own wasm fetch drops the ?v= query,
// so a rebuilt binary would otherwise be served from stale browser cache
// against new glue (positional args shift into garbage).
const ready = init({
  module_or_path: new URL("../pkg/rastertrace_wasm_bg.wasm?v=43", import.meta.url),
});

self.onmessage = async (event) => {
  const { id, img, settings, sourceWidth, sourceHeight } = event.data;
  const stage = (label) => self.postMessage({ id, stage: label });
  try {
    stage("Loading tracer…");
    await ready;
    const started = performance.now();
    stage("Preparing image…");

    let hasAlpha = false;
    for (let i = 3; i < img.data.length; i += 4) {
      if (img.data[i] < 255) {
        hasAlpha = true;
        break;
      }
    }

    // Stencil traces brightness only, so grayscale first makes the
    // binary threshold a luma cut instead of a red-channel cut.
    if (settings.grayscale || settings.stencil) toGrayscale(img);
    if (hasAlpha) binarizeAlpha(img);
    // Optional denoise for photographic sources; destroys intentional
    // dither/pixel-art texture, so it is opt-in. Median, not blur: it
    // removes noise without graying the edges the tracer follows.
    if (settings.denoise) {
      stage("Denoising…");
      medianFilter(img, 2);
    }
    // Binary mode ignores the palette entirely; skip the quantize cost.
    // The helper orders quantize and knockout per background mode.
    // The image holds at most `colors` colors from here on; matte repairs
    // and the trace's fills must not add more.
    const swatches = settings.stencil ? null : settings.swatches;
    const reduced = !settings.stencil && (settings.colors < 256 || Boolean(swatches?.length));
    const knockedOut = reduceAndRemoveBackground(
      img,
      settings.stencil ? 256 : settings.colors,
      // Trace pixels per source pixel: enclosed sizes are set in source px.
      { ...settings, swatches, scale: img.width / sourceWidth },
      stage,
    );
    if (settings.transparent) {
      // Before the trim: trimming would widen pinholes past the size limit.
      if (knockedOut && settings.specks > 0) {
        stage("Cleaning specks…");
        removeSpecks(img, settings.specks);
      }
      // Round off jagged cutout edges before trimming, so the trim and
      // defringe follow the smoothed boundary.
      if (knockedOut && settings.edgeSmooth > 0) {
        stage("Smoothing edges…");
        smoothAlpha(img, settings.edgeSmooth);
      }
      // Choke the matte: the knockout leaves a fringe of background-blend
      // colors along the boundary that no color tolerance can catch.
      if (knockedOut && settings.edgeTrim > 0) {
        stage("Trimming edges…");
        erodeAlpha(img, settings.edgeTrim);
      }
      // Repaint whatever fringe remains after the trim: unlike trimming,
      // this keeps thin features at full size.
      if (knockedOut && settings.defringe > 0) {
        stage("Defringing…");
        defringeAlpha(img, settings.defringe, { keepPalette: reduced });
      }
    }

    // Binary tracing keys on r < 128 and ignores alpha. Apply the user
    // threshold ourselves (pure black/white), then paint transparent
    // areas (source alpha or knockout) white so they read as background.
    if (settings.stencil) {
      thresholdImage(img, settings.stencilThreshold ?? 128);
      fillTransparent(img, [255, 255, 255]);
    }

    stage("Tracing vectors…");
    const svg = trace(
      new Uint8Array(img.data.buffer),
      img.width,
      img.height,
      settings.mode,
      settings.hierarchical || "stacked", // stacked layers vs cutout tiles
      settings.stencil ? "binary" : "color",
      settings.speckle,
      8, // color_precision: colors already reduced above, like the CLI
      settings.layerDiff,
      settings.cornerThreshold ?? 60, // degrees; lower keeps corners sharper
      settings.lengthThreshold ?? 4.0,
      10, // max_iterations
      settings.spliceThreshold ?? 45,
      settings.pathPrecision ?? 3,
    );

    // Each traced shape is filled with its pixels' average: snap fills back
    // to the reduced palette so the SVG has only the colors asked for.
    const palette = reduced ? rasterPalette(img) : null;
    const traced = palette ? snapFills(svg, palette) : svg;

    // Straighten after finalize so the tolerance applies to the same
    // path data every export format consumes.
    const straightened = straightenPaths(
      finalizeSvg(traced, sourceWidth, sourceHeight),
      settings.straighten ?? 0,
    );
    // White stencil ink is a pure recolor of the finished trace, applied
    // last so it can never affect path shape or the straighten tolerance.
    const finalSvg = settings.stencil
      ? applyStencilInk(straightened, settings.stencilInk ?? "black")
      : straightened;
    self.postMessage(
      {
        id,
        svg: finalSvg,
        knockedOut,
        ms: Math.round(performance.now() - started),
        processed: img,
      },
      { transfer: [img.data.buffer] },
    );
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
