// Web Worker: runs preprocessing + wasm tracing off the main thread.
import init, { trace } from "../pkg/rastertrace_wasm.js?v=23";
import {
  binarizeAlpha,
  defringeAlpha,
  erodeAlpha,
  finalizeSvg,
  medianFilter,
  modeFilter,
  quantize,
  removeBackground,
  toGrayscale,
} from "./preprocess.js?v=23";

const ready = init();

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

    if (settings.grayscale) toGrayscale(img);
    if (hasAlpha) binarizeAlpha(img);
    // Optional denoise for photographic sources; destroys intentional
    // dither/pixel-art texture, so it is opt-in. Median, not blur: it
    // removes noise without graying the edges the tracer follows.
    if (settings.denoise) {
      stage("Denoising…");
      medianFilter(img, 2);
    }
    const quantized = settings.colors < 256;
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

    stage("Tracing vectors…");
    const svg = trace(
      new Uint8Array(img.data.buffer),
      img.width,
      img.height,
      settings.mode,
      settings.hierarchical || "stacked", // stacked layers vs cutout tiles
      settings.speckle,
      8, // color_precision: colors already reduced above, like the CLI
      settings.layerDiff,
      settings.cornerThreshold ?? 60, // degrees; lower keeps corners sharper
      4.0, // length_threshold
      10, // max_iterations
      45, // splice_threshold
      3, // path_precision
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
