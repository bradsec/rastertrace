// Shared DOM references and mutable app state, imported by every UI
// module. Keeps no logic beyond tiny helpers so it can never participate
// in an import cycle.
import { MAX_TRACE_SIDE } from "./preprocess.js?v=46";

/**
 * @template {Element} [T=HTMLElement]
 * @param {string} id
 * @returns {T}
 */
export const $ = (id) => /** @type {any} */ (document.getElementById(id));

export const els = {
  emptyState: $("empty-state"),
  workspace: $("workspace"),
  dropzone: $("dropzone"),
  pickFile: /** @type {HTMLButtonElement} */ ($("pick-file")),
  fileInput: /** @type {HTMLInputElement} */ ($("file-input")),
  replaceImage: /** @type {HTMLButtonElement} */ ($("replace-image")),
  rotateLeft: /** @type {HTMLButtonElement} */ ($("rotate-left")),
  rotateRight: /** @type {HTMLButtonElement} */ ($("rotate-right")),
  invertImage: /** @type {HTMLButtonElement} */ ($("invert-image")),
  exportProfile: /** @type {HTMLSelectElement} */ ($("export-profile")),
  preset: /** @type {HTMLSelectElement} */ ($("preset")),
  colors: /** @type {HTMLInputElement} */ ($("colors")),
  colorsOut: $("colors-out"),
  speckle: /** @type {HTMLInputElement} */ ($("speckle")),
  speckleOut: $("speckle-out"),
  layerDiff: /** @type {HTMLInputElement} */ ($("layer-diff")),
  layerDiffOut: $("layer-diff-out"),
  cornerThreshold: /** @type {HTMLInputElement} */ ($("corner-threshold")),
  cornerThresholdOut: $("corner-threshold-out"),
  straighten: /** @type {HTMLInputElement} */ ($("straighten")),
  straightenOut: $("straighten-out"),
  hierarchical: /** @type {HTMLSelectElement} */ ($("hierarchical")),
  upscale: /** @type {HTMLSelectElement} */ ($("upscale")),
  pathPrecision: /** @type {HTMLInputElement} */ ($("path-precision")),
  pathPrecisionOut: $("path-precision-out"),
  lengthThreshold: /** @type {HTMLInputElement} */ ($("length-threshold")),
  lengthThresholdOut: $("length-threshold-out"),
  spliceThreshold: /** @type {HTMLInputElement} */ ($("splice-threshold")),
  spliceThresholdOut: $("splice-threshold-out"),
  stencil: /** @type {HTMLInputElement} */ ($("stencil")),
  stencilThresholdSlot: $("stencil-threshold-slot"),
  stencilThresholdField: $("stencil-threshold-field"),
  stencilThreshold: /** @type {HTMLInputElement} */ ($("stencil-threshold")),
  stencilThresholdOut: $("stencil-threshold-out"),
  stencilInkField: $("stencil-ink-field"),
  grayscale: /** @type {HTMLInputElement} */ ($("grayscale")),
  crisp: /** @type {HTMLInputElement} */ ($("crisp")),
  transparent: /** @type {HTMLSelectElement} */ ($("transparent")),
  backgroundSummary: $("background-summary"),
  knockoutColorField: $("knockout-color-field"),
  knockoutColor: /** @type {HTMLInputElement} */ ($("knockout-color")),
  pickFromImage: /** @type {HTMLButtonElement} */ ($("pick-from-image")),
  denoise: /** @type {HTMLInputElement} */ ($("denoise")),
  fuzzField: $("fuzz-field"),
  fuzz: /** @type {HTMLInputElement} */ ($("fuzz")),
  fuzzOut: $("fuzz-out"),
  edgeTrimField: $("edge-trim-field"),
  edgeTrim: /** @type {HTMLInputElement} */ ($("edge-trim")),
  edgeTrimOut: $("edge-trim-out"),
  defringeField: $("defringe-field"),
  defringe: /** @type {HTMLInputElement} */ ($("defringe")),
  defringeOut: $("defringe-out"),
  exportSize: /** @type {HTMLSelectElement} */ ($("export-size")),
  physicalSizeField: $("physical-size-field"),
  physicalWidth: /** @type {HTMLInputElement} */ ($("physical-width")),
  physicalUnit: /** @type {HTMLSelectElement} */ ($("physical-unit")),
  physicalHeightOut: $("physical-height-out"),
  minify: /** @type {HTMLInputElement} */ ($("minify")),
  showResult: /** @type {HTMLButtonElement} */ ($("show-result")),
  showSource: /** @type {HTMLButtonElement} */ ($("show-source")),
  greenScreen: /** @type {HTMLButtonElement} */ ($("green-screen")),
  status: $("status"),
  preview: $("preview"),
  resultView: /** @type {HTMLImageElement} */ ($("result-view")),
  sourceView: /** @type {HTMLImageElement} */ ($("source-view")),
  tracingVeil: $("tracing-veil"),
  veilStage: $("veil-stage"),
  veilElapsed: $("veil-elapsed"),
  error: $("error"),
  statPaths: $("stat-paths"),
  statSize: $("stat-size"),
  statTime: $("stat-time"),
  copySvg: /** @type {HTMLButtonElement} */ ($("copy-svg")),
  downloadPng: /** @type {HTMLButtonElement} */ ($("download-png")),
  downloadPdf: /** @type {HTMLButtonElement} */ ($("download-pdf")),
  downloadDxf: /** @type {HTMLButtonElement} */ ($("download-dxf")),
  download: /** @type {HTMLButtonElement} */ ($("download")),
  resetSettingsBtn: /** @type {HTMLButtonElement} */ ($("reset-settings")),
  restoredNote: $("restored-note"),
  panStage: $("pan-stage"),
  zoomIn: /** @type {HTMLButtonElement} */ ($("zoom-in")),
  zoomOut: /** @type {HTMLButtonElement} */ ($("zoom-out")),
  zoomReset: /** @type {HTMLButtonElement} */ ($("zoom-reset")),
  eraserTool: /** @type {HTMLButtonElement} */ ($("eraser-tool")),
  eraserSize: /** @type {HTMLInputElement} */ ($("eraser-size")),
  eraserSizeOut: $("eraser-size-out"),
  eraserUndo: /** @type {HTMLButtonElement} */ ($("eraser-undo")),
  eraserRedo: /** @type {HTMLButtonElement} */ ($("eraser-redo")),
  eraserClear: /** @type {HTMLButtonElement} */ ($("eraser-clear")),
  eraserCursor: $("eraser-cursor"),
  blobFillTool: /** @type {HTMLButtonElement} */ ($("blob-fill-tool")),
  blobFillColor: /** @type {HTMLInputElement} */ ($("blob-fill-color")),
  blobFillHex: /** @type {HTMLInputElement} */ ($("blob-fill-hex")),
  blobFillPick: /** @type {HTMLButtonElement} */ ($("blob-fill-pick")),
  marqueeRect: /** @type {HTMLButtonElement} */ ($("marquee-rect")),
  marqueeEllipse: /** @type {HTMLButtonElement} */ ($("marquee-ellipse")),
  polygonLasso: /** @type {HTMLButtonElement} */ ($("polygon-lasso")),
  selectionOverlay: $("selection-overlay"),
  preferencesDialog: /** @type {HTMLDialogElement} */ ($("preferences-dialog")),
  measurementUnitPreference: /** @type {HTMLSelectElement} */ (
    document.querySelector('#preferences-dialog [name="measurementUnit"]')
  ),
};

export const state = {
  bitmap: null, // capped at decodedSide; source dims kept separately
  file: null, // original file, kept for the Ultra re-decode
  rotation: 0, // quarter turns applied since load, for re-decode replay
  inverted: false, // negative applied since load, replayed on Ultra re-decode
  decodedSide: MAX_TRACE_SIDE, // cap used when bitmap was decoded
  sourceWidth: 0,
  sourceHeight: 0,
  fileName: "image",
  sourceUrl: null,
  svgRaw: null, // worker output before export post-processing
  svg: null,
  downloadUrl: null,
  debounce: 0,
  raster: null, // { scale, imageData } cache, keyed by current bitmap
  processedRaster: null, // worker pixels after current trace preprocessing
  picking: false,
  loadToken: 0, // guards against overlapping loads (drop while decoding)
  flatNote: null, // status prefix when load-time detection fired
  erasing: false,
  blobFilling: false,
  blobPicking: false,
  eraseStrokes: [], // ordered cleanup actions, normalized so retracing preserves placement
  eraseRedo: [],
  selectionTool: null,
  selection: null,
};

// Mutated in place (never reassigned) so every module sees updates.
export const preferences = { measurementUnit: "mm" };

// Late-bound entry points into app.js, assigned there. Modules call
// through this object instead of importing app.js, which would pin the
// entry module's ?v= string in two places.
export const hooks = {
  scheduleRetrace: () => {},
};

export function showError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
}
