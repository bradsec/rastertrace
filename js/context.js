// Shared DOM references and mutable app state, imported by every UI
// module. Keeps no logic beyond tiny helpers so it can never participate
// in an import cycle.
import { MAX_TRACE_SIDE } from "./preprocess.js?v=43";

export const $ = (id) => document.getElementById(id);

export const els = {
  emptyState: $("empty-state"),
  workspace: $("workspace"),
  dropzone: $("dropzone"),
  pickFile: $("pick-file"),
  fileInput: $("file-input"),
  replaceImage: $("replace-image"),
  rotateLeft: $("rotate-left"),
  rotateRight: $("rotate-right"),
  invertImage: $("invert-image"),
  exportProfile: $("export-profile"),
  preset: $("preset"),
  colors: $("colors"),
  colorsOut: $("colors-out"),
  speckle: $("speckle"),
  speckleOut: $("speckle-out"),
  layerDiff: $("layer-diff"),
  layerDiffOut: $("layer-diff-out"),
  cornerThreshold: $("corner-threshold"),
  cornerThresholdOut: $("corner-threshold-out"),
  straighten: $("straighten"),
  straightenOut: $("straighten-out"),
  hierarchical: $("hierarchical"),
  upscale: $("upscale"),
  pathPrecision: $("path-precision"),
  pathPrecisionOut: $("path-precision-out"),
  lengthThreshold: $("length-threshold"),
  lengthThresholdOut: $("length-threshold-out"),
  spliceThreshold: $("splice-threshold"),
  spliceThresholdOut: $("splice-threshold-out"),
  stencil: $("stencil"),
  stencilThresholdSlot: $("stencil-threshold-slot"),
  stencilThresholdField: $("stencil-threshold-field"),
  stencilThreshold: $("stencil-threshold"),
  stencilThresholdOut: $("stencil-threshold-out"),
  stencilInkField: $("stencil-ink-field"),
  grayscale: $("grayscale"),
  crisp: $("crisp"),
  transparent: $("transparent"),
  backgroundSummary: $("background-summary"),
  knockoutColorField: $("knockout-color-field"),
  knockoutColor: $("knockout-color"),
  pickFromImage: $("pick-from-image"),
  denoise: $("denoise"),
  fuzzField: $("fuzz-field"),
  fuzz: $("fuzz"),
  fuzzOut: $("fuzz-out"),
  edgeTrimField: $("edge-trim-field"),
  edgeTrim: $("edge-trim"),
  edgeTrimOut: $("edge-trim-out"),
  defringeField: $("defringe-field"),
  defringe: $("defringe"),
  defringeOut: $("defringe-out"),
  exportSize: $("export-size"),
  physicalSizeField: $("physical-size-field"),
  physicalWidth: $("physical-width"),
  physicalUnit: $("physical-unit"),
  physicalHeightOut: $("physical-height-out"),
  minify: $("minify"),
  showResult: $("show-result"),
  showSource: $("show-source"),
  greenScreen: $("green-screen"),
  status: $("status"),
  preview: $("preview"),
  resultView: $("result-view"),
  sourceView: $("source-view"),
  tracingVeil: $("tracing-veil"),
  veilStage: $("veil-stage"),
  veilElapsed: $("veil-elapsed"),
  error: $("error"),
  statPaths: $("stat-paths"),
  statSize: $("stat-size"),
  statTime: $("stat-time"),
  copySvg: $("copy-svg"),
  downloadPng: $("download-png"),
  downloadPdf: $("download-pdf"),
  downloadDxf: $("download-dxf"),
  download: $("download"),
  resetSettingsBtn: $("reset-settings"),
  restoredNote: $("restored-note"),
  panStage: $("pan-stage"),
  zoomIn: $("zoom-in"),
  zoomOut: $("zoom-out"),
  zoomReset: $("zoom-reset"),
  eraserTool: $("eraser-tool"),
  eraserSize: $("eraser-size"),
  eraserSizeOut: $("eraser-size-out"),
  eraserUndo: $("eraser-undo"),
  eraserRedo: $("eraser-redo"),
  eraserClear: $("eraser-clear"),
  eraserCursor: $("eraser-cursor"),
  marqueeRect: $("marquee-rect"),
  marqueeEllipse: $("marquee-ellipse"),
  polygonLasso: $("polygon-lasso"),
  selectionOverlay: $("selection-overlay"),
  preferencesDialog: $("preferences-dialog"),
  measurementUnitPreference: document.querySelector('#preferences-dialog [name="measurementUnit"]'),
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
  picking: false,
  loadToken: 0, // guards against overlapping loads (drop while decoding)
  flatNote: null, // status prefix when load-time detection fired
  erasing: false,
  eraseStrokes: [], // normalized to the SVG viewBox so retracing preserves placement
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
