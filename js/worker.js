// Web Worker: runs preprocessing + wasm tracing off the main thread.
import init, { trace } from "../pkg/rastertrace_wasm.js?v=39";
import {
  binarizeAlpha,
  defringeAlpha,
  erodeAlpha,
  fillTransparent,
  finalizeSvg,
  medianFilter,
  modeFilter,
  quantize,
  removeBackground,
  thresholdImage,
  toGrayscale,
} from "./preprocess.js?v=39";

// Explicit versioned URL: the glue's own wasm fetch drops the ?v= query,
// so a rebuilt binary would otherwise be served from stale browser cache
// against new glue (positional args shift into garbage).
const ready = init({
  module_or_path: new URL("../pkg/rastertrace_wasm_bg.wasm?v=39", import.meta.url),
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
    const quantized = settings.colors < 256 && !settings.stencil;
    if (quantized) {
      stage(`Reducing to ${settings.colors} colors…`);
      quantize(img, settings.colors);
      modeFilter(img);
    }

    // Background knockout runs AFTER quantization so the removed color is
    // one of the final palette colors: off-white highlights that collapse
    // into the background's palette slot get removed with it, matching
    // "N colors where one is transparent".
    let knockedOut = null;
    if (settings.transparent) {
      stage("Removing background…");
      knockedOut = removeBackground(img, settings.transparent, settings.fuzz, quantized);
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
        defringeAlpha(img, settings.defringe);
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

    const finalSvg = finalizeSvg(svg, sourceWidth, sourceHeight);
    self.postMessage({
      id,
      svg: finalSvg,
      knockedOut,
      ms: Math.round(performance.now() - started),
    });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
