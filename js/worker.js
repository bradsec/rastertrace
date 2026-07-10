// Web Worker: runs preprocessing + wasm tracing off the main thread.
import init, { trace } from "../pkg/img2svg_wasm.js?v=8";
import {
  binarizeAlpha,
  boxBlur,
  detectBackgroundColor,
  finalizeSvg,
  knockOutColor,
  knockOutEdges,
  modeFilter,
  quantize,
  snapToImageColor,
  toGrayscale,
} from "./preprocess.js?v=8";

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
    // dither/pixel-art texture, so it is opt-in.
    if (settings.denoise) {
      stage("Denoising…");
      boxBlur(img, 2);
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
    // "N colors where one is transparent". Snapping to the nearest
    // palette color removes the whole flat cluster exactly.
    let knockedOut = null;
    if (settings.transparent === "edges") {
      stage("Removing background…");
      knockedOut = knockOutEdges(img, settings.fuzz);
    } else {
      let target = null;
      if (settings.transparent === "auto") target = detectBackgroundColor(img);
      else if (Array.isArray(settings.transparent)) target = settings.transparent;
      if (target) {
        stage("Removing background…");
        let color = target;
        let fuzz = settings.fuzz;
        if (quantized) {
          const snapped = snapToImageColor(img, target, Math.max(fuzz, 48));
          if (snapped) {
            color = snapped;
            fuzz = 0; // quantized regions are exact
          }
        }
        knockOutColor(img, color, fuzz);
        knockedOut = color;
      }
    }

    stage("Tracing vectors…");
    const svg = trace(
      new Uint8Array(img.data.buffer),
      img.width,
      img.height,
      settings.mode,
      settings.speckle,
      8, // color_precision: colors already reduced above, like the CLI
      settings.layerDiff,
      60, // corner_threshold
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
