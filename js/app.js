// UI wiring: state, controls, preview, download.
import { capBitmap, decodeImage, invertBitmap, rasterize, rotateBitmap, Tracer } from "./pipeline.js?v=40";
import { parseSvgPaths, toDxf, toPdf } from "./vectorexport.js?v=39";
import { applyEraserMask, snapPointToAngle, svgViewBox } from "./eraser.js?v=3";
import {
  analyzeFlatness,
  applyExportOptions,
  countPaths,
  DEFAULTS,
  EXPORT_PROFILES,
  fitTraceScale,
  MAX_TRACE_SIDE,
  MAX_TRACE_SIDE_ULTRA,
  parseHexColor,
  PRESETS,
  sanitizeSettings,
  toHexColor,
} from "./preprocess.js?v=40";

const $ = (id) => document.getElementById(id);
const EMPTY_IMAGE_SRC = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

const els = {
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

const state = {
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

const PREFERENCES_KEY = "rastertrace-preferences";
const PHYSICAL_UNITS = new Set(["in", "cm", "mm"]);
const MEASUREMENT_UNITS = new Set(["px", "in", "cm", "mm"]);
const MM_PER_UNIT = { in: 25.4, cm: 10, mm: 1 };
const DISPLAY_UNITS_PER_INCH = { px: 96, in: 1, cm: 2.54, mm: 25.4 };
let preferences = { measurementUnit: "mm" };

function readPreferences(fallbackUnit = "mm") {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "{}");
    return {
      measurementUnit: MEASUREMENT_UNITS.has(saved.measurementUnit)
        ? saved.measurementUnit
        : fallbackUnit,
    };
  } catch {
    return { measurementUnit: fallbackUnit };
  }
}

function savePreferences() {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences still apply for this session when storage is unavailable.
  }
}

function convertPhysicalValue(value, fromUnit, toUnit) {
  return value * MM_PER_UNIT[fromUnit] / MM_PER_UNIT[toUnit];
}

function applyMeasurementUnit(unit, preserveSize = true) {
  if (!MEASUREMENT_UNITS.has(unit)) return;
  if (unit === "px") {
    updatePhysicalHeightOut();
    refreshExport();
    return;
  }
  const previousUnit = PHYSICAL_UNITS.has(els.physicalUnit.value) ? els.physicalUnit.value : "mm";
  const width = Number(els.physicalWidth.value);
  if (preserveSize && previousUnit !== unit && width > 0) {
    const converted = convertPhysicalValue(width, previousUnit, unit);
    els.physicalWidth.value = String(Number(converted.toFixed(unit === "in" ? 3 : 2)));
  }
  els.physicalUnit.value = unit;
  updatePhysicalHeightOut();
  refreshExport();
}

function formatDimensionsFromInches(width, height) {
  const unit = preferences.measurementUnit;
  const displayWidth = width * DISPLAY_UNITS_PER_INCH[unit];
  const displayHeight = height * DISPLAY_UNITS_PER_INCH[unit];
  const digits = unit === "px" ? 0 : unit === "in" ? 2 : 1;
  return `${displayWidth.toFixed(digits)}×${displayHeight.toFixed(digits)} ${unit}`;
}

const tracer = new Tracer(new URL("./worker.js?v=40", import.meta.url));

function currentSettings() {
  return {
    colors: Number(els.colors.value),
    speckle: Number(els.speckle.value),
    layerDiff: Number(els.layerDiff.value),
    cornerThreshold: Number(els.cornerThreshold.value),
    straighten: Number(els.straighten.value),
    hierarchical: els.hierarchical.value,
    upscale: els.upscale.value === "auto" || els.upscale.value === "ultra"
      ? els.upscale.value
      : Number(els.upscale.value),
    mode: document.querySelector('input[name="mode"]:checked').value,
    grayscale: els.grayscale.checked,
    denoise: els.denoise.checked,
    crisp: els.crisp.checked,
    stencil: els.stencil.checked,
    stencilThreshold: Number(els.stencilThreshold.value),
    pathPrecision: Number(els.pathPrecision.value),
    lengthThreshold: Number(els.lengthThreshold.value),
    spliceThreshold: Number(els.spliceThreshold.value),
    transparent:
      els.transparent.value === "auto" || els.transparent.value === "edges"
        ? els.transparent.value
        : els.transparent.value === "custom"
          ? parseHexColor(els.knockoutColor.value)
          : null,
    fuzz: Number(els.fuzz.value),
    edgeTrim: Number(els.edgeTrim.value),
    defringe: Number(els.defringe.value),
  };
}

function updateOutputs() {
  const colors = Number(els.colors.value);
  els.colorsOut.textContent = colors >= 256 ? "All" : String(colors);
  els.speckleOut.textContent = els.speckle.value;
  els.layerDiffOut.textContent = els.layerDiff.value;
  els.cornerThresholdOut.textContent = els.cornerThreshold.value;
  els.straightenOut.textContent = Number(els.straighten.value) === 0 ? "Off" : els.straighten.value;
  els.fuzzOut.textContent = els.fuzz.value;
  els.edgeTrimOut.textContent = els.edgeTrim.value;
  els.defringeOut.textContent = els.defringe.value;
  els.pathPrecisionOut.textContent = els.pathPrecision.value;
  els.lengthThresholdOut.textContent = els.lengthThreshold.value;
  els.spliceThresholdOut.textContent = els.spliceThreshold.value;
  els.stencilThresholdOut.textContent = els.stencilThreshold.value;
}

function updateStencilFields() {
  els.stencilThresholdField.hidden = !els.stencil.checked;
  // The Laser profile's main dial belongs at the top, under the profile
  // select; anywhere else it lives in the Tracing panel next to the
  // stencil checkbox. Moving the node keeps value and listeners.
  const atTop = els.stencil.checked && els.exportProfile.value === "laser";
  els.stencilThresholdSlot.hidden = !atTop;
  if (atTop && els.stencilThresholdField.parentElement !== els.stencilThresholdSlot) {
    els.stencilThresholdSlot.appendChild(els.stencilThresholdField);
  } else if (!atTop && els.stencilThresholdField.parentElement === els.stencilThresholdSlot) {
    els.stencil.closest("label").after(els.stencilThresholdField);
  }
}

/**
 * Apply a purpose-based export profile: moves the visible controls (like
 * presets do) and sets the export post-processing toggles. Everything
 * stays user-editable afterwards.
 */
function applyExportProfile(name) {
  const profile = EXPORT_PROFILES[name];
  if (!profile) return;
  // Clean slate first: leftover tweaks (an old stencil threshold,
  // background removal, physical size) would silently combine with the
  // profile and can blank the result entirely.
  resetSettings();
  els.restoredNote.hidden = true;
  els.colors.value = String(profile.colors);
  els.speckle.value = String(profile.speckle);
  els.layerDiff.value = String(profile.layerDiff);
  els.cornerThreshold.value = String(profile.cornerThreshold);
  els.straighten.value = String(profile.straighten);
  document.querySelector(`input[name="mode"][value="${profile.mode}"]`).checked = true;
  els.hierarchical.value = profile.hierarchical;
  els.upscale.value = String(profile.upscale);
  els.stencil.checked = profile.stencil;
  els.pathPrecision.value = String(profile.pathPrecision);
  if (profile.spliceThreshold) els.spliceThreshold.value = String(profile.spliceThreshold);
  els.minify.checked = profile.minify;
  els.preset.value = "";
  els.exportProfile.value = name; // resetSettings cleared the select
  updateStencilFields(); // after the select: Laser moves the threshold up top
  updateOutputs();
}

function clearProfile() {
  els.exportProfile.value = "";
  updateStencilFields(); // threshold slides back into the Tracing panel
}

// -- Settings persistence: survive reloads, keep tuned values ----------

const SETTINGS_KEY = "rastertrace-settings";

function snapshotSettings() {
  return {
    profile: els.exportProfile.value,
    preset: els.preset.value,
    colors: Number(els.colors.value),
    speckle: Number(els.speckle.value),
    layerDiff: Number(els.layerDiff.value),
    cornerThreshold: Number(els.cornerThreshold.value),
    straighten: Number(els.straighten.value),
    hierarchical: els.hierarchical.value,
    upscale: els.upscale.value === "auto" || els.upscale.value === "ultra"
      ? els.upscale.value
      : Number(els.upscale.value),
    mode: document.querySelector('input[name="mode"]:checked').value,
    grayscale: els.grayscale.checked,
    denoise: els.denoise.checked,
    crisp: els.crisp.checked,
    stencil: els.stencil.checked,
    stencilThreshold: Number(els.stencilThreshold.value),
    transparent: els.transparent.value,
    knockoutColor: els.knockoutColor.value,
    fuzz: Number(els.fuzz.value),
    edgeTrim: Number(els.edgeTrim.value),
    defringe: Number(els.defringe.value),
    pathPrecision: Number(els.pathPrecision.value),
    lengthThreshold: Number(els.lengthThreshold.value),
    spliceThreshold: Number(els.spliceThreshold.value),
    exportSize: els.exportSize.value,
    physicalWidth: Number(els.physicalWidth.value),
    physicalUnit: els.physicalUnit.value,
    minify: els.minify.checked,
  };
}

let saveTimer = 0;

function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshotSettings()));
    } catch {
      // storage full or blocked (private mode): persistence is optional
    }
  }, 250);
}

function restoreSettings() {
  let saved;
  try {
    saved = sanitizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY)));
  } catch {
    return;
  }
  const defaults = JSON.stringify(snapshotSettings());
  const set = (el, key) => {
    if (saved[key] !== undefined) el.value = String(saved[key]);
  };
  const check = (el, key) => {
    if (saved[key] !== undefined) el.checked = saved[key];
  };
  set(els.exportProfile, "profile");
  set(els.preset, "preset");
  set(els.colors, "colors");
  set(els.speckle, "speckle");
  set(els.layerDiff, "layerDiff");
  set(els.cornerThreshold, "cornerThreshold");
  set(els.straighten, "straighten");
  set(els.hierarchical, "hierarchical");
  set(els.upscale, "upscale");
  if (saved.mode) {
    document.querySelector(`input[name="mode"][value="${saved.mode}"]`).checked = true;
  }
  check(els.grayscale, "grayscale");
  check(els.denoise, "denoise");
  check(els.crisp, "crisp");
  check(els.stencil, "stencil");
  set(els.stencilThreshold, "stencilThreshold");
  set(els.transparent, "transparent");
  set(els.knockoutColor, "knockoutColor");
  set(els.fuzz, "fuzz");
  set(els.edgeTrim, "edgeTrim");
  set(els.defringe, "defringe");
  set(els.pathPrecision, "pathPrecision");
  set(els.lengthThreshold, "lengthThreshold");
  set(els.spliceThreshold, "spliceThreshold");
  set(els.exportSize, "exportSize");
  set(els.physicalWidth, "physicalWidth");
  set(els.physicalUnit, "physicalUnit");
  check(els.minify, "minify");
  updateTransparencyFields();
  updateExportFields();
  updateStencilFields();
  updateOutputs();
  // Tell the user their previous session's settings are in effect, so a
  // surprising result (e.g. an old stencil threshold) is explainable.
  els.restoredNote.hidden = JSON.stringify(snapshotSettings()) === defaults;
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  els.colors.value = preset.colors;
  els.speckle.value = preset.speckle;
  els.layerDiff.value = preset.layerDiff;
  updateOutputs();
}

function updateTransparencyFields() {
  const mode = els.transparent.value;
  els.knockoutColorField.hidden = mode !== "custom";
  els.fuzzField.hidden = mode === "";
  els.edgeTrimField.hidden = mode === "";
  els.defringeField.hidden = mode === "";
  els.backgroundSummary.textContent = els.transparent.selectedOptions[0]?.textContent || "Keep background";
}

function updateExportFields() {
  els.physicalSizeField.hidden = els.exportSize.value !== "physical";
}

function resetSettings() {
  els.exportProfile.value = "";
  els.preset.value = "";
  els.colors.value = String(DEFAULTS.colors);
  els.speckle.value = String(DEFAULTS.speckle);
  els.layerDiff.value = String(DEFAULTS.layerDiff);
  els.cornerThreshold.value = String(DEFAULTS.cornerThreshold);
  els.straighten.value = String(DEFAULTS.straighten);
  els.hierarchical.value = DEFAULTS.hierarchical;
  els.upscale.value = String(DEFAULTS.upscale);
  document.querySelector(`input[name="mode"][value="${DEFAULTS.mode}"]`).checked = true;
  els.grayscale.checked = DEFAULTS.grayscale;
  els.denoise.checked = DEFAULTS.denoise;
  els.crisp.checked = DEFAULTS.crisp;
  els.transparent.value = DEFAULTS.transparent;
  els.knockoutColor.value = "#ffffff";
  els.fuzz.value = String(DEFAULTS.fuzz);
  els.edgeTrim.value = String(DEFAULTS.edgeTrim);
  els.defringe.value = String(DEFAULTS.defringe);
  els.stencil.checked = false;
  els.stencilThreshold.value = "128";
  els.pathPrecision.value = "3";
  els.lengthThreshold.value = "4";
  els.spliceThreshold.value = "45";
  els.exportSize.value = "px";
  els.physicalWidth.value = "100";
  els.physicalUnit.value = "mm";
  els.minify.checked = false;
  setEyedropper(false);
  updateTransparencyFields();
  updateExportFields();
  updateStencilFields();
  updateOutputs();
}

let elapsedTimer = 0;

function setBusy(busy, label = "Starting…") {
  els.tracingVeil.hidden = !busy;
  clearInterval(elapsedTimer);
  if (busy) {
    els.status.textContent = label;
    els.veilStage.textContent = label;
    els.veilElapsed.textContent = "";
    const started = Date.now();
    elapsedTimer = setInterval(() => {
      els.veilElapsed.textContent = `${Math.round((Date.now() - started) / 1000)}s`;
    }, 1000);
  }
}

tracer.onProgress = (label) => {
  els.veilStage.textContent = label;
  els.status.textContent = label;
};

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
}

function setResultActions(enabled) {
  els.copySvg.disabled = !enabled;
  els.downloadPng.disabled = !enabled;
  els.downloadPdf.disabled = !enabled;
  els.downloadDxf.disabled = !enabled;
  els.download.disabled = !enabled;
  for (const button of document.querySelectorAll('.menu-popover [data-result-action], [data-action="save-svg"]')) {
    button.disabled = !enabled;
  }
  els.eraserTool.disabled = !enabled;
  els.eraserSize.disabled = !enabled;
  els.marqueeRect.disabled = !enabled;
  els.marqueeEllipse.disabled = !enabled;
  els.polygonLasso.disabled = !enabled;
  const erased = enabled && state.eraseStrokes.length > 0;
  els.eraserUndo.disabled = !erased;
  els.eraserRedo.disabled = !enabled || !state.eraseRedo.length;
  els.eraserClear.disabled = !erased;
  if (erased) {
    els.downloadPdf.disabled = true;
    els.downloadDxf.disabled = true;
    els.downloadPdf.title = "Clear eraser strokes before exporting PDF";
    els.downloadDxf.title = "Clear eraser strokes before exporting DXF";
  } else {
    els.downloadPdf.title = "Save a vector PDF at the selected physical size, choosing its name and location";
    els.downloadDxf.title = "Save DXF geometry for CAD or fabrication, choosing its name and location";
  }
  for (const button of document.querySelectorAll('[data-action="download-pdf"], [data-action="download-dxf"]')) {
    button.disabled = !enabled || erased;
  }
}

/** Export post-processing options from the SVG export controls. */
function exportOptions() {
  const opts = {};
  // Minified drops the accessibility title too; otherwise the file name
  // becomes the <title> so standalone SVGs have an accessible name.
  if (els.minify.checked) opts.minify = true;
  else opts.title = state.fileName.replace(/\.[^.]+$/, "");
  if (els.exportSize.value === "physical") {
    const width = Number(els.physicalWidth.value);
    if (width > 0) {
      opts.physicalWidth = width;
      opts.physicalUnit = els.physicalUnit.value;
    }
  }
  return opts;
}

function updatePhysicalHeightOut() {
  const width = Number(els.physicalWidth.value);
  if (els.exportSize.value !== "physical" || !state.sourceWidth || !(width > 0)) {
    els.physicalHeightOut.textContent = "";
    return;
  }
  const height = Number((width * (state.sourceHeight / state.sourceWidth)).toFixed(2));
  els.physicalHeightOut.textContent = `× ${height} ${els.physicalUnit.value}`;
}

/**
 * Re-apply export post-processing (physical size, title, minify) to the
 * last trace and refresh preview, stats, and download. Pure string work:
 * export option changes never re-trace.
 */
function refreshExport() {
  if (!state.svgRaw) return { paths: 0 };
  state.svg = applyEraserMask(applyExportOptions(state.svgRaw, exportOptions()), state.eraseStrokes);

  // Rendered via <img> + blob URL: sandboxes the generated markup and
  // avoids inflating the DOM with thousands of inline path nodes.
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
  const blob = new Blob([state.svg], { type: "image/svg+xml" });
  state.downloadUrl = URL.createObjectURL(blob);
  els.resultView.src = state.downloadUrl;

  const paths = countPaths(state.svg);
  const kb = blob.size / 1024;
  els.statPaths.textContent = paths.toLocaleString();
  els.statSize.textContent = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`;
  setResultActions(true);
  updatePhysicalHeightOut();
  return { paths };
}

async function retrace() {
  if (!state.bitmap) return;
  setBusy(true);
  showError("");
  try {
    const settings = currentSettings();
    // "auto"/"ultra" trace at the full budget for their ceiling: upscale
    // to the cap regardless of source size (never below 1x).
    const maxSide = settings.upscale === "ultra" ? MAX_TRACE_SIDE_ULTRA : MAX_TRACE_SIDE;
    const upscale = settings.upscale === "auto" || settings.upscale === "ultra"
      ? Math.max(1, maxSide / Math.max(state.bitmap.width, state.bitmap.height))
      : settings.upscale;
    const scale = fitTraceScale(state.bitmap.width, state.bitmap.height, upscale, maxSide);
    // Nearest-neighbor pairs with pixel-exact tracing only; crisp mode is
    // corner sharpness, not resampling (NN jaggies anti-aliased sources).
    const nearest = settings.mode === "none";
    if (!state.raster || state.raster.scale !== scale || state.raster.nearest !== nearest) {
      state.raster = { scale, nearest, imageData: rasterize(state.bitmap, scale, nearest) };
    }
    const result = await tracer.trace(state.raster.imageData, settings, state.sourceWidth, state.sourceHeight);
    if (!result) return; // superseded by a newer request
    state.svgRaw = result.svg;
    const { paths } = refreshExport();
    els.statTime.textContent = `${result.ms.toLocaleString()} ms`;

    let statusText = result.knockedOut
      ? `Traced ${paths.toLocaleString()} paths. Removed background rgb(${result.knockedOut.join(", ")}).`
      : `Traced ${paths.toLocaleString()} paths.`;
    // Show the detection note once; later retraces reflect whatever the
    // user has changed since, so a persistent note could contradict them.
    if (state.flatNote) {
      statusText = `${state.flatNote} ${statusText}`;
      state.flatNote = null;
    }
    // Report whenever the trace ran below the requested size, whether the
    // bitmap was capped at load or the upscale was clamped.
    const { width, height } = state.raster.imageData;
    const requestedSide = upscale * Math.max(state.sourceWidth, state.sourceHeight);
    if (Math.max(width, height) < requestedSide) {
      statusText += ` Image resized to ${width}×${height} px for tracing.`;
    }
    if (paths > 1000) {
      statusText += " High path count: consider the Web profile or fewer colors.";
    }
    els.status.textContent = statusText;
    setBusy(false);
  } catch (err) {
    setBusy(false);
    setResultActions(false);
    els.status.textContent = "";
    showError(err.message || "Conversion failed.");
  }
}

function scheduleRetrace() {
  clearTimeout(state.debounce);
  state.debounce = setTimeout(retrace, 350);
}

/**
 * Load-time content detection. Flat-color sources get visible smart
 * defaults: colors snapped to the detected count, cleanup levels from the
 * nearest preset at or above it. Controls move in the open and stay fully
 * user-editable.
 */
function applyDetectedSettings(bitmap) {
  const { flat, colorCount } = analyzeFlatness(rasterize(bitmap, 1, false));
  if (!flat) {
    // Photo-like source: tracing suits flat art. One-time hint, controls
    // untouched (posterized photo traces are a legitimate use).
    state.flatNote =
      "Photographic image: tracing works best on flat art. Try the Print profile or fewer colors; for engraving photos, a raster PNG usually works better.";
    return;
  }
  const presetKey = Object.keys(PRESETS)
    .map(Number)
    .sort((a, b) => a - b)
    .find((k) => k >= colorCount);
  const preset = PRESETS[presetKey];
  els.colors.value = colorCount;
  els.speckle.value = preset.speckle;
  els.layerDiff.value = preset.layerDiff;
  els.preset.value = "";
  updateOutputs();
  state.flatNote = `Detected flat image (~${colorCount} colors), color settings applied.`;
}

async function loadFile(file) {
  if (!file) return;
  showError("");
  const token = ++state.loadToken;
  clearTimeout(state.debounce);
  tracer.cancelPending();
  state.bitmap?.close();
  state.bitmap = null;
  state.file = null;
  state.svgRaw = null;
  state.svg = null;
  state.raster = null;
  state.eraseStrokes = [];
  state.eraseRedo = [];
  state.flatNote = null;
  clearSelection();
  setSelectionTool(null);
  setEraser(false);
  setResultActions(false);
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
  if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
  state.downloadUrl = null;
  state.sourceUrl = null;
  els.resultView.src = EMPTY_IMAGE_SRC;
  els.sourceView.src = EMPTY_IMAGE_SRC;
  els.statPaths.textContent = "-";
  els.statSize.textContent = "-";
  els.statTime.textContent = "-";
  els.emptyState.hidden = true;
  els.workspace.hidden = false;
  setBusy(true, "Loading image…");
  try {
    const decoded = await decodeImage(file);
    const sourceWidth = decoded.width;
    const sourceHeight = decoded.height;
    // Shrink oversized bitmaps right away: only the capped copy is
    // retained, so a huge photo does not hold its full decode in memory.
    const bitmap = await capBitmap(decoded);
    if (token !== state.loadToken) {
      bitmap.close(); // a newer load started while this one decoded
      return;
    }
    // Settings survive image replacement (batch workflows tune once,
    // convert many); flat-image detection below still adjusts colors.
    state.bitmap = bitmap;
    state.file = file;
    state.rotation = 0;
    state.inverted = false;
    els.invertImage.setAttribute("aria-pressed", "false");
    state.decodedSide = MAX_TRACE_SIDE;
    state.sourceWidth = sourceWidth;
    state.sourceHeight = sourceHeight;
    state.raster = null;
    state.eraseStrokes = [];
    state.eraseRedo = [];
    clearSelection();
    setSelectionTool(null);
    setEraser(false);
    applyDetectedSettings(bitmap);
    state.fileName = file.name || "image";
    if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
    state.sourceUrl = URL.createObjectURL(file);
    els.sourceView.src = state.sourceUrl;
    els.emptyState.hidden = true;
    els.workspace.hidden = false;
    resetView();
    setView("result");
    if (els.upscale.value === "ultra") await ensureUltraBitmap();
    await retrace();
    els.preview.focus({ preventScroll: false });
  } catch (err) {
    if (token === state.loadToken) {
      setBusy(false);
      els.status.textContent = "";
      showError(err.message || "Could not open that file.");
    }
  }
}

function setView(view) {
  const showResult = view === "result";
  if (!showResult) {
    if (state.erasing) setEraser(false);
    clearSelection();
    setSelectionTool(null);
  }
  els.showResult.setAttribute("aria-pressed", String(showResult));
  els.showSource.setAttribute("aria-pressed", String(!showResult));
  els.resultView.hidden = !showResult;
  els.sourceView.hidden = showResult;
}

// -- Events ------------------------------------------------------------

els.pickFile.addEventListener("click", () => els.fileInput.click());
els.replaceImage.addEventListener("click", () => els.fileInput.click());

for (const button of document.querySelectorAll('[data-action="open-image"]')) {
  button.addEventListener("click", () => els.fileInput.click());
}
for (const button of document.querySelectorAll('[data-action="save-svg"]')) {
  button.addEventListener("click", () => {
    if (!els.download.disabled) els.download.click();
  });
}
for (const button of document.querySelectorAll('[data-action="reset-settings"]')) {
  button.addEventListener("click", () => els.resetSettingsBtn.click());
}

const menuActionTargets = {
  "copy-svg": els.copySvg,
  "download-png": els.downloadPng,
  "download-pdf": els.downloadPdf,
  "download-dxf": els.downloadDxf,
  "show-result": els.showResult,
  "show-source": els.showSource,
  "zoom-fit": els.zoomReset,
  "zoom-in": els.zoomIn,
  "zoom-out": els.zoomOut,
};
for (const [action, target] of Object.entries(menuActionTargets)) {
  document.querySelector(`[data-action="${action}"]`).addEventListener("click", () => target.click());
}

for (const panel of document.querySelectorAll("details.panel[data-panel-key]")) {
  const storageKey = `rastertrace:panel:${panel.dataset.panelKey}`;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) panel.open = stored === "true";
  } catch {
    // Disclosure state remains available for this session when storage is unavailable.
  }
  panel.addEventListener("toggle", () => {
    try {
      localStorage.setItem(storageKey, String(panel.open));
    } catch {
      // Opening and closing panels does not depend on persistence.
    }
  });
}

document.querySelector('[data-action="about"]').addEventListener("click", () => {
  $("about-dialog").showModal();
});
for (const guide of ["tracing", "cleanup", "export"]) {
  document.querySelector(`[data-action="${guide}-guide"]`).addEventListener("click", () => {
    $(`${guide}-guide-dialog`).showModal();
  });
}
document.querySelector('[data-action="preferences"]').addEventListener("click", () => {
  els.preferencesDialog.returnValue = "";
  els.measurementUnitPreference.value = preferences.measurementUnit;
  els.preferencesDialog.showModal();
});
els.preferencesDialog.addEventListener("close", () => {
  if (els.preferencesDialog.returnValue !== "apply") return;
  preferences = { measurementUnit: els.measurementUnitPreference.value };
  applyMeasurementUnit(preferences.measurementUnit);
  savePreferences();
  saveSettings();
  els.status.textContent = "Preferences saved.";
});

const appMenus = [...document.querySelectorAll("details.app-menu")];
const closeMenus = (except) => {
  for (const menu of appMenus) if (menu !== except) menu.open = false;
};
for (const menu of appMenus) {
  menu.addEventListener("toggle", () => { if (menu.open) closeMenus(menu); });
  menu.querySelector("summary").addEventListener("pointerenter", (event) => {
    if (event.pointerType === "mouse" && !menu.open && appMenus.some((other) => other.open)) menu.open = true;
  });
}
document.addEventListener("pointerdown", (event) => {
  if (!(event.target instanceof Element) || !event.target.closest(".app-menu")) closeMenus();
}, { capture: true });
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest(".menu-popover button, .menu-popover a")) closeMenus();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    const activeMenu = appMenus.find((menu) => menu.open && menu.contains(document.activeElement));
    closeMenus();
    activeMenu?.querySelector("summary")?.focus({ preventScroll: true });
    return;
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  if (event.key.toLowerCase() === "o") {
    event.preventDefault();
    els.fileInput.click();
  }
  if (event.key.toLowerCase() === "e" && !els.download.disabled) {
    event.preventDefault();
    els.download.click();
  }
  if (event.key === "1" && state.bitmap) {
    event.preventDefault();
    actualSizeView();
  }
});

// Rotation replaces the working bitmap, so the source view is re-rendered
// from it: eyedropper coordinates and the preview stay consistent.
async function updateSourceView() {
  const canvas = new OffscreenCanvas(state.bitmap.width, state.bitmap.height);
  canvas.getContext("2d").drawImage(state.bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
  state.sourceUrl = URL.createObjectURL(blob);
  els.sourceView.src = state.sourceUrl;
}

async function rotate(clockwise) {
  if (!state.bitmap || els.rotateLeft.disabled) return;
  els.rotateLeft.disabled = true; // rotation closes the bitmap mid-flight
  els.rotateRight.disabled = true;
  els.invertImage.disabled = true;
  try {
    state.bitmap = await rotateBitmap(state.bitmap, clockwise);
    state.rotation = (state.rotation + (clockwise ? 1 : 3)) % 4;
    [state.sourceWidth, state.sourceHeight] = [state.sourceHeight, state.sourceWidth];
    state.raster = null;
    await updateSourceView();
    resetView();
    retrace();
  } catch (err) {
    showError(err.message || "Could not rotate the image.");
  } finally {
    els.rotateLeft.disabled = false;
    els.rotateRight.disabled = false;
    els.invertImage.disabled = false;
  }
}

async function invert() {
  if (!state.bitmap || els.invertImage.disabled) return;
  els.rotateLeft.disabled = true; // inversion closes the bitmap mid-flight
  els.rotateRight.disabled = true;
  els.invertImage.disabled = true;
  try {
    state.bitmap = await invertBitmap(state.bitmap);
    state.inverted = !state.inverted;
    els.invertImage.setAttribute("aria-pressed", String(state.inverted));
    state.raster = null;
    await updateSourceView();
    retrace();
  } catch (err) {
    showError(err.message || "Could not invert the image.");
  } finally {
    els.rotateLeft.disabled = false;
    els.rotateRight.disabled = false;
    els.invertImage.disabled = false;
  }
}

els.rotateLeft.addEventListener("click", () => rotate(false));
els.rotateRight.addEventListener("click", () => rotate(true));
els.invertImage.addEventListener("click", invert);
els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files[0];
  // Clear so picking the same file again still fires a change event
  // (e.g. after editing it externally).
  els.fileInput.value = "";
  loadFile(file);
});

// Body-level handlers cover the dropzone too (events bubble), so a drop
// anywhere on the page works in both empty and workspace states.
document.body.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.dropzone.classList.add("dragover");
});
document.body.addEventListener("dragleave", (e) => {
  // Only when the drag leaves the page; moving over child nodes also
  // fires dragleave and would flicker the highlight.
  if (!e.relatedTarget) els.dropzone.classList.remove("dragover");
});
document.body.addEventListener("drop", (e) => {
  e.preventDefault();
  els.dropzone.classList.remove("dragover");
  loadFile(e.dataTransfer?.files?.[0]);
});

// Ctrl/Cmd+V anywhere loads a clipboard image (screenshot workflows).
document.addEventListener("paste", (e) => {
  const file =
    [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/")) ??
    [...(e.clipboardData?.items ?? [])]
      .find((i) => i.kind === "file" && i.type.startsWith("image/"))
      ?.getAsFile();
  if (!file) return;
  e.preventDefault();
  loadFile(file);
});

els.preset.addEventListener("change", () => {
  clearProfile();
  applyPreset(els.preset.value);
  scheduleRetrace();
});

for (const input of [els.colors, els.speckle, els.layerDiff]) {
  input.addEventListener("input", () => {
    els.preset.value = ""; // manual change leaves the preset
    clearProfile();
    updateOutputs();
    scheduleRetrace();
  });
}

for (const input of [els.fuzz, els.edgeTrim, els.defringe]) {
  input.addEventListener("input", () => {
    updateOutputs();
    scheduleRetrace();
  });
}

els.transparent.addEventListener("change", () => {
  updateTransparencyFields();
  scheduleRetrace();
});

els.knockoutColor.addEventListener("input", scheduleRetrace);

/**
 * The bitmap is decoded at the 2048 cap. Ultra re-decodes the kept file
 * at 4096 so capped sources regain real detail, replaying any rotation.
 * Uncapped sources (small logos) skip this: upscaling covers them.
 */
async function ensureUltraBitmap() {
  if (!state.file || !state.bitmap || state.decodedSide >= MAX_TRACE_SIDE_ULTRA) return;
  if (Math.max(state.sourceWidth, state.sourceHeight) <= Math.max(state.bitmap.width, state.bitmap.height)) {
    state.decodedSide = MAX_TRACE_SIDE_ULTRA;
    return;
  }
  const token = state.loadToken;
  els.status.textContent = "Reloading image at 4096 px…";
  try {
    const decoded = await decodeImage(state.file, MAX_TRACE_SIDE_ULTRA);
    let bitmap = await capBitmap(decoded, MAX_TRACE_SIDE_ULTRA);
    for (let i = 0; i < state.rotation; i++) bitmap = await rotateBitmap(bitmap, true);
    if (state.inverted) bitmap = await invertBitmap(bitmap);
    if (token !== state.loadToken) {
      bitmap.close(); // a new image loaded while re-decoding
      return;
    }
    state.bitmap?.close();
    state.bitmap = bitmap;
    state.raster = null;
    state.decodedSide = MAX_TRACE_SIDE_ULTRA;
    if (state.rotation || state.inverted) await updateSourceView();
  } catch (err) {
    showError(err.message || "Could not reload the image at 4096 px.");
  }
}

els.upscale.addEventListener("change", async () => {
  clearProfile();
  if (els.upscale.value === "ultra") await ensureUltraBitmap();
  scheduleRetrace();
});
els.grayscale.addEventListener("change", scheduleRetrace);
els.denoise.addEventListener("change", scheduleRetrace);
els.stencil.addEventListener("change", () => {
  clearProfile();
  updateStencilFields();
  scheduleRetrace();
});
els.stencilThreshold.addEventListener("input", () => {
  updateOutputs();
  scheduleRetrace();
});
els.hierarchical.addEventListener("change", () => {
  clearProfile();
  scheduleRetrace();
});
els.cornerThreshold.addEventListener("input", () => {
  clearProfile();
  updateOutputs();
  scheduleRetrace();
});
els.straighten.addEventListener("input", () => {
  clearProfile();
  updateOutputs();
  scheduleRetrace();
});
for (const input of [els.pathPrecision, els.lengthThreshold, els.spliceThreshold]) {
  input.addEventListener("input", () => {
    clearProfile();
    updateOutputs();
    scheduleRetrace();
  });
}

els.exportProfile.addEventListener("change", async () => {
  const name = els.exportProfile.value;
  if (!name) return;
  applyExportProfile(name);
  if (els.upscale.value === "ultra") await ensureUltraBitmap();
  refreshExport(); // minify may have changed; applies without waiting
  scheduleRetrace();
});

// Export options are post-processing only: no re-trace, instant apply.
els.exportSize.addEventListener("change", () => {
  updateExportFields();
  refreshExport();
});
for (const input of [els.physicalWidth, els.physicalUnit]) {
  input.addEventListener("input", refreshExport);
}
els.physicalUnit.addEventListener("change", () => {
  preferences = { measurementUnit: els.physicalUnit.value };
  savePreferences();
});
els.minify.addEventListener("change", refreshExport);
// Crisp nudges corner rounding in the open (like presets); the slider
// stays fully user-editable afterwards.
els.crisp.addEventListener("change", () => {
  els.cornerThreshold.value = els.crisp.checked ? "30" : "60";
  updateOutputs();
  scheduleRetrace();
});

// -- Eyedropper: arm, click the source image to sample, Esc cancels ----

function setEyedropper(armed) {
  state.picking = armed;
  els.pickFromImage.setAttribute("aria-pressed", String(armed));
  els.preview.classList.toggle("picking", armed);
  if (armed) {
    setView("source");
    els.status.textContent = "Click the image to sample the background color. Esc cancels.";
  } else {
    els.status.textContent = "";
  }
}

els.pickFromImage.addEventListener("click", () => setEyedropper(!state.picking));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.picking) setEyedropper(false);
});

document.addEventListener("keydown", (event) => {
  const editing = /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName) || event.target.isContentEditable;
  if (editing) return;
  const key = event.key.toLowerCase();
  if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "e" && state.svg) {
    event.preventDefault();
    setEraser(!state.erasing);
  } else if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "m" && state.svg) {
    event.preventDefault();
    const tool = event.shiftKey
      ? (state.selectionTool === "rect" ? "ellipse" : state.selectionTool === "ellipse" ? "rect" : "ellipse")
      : "rect";
    clearSelection();
    setSelectionTool(tool);
  } else if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "l" && state.svg) {
    event.preventDefault();
    clearSelection();
    setSelectionTool("polygon");
  } else if (event.key === "Enter" && state.selection?.type === "polygon") {
    event.preventDefault();
    finishPolygon();
  } else if (event.key === "Escape" && state.erasing) {
    setEraser(false);
  } else if (event.key === "Escape" && state.selection?.type === "polygon" && !state.selection.finalized) {
    event.preventDefault();
    state.selection.points.pop();
    state.selection.hover = null;
    if (!state.selection.points.length) clearSelection();
    else renderSelection();
    els.status.textContent = state.selection
      ? "Last polygon point removed. Click to continue drawing."
      : "Polygon cleared. Click to start a new selection.";
  } else if (event.key === "Escape" && (state.selection || state.selectionTool)) {
    clearSelection();
    setSelectionTool(null);
  } else if ((event.key === "Delete" || event.key === "Backspace") && state.selection?.finalized) {
    event.preventDefault();
    deleteSelection();
  } else if (event.key === "[" || event.key === "]") {
    if (!state.erasing) return;
    event.preventDefault();
    const factor = event.key === "]" ? 1.2 : 1 / 1.2;
    setEraserSize(Number(els.eraserSize.value) * factor);
  } else if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z")) && state.eraseRedo.length) {
    event.preventDefault();
    els.eraserRedo.click();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && state.eraseStrokes.length) {
    event.preventDefault();
    els.eraserUndo.click();
  }
});

els.sourceView.addEventListener("click", (e) => {
  if (!state.picking || !state.bitmap) return;
  const rect = els.sourceView.getBoundingClientRect();
  const x = Math.min(
    state.bitmap.width - 1,
    Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * state.bitmap.width)),
  );
  const y = Math.min(
    state.bitmap.height - 1,
    Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * state.bitmap.height)),
  );
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(state.bitmap, x, y, 1, 1, 0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  els.knockoutColor.value = toHexColor([r, g, b]).toLowerCase();
  setEyedropper(false);
  setView("result");
  scheduleRetrace();
});
for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener("change", () => {
    clearProfile();
    scheduleRetrace();
  });
}

els.showResult.addEventListener("click", () => setView("result"));
els.showSource.addEventListener("click", () => setView("source"));
els.greenScreen.addEventListener("click", () => {
  const enabled = els.greenScreen.getAttribute("aria-pressed") !== "true";
  els.greenScreen.setAttribute("aria-pressed", String(enabled));
  els.preview.classList.toggle("checkerboard", !enabled);
  els.preview.classList.toggle("green-screen", enabled);
});

// -- Marquee and polygonal lasso selections ---------------------------

function clearSelection() {
  state.selection = null;
  els.selectionOverlay.setAttribute("hidden", "");
}

function setSelectionTool(tool) {
  state.selectionTool = tool;
  if (tool) {
    state.erasing = false;
    els.eraserTool.setAttribute("aria-pressed", "false");
    els.preview.classList.remove("erasing");
    els.eraserCursor.hidden = true;
    setView("result");
  }
  els.marqueeRect.setAttribute("aria-pressed", String(tool === "rect"));
  els.marqueeEllipse.setAttribute("aria-pressed", String(tool === "ellipse"));
  els.polygonLasso.setAttribute("aria-pressed", String(tool === "polygon"));
  els.preview.classList.toggle("selecting", Boolean(tool));
  if (tool === "polygon") {
    els.status.textContent = "Click around an area. Hold Shift for 45° segments; double-click or press Enter to close.";
  } else if (tool) {
    els.status.textContent = "Drag anywhere in the preview. Hold Shift for a square or circle; Alt/Option draws from the center.";
  }
}

function marqueeGeometry(selection) {
  const box = svgViewBox(state.svgRaw || "");
  let dx = selection.current.x - selection.start.x;
  let dy = selection.current.y - selection.start.y;
  if (selection.constrain && box) {
    const side = Math.max(Math.abs(dx * box.width), Math.abs(dy * box.height));
    dx = Math.sign(dx || 1) * side / box.width;
    dy = Math.sign(dy || 1) * side / box.height;
  }
  const x2 = selection.start.x + dx;
  const y2 = selection.start.y + dy;
  if (selection.fromCenter) {
    return {
      x: selection.start.x - Math.abs(dx),
      y: selection.start.y - Math.abs(dy),
      width: Math.abs(dx) * 2,
      height: Math.abs(dy) * 2,
    };
  }
  return {
    x: Math.min(selection.start.x, x2),
    y: Math.min(selection.start.y, y2),
    width: Math.abs(dx),
    height: Math.abs(dy),
  };
}

function renderSelection() {
  const selection = state.selection;
  if (!selection) {
    els.selectionOverlay.setAttribute("hidden", "");
    return;
  }
  const imageRect = els.resultView.getBoundingClientRect();
  const previewRect = els.preview.getBoundingClientRect();
  els.selectionOverlay.style.left = `${imageRect.left - previewRect.left}px`;
  els.selectionOverlay.style.top = `${imageRect.top - previewRect.top}px`;
  els.selectionOverlay.style.width = `${imageRect.width}px`;
  els.selectionOverlay.style.height = `${imageRect.height}px`;
  els.selectionOverlay.style.overflow = selection.finalized ? "hidden" : "visible";
  els.selectionOverlay.setAttribute("viewBox", `0 0 ${imageRect.width} ${imageRect.height}`);
  const px = (point) => ({ x: point.x * imageRect.width, y: point.y * imageRect.height });
  let shape;
  if (selection.type === "polygon") {
    shape = document.createElementNS("http://www.w3.org/2000/svg", selection.finalized ? "polygon" : "polyline");
    const points = selection.hover && !selection.finalized
      ? [...selection.points, selection.hover]
      : selection.points;
    shape.setAttribute("points", points.map((point) => {
      const screenPoint = px(point);
      return `${screenPoint.x},${screenPoint.y}`;
    }).join(" "));
  } else {
    const geometry = marqueeGeometry(selection);
    if (selection.type === "ellipse") {
      shape = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
      shape.setAttribute("cx", String((geometry.x + geometry.width / 2) * imageRect.width));
      shape.setAttribute("cy", String((geometry.y + geometry.height / 2) * imageRect.height));
      shape.setAttribute("rx", String(geometry.width * imageRect.width / 2));
      shape.setAttribute("ry", String(geometry.height * imageRect.height / 2));
    } else {
      shape = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      shape.setAttribute("x", String(geometry.x * imageRect.width));
      shape.setAttribute("y", String(geometry.y * imageRect.height));
      shape.setAttribute("width", String(geometry.width * imageRect.width));
      shape.setAttribute("height", String(geometry.height * imageRect.height));
    }
  }
  const darkAnts = shape.cloneNode();
  darkAnts.setAttribute("class", "selection-ants-dark");
  darkAnts.setAttribute("vector-effect", "non-scaling-stroke");
  shape.setAttribute("class", "selection-ants-light");
  shape.setAttribute("vector-effect", "non-scaling-stroke");
  const selectionNodes = [darkAnts, shape];
  if (selection.finalized) {
    const ns = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(ns, "defs");
    const clipPath = document.createElementNS(ns, "clipPath");
    clipPath.id = "selection-image-edge-clip";
    clipPath.setAttribute("clipPathUnits", "userSpaceOnUse");
    const clipShape = shape.cloneNode();
    clipShape.removeAttribute("class");
    clipShape.setAttribute("fill", "#fff");
    clipShape.setAttribute("stroke", "none");
    clipPath.appendChild(clipShape);
    defs.appendChild(clipPath);

    const edge = document.createElementNS(ns, "rect");
    edge.setAttribute("x", "0.75");
    edge.setAttribute("y", "0.75");
    edge.setAttribute("width", String(Math.max(0, imageRect.width - 1.5)));
    edge.setAttribute("height", String(Math.max(0, imageRect.height - 1.5)));
    edge.setAttribute("fill", "none");
    edge.setAttribute("clip-path", "url(#selection-image-edge-clip)");
    edge.setAttribute("vector-effect", "non-scaling-stroke");
    const darkEdge = edge.cloneNode();
    darkEdge.setAttribute("class", "selection-ants-dark");
    edge.setAttribute("class", "selection-ants-light");
    selectionNodes.unshift(defs);
    selectionNodes.push(darkEdge, edge);
  }
  els.selectionOverlay.replaceChildren(...selectionNodes);
  els.selectionOverlay.removeAttribute("hidden");
}

function finishPolygon() {
  if (state.selection?.type !== "polygon" || state.selection.points.length < 3) return;
  if (!selectionIntersectsImage(state.selection)) {
    clearSelection();
    els.status.textContent = "Selection did not overlap the image.";
    return;
  }
  state.selection.finalized = true;
  state.selection.hover = null;
  renderSelection();
  els.status.textContent = "Selection ready. Press Delete or Backspace to remove it.";
}

function deleteSelection() {
  const selection = state.selection;
  if (!selection?.finalized) return;
  state.eraseRedo = [];
  if (selection.type === "polygon") {
    state.eraseStrokes.push({ type: "polygon", points: selection.points });
  } else {
    const geometry = marqueeGeometry(selection);
    if (selection.type === "ellipse") {
      state.eraseStrokes.push({
        type: "ellipse",
        cx: geometry.x + geometry.width / 2,
        cy: geometry.y + geometry.height / 2,
        rx: geometry.width / 2,
        ry: geometry.height / 2,
      });
    } else {
      state.eraseStrokes.push({ type: "rect", ...geometry });
    }
  }
  clearSelection();
  refreshExport();
  els.status.textContent = "Selected area removed. Ctrl/Cmd+Z restores it.";
}

els.marqueeRect.addEventListener("click", () => { clearSelection(); setSelectionTool("rect"); });
els.marqueeEllipse.addEventListener("click", () => { clearSelection(); setSelectionTool("ellipse"); });
els.polygonLasso.addEventListener("click", () => { clearSelection(); setSelectionTool("polygon"); });

let selectionPointer = null;

function selectionPoint(event, mode = "strict") {
  const rect = els.resultView.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  if (mode === "strict" && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  if (mode === "free") return { x, y };
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

function selectionIntersectsImage(selection) {
  let bounds;
  if (selection.type === "polygon") {
    const xs = selection.points.map((point) => point.x);
    const ys = selection.points.map((point) => point.y);
    bounds = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  } else {
    bounds = marqueeGeometry(selection);
  }
  return bounds.x < 1 && bounds.y < 1 && bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0;
}

function constrainedPolygonPoint(point, shiftKey) {
  const selection = state.selection;
  if (!shiftKey || selection?.type !== "polygon" || !selection.points.length) return point;
  const box = svgViewBox(state.svgRaw || "");
  if (!box) return point;
  return snapPointToAngle(selection.points.at(-1), point, box.width, box.height);
}

els.preview.addEventListener("pointerdown", (event) => {
  if (!state.selectionTool || event.button !== 0) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const point = selectionPoint(event, "free");
  // An active selection tool owns the whole preview, including the empty
  // canvas around the image, so selection gestures never pan the artwork.
  if (!point) return;
  if (state.selectionTool === "polygon") {
    if (event.detail > 1) {
      finishPolygon();
      return;
    }
    if (!state.selection || state.selection.finalized) {
      state.selection = { type: "polygon", points: [], hover: null, finalized: false };
    }
    state.selection.points.push(constrainedPolygonPoint({ x: point.x, y: point.y }, event.shiftKey));
    renderSelection();
    return;
  }
  state.selection = {
    type: state.selectionTool,
    start: { x: point.x, y: point.y },
    current: { x: point.x, y: point.y },
    constrain: event.shiftKey,
    fromCenter: event.altKey,
    finalized: false,
  };
  selectionPointer = event.pointerId;
  els.preview.setPointerCapture(event.pointerId);
  renderSelection();
}, true);

els.preview.addEventListener("dblclick", (event) => {
  if (state.selectionTool !== "polygon") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  finishPolygon();
}, true);

els.preview.addEventListener("pointermove", (event) => {
  if (state.selectionTool === "polygon" && state.selection?.type === "polygon" && !state.selection.finalized) {
    const point = selectionPoint(event, "free");
    state.selection.hover = constrainedPolygonPoint(point, event.shiftKey);
    renderSelection();
  }
  if (selectionPointer !== event.pointerId || !state.selection) return;
  const point = selectionPoint(event, "free");
  if (!point) return;
  state.selection.current = { x: point.x, y: point.y };
  state.selection.constrain = event.shiftKey;
  state.selection.fromCenter = event.altKey;
  renderSelection();
}, true);

for (const type of ["pointerup", "pointercancel"]) {
  els.preview.addEventListener(type, (event) => {
    if (selectionPointer !== event.pointerId) return;
    selectionPointer = null;
    if (!state.selection) return;
    const geometry = marqueeGeometry(state.selection);
    if (geometry.width < 0.001 || geometry.height < 0.001 || !selectionIntersectsImage(state.selection)) {
      clearSelection();
      return;
    }
    state.selection.finalized = true;
    renderSelection();
    els.status.textContent = "Selection ready. Press Delete or Backspace to remove it.";
  }, true);
}

// -- Vector eraser: normalized freehand strokes become an SVG mask -----

function setEraser(active) {
  state.erasing = active && Boolean(state.svg);
  if (state.erasing) {
    clearSelection();
    setSelectionTool(null);
  }
  els.eraserTool.setAttribute("aria-pressed", String(state.erasing));
  els.preview.classList.toggle("erasing", state.erasing);
  els.eraserCursor.hidden = true;
  if (state.erasing) {
    setView("result");
    els.status.textContent = "Drag over the vector to erase. [ and ] change the diameter. E or Esc exits.";
  }
}

function setEraserSize(value) {
  const size = Math.min(Number(els.eraserSize.max), Math.max(Number(els.eraserSize.min), Math.round(value)));
  els.eraserSize.value = String(size);
  els.eraserSizeOut.textContent = `${size} px`;
}

els.eraserTool.addEventListener("click", () => setEraser(!state.erasing));
els.eraserSize.addEventListener("input", () => setEraserSize(Number(els.eraserSize.value)));
els.eraserUndo.addEventListener("click", () => {
  const action = state.eraseStrokes.pop();
  if (!action) return;
  state.eraseRedo.push(action);
  refreshExport();
  els.status.textContent = "Cleanup action undone.";
});
els.eraserRedo.addEventListener("click", () => {
  const action = state.eraseRedo.pop();
  if (!action) return;
  state.eraseStrokes.push(action);
  refreshExport();
  els.status.textContent = "Cleanup action restored.";
});
els.eraserClear.addEventListener("click", () => {
  state.eraseStrokes = [];
  state.eraseRedo = [];
  clearSelection();
  refreshExport();
  els.status.textContent = "Original traced result restored.";
});

function eraserPoint(event) {
  const rect = els.resultView.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  return { x, y, rect };
}

function moveEraserCursor(event) {
  if (!state.erasing) return;
  const point = eraserPoint(event);
  els.eraserCursor.hidden = !point;
  if (!point) return;
  const previewRect = els.preview.getBoundingClientRect();
  const box = svgViewBox(state.svgRaw || "");
  const screenSize = box ? Number(els.eraserSize.value) * point.rect.width / box.width : Number(els.eraserSize.value);
  els.eraserCursor.style.width = `${screenSize}px`;
  els.eraserCursor.style.height = `${screenSize}px`;
  els.eraserCursor.style.left = `${event.clientX - previewRect.left}px`;
  els.eraserCursor.style.top = `${event.clientY - previewRect.top}px`;
}

let erasePointer = null;
let eraseFrame = 0;

function redrawErasure() {
  if (eraseFrame) return;
  eraseFrame = requestAnimationFrame(() => {
    eraseFrame = 0;
    refreshExport();
  });
}

els.preview.addEventListener("pointerleave", () => { els.eraserCursor.hidden = true; });
els.preview.addEventListener("pointermove", (event) => {
  moveEraserCursor(event);
  if (erasePointer !== event.pointerId) return;
  const point = eraserPoint(event);
  if (!point) return;
  const stroke = state.eraseStrokes.at(-1);
  const previous = stroke.points.at(-1);
  if (Math.hypot(point.x - previous.x, point.y - previous.y) < 0.001) return;
  stroke.points.push({ x: point.x, y: point.y });
  redrawErasure();
});

els.preview.addEventListener("pointerdown", (event) => {
  if (!state.erasing || event.button !== 0) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const point = eraserPoint(event);
  if (!point) return;
  const box = svgViewBox(state.svgRaw || "");
  if (!box) return;
  state.eraseRedo = [];
  state.eraseStrokes.push({
    diameter: Number(els.eraserSize.value) / Math.min(box.width, box.height),
    points: [{ x: point.x, y: point.y }],
  });
  erasePointer = event.pointerId;
  els.preview.setPointerCapture(event.pointerId);
  redrawErasure();
}, true);

for (const type of ["pointerup", "pointercancel"]) {
  els.preview.addEventListener(type, (event) => {
    if (erasePointer !== event.pointerId) return;
    erasePointer = null;
    refreshExport();
  }, true);
}

// -- Zoom & pan: wheel zooms at the cursor, drag pans, buttons step ----

const view = { scale: 1, tx: 0, ty: 0 };
const ZOOM_MIN = 0.001;
const ZOOM_MAX = 128;

function visiblePreviewImage() {
  return els.sourceView.hidden ? els.resultView : els.sourceView;
}

function actualZoomPercent() {
  const image = visiblePreviewImage();
  const displayWidth = image.getBoundingClientRect().width;
  if (!state.sourceWidth || !displayWidth) return Math.round(view.scale * 100);
  return Math.round((displayWidth / state.sourceWidth) * 100);
}

function applyView() {
  els.panStage.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
  els.zoomReset.textContent = view.scale === 1 && view.tx === 0 && view.ty === 0
    ? "Fit"
    : `${actualZoomPercent()}%`;
  renderSelection();
}

function resetView() {
  view.scale = 1;
  view.tx = 0;
  view.ty = 0;
  applyView();
}

/** Zoom by factor, keeping the point (px, py) in preview coordinates fixed. */
function zoomAt(factor, px, py) {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.scale * factor));
  const f = next / view.scale;
  view.tx = px - (px - view.tx) * f;
  view.ty = py - (py - view.ty) * f;
  view.scale = next;
  applyView();
}

function zoomAtCenter(factor) {
  zoomAt(factor, els.preview.clientWidth / 2, els.preview.clientHeight / 2);
}

function actualSizeView() {
  const image = visiblePreviewImage();
  if (!state.sourceWidth) return;
  resetView();
  const fittedWidth = image.getBoundingClientRect().width;
  if (!fittedWidth) return;
  zoomAtCenter(state.sourceWidth / fittedWidth);
}

els.zoomIn.addEventListener("click", () => zoomAtCenter(1.5));
els.zoomOut.addEventListener("click", () => zoomAtCenter(1 / 1.5));
els.zoomReset.addEventListener("click", resetView);
document.querySelector('[data-action="zoom-actual"]').addEventListener("click", actualSizeView);

els.preview.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = els.preview.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top);
  },
  { passive: false },
);

for (const type of ["touchstart", "touchmove"]) {
  els.preview.addEventListener(
    type,
    (e) => {
      if (e.touches.length > 1) e.preventDefault();
    },
    { passive: false },
  );
}

els.preview.addEventListener("keydown", (e) => {
  if (e.key === "+" || e.key === "=") zoomAtCenter(1.5);
  else if (e.key === "-" || e.key === "_") zoomAtCenter(1 / 1.5);
  else if (e.key === "0") resetView();
  else return;
  e.preventDefault();
});

// One pointer pans; two pointers pinch-zoom around their midpoint (and
// pan with it, so the standard touch pinch-drag combo works). `gesture`
// holds the previous frame: { x, y } while panning, { dist, midX, midY }
// while pinching; deltas are applied incrementally.
const pointers = new Map();
let gesture = null;

function pinchState() {
  const [a, b] = [...pointers.values()];
  return {
    dist: Math.hypot(b.x - a.x, b.y - a.y),
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
  };
}

els.preview.addEventListener("pointerdown", (e) => {
  if (state.picking || state.erasing || e.button !== 0) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    gesture = { x: e.clientX, y: e.clientY };
    els.preview.classList.add("panning");
  } else if (pointers.size === 2) {
    gesture = pinchState();
  }
  try {
    els.preview.setPointerCapture(e.pointerId);
  } catch {
    // synthetic events have no active pointer; drag still works unbounded
  }
});

els.preview.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    view.tx += e.clientX - gesture.x;
    view.ty += e.clientY - gesture.y;
    gesture = { x: e.clientX, y: e.clientY };
    applyView();
  } else if (pointers.size === 2) {
    const now = pinchState();
    const rect = els.preview.getBoundingClientRect();
    if (gesture.dist > 0) {
      zoomAt(now.dist / gesture.dist, now.midX - rect.left, now.midY - rect.top);
    }
    view.tx += now.midX - gesture.midX;
    view.ty += now.midY - gesture.midY;
    applyView();
    gesture = now;
  }
});

for (const type of ["pointerup", "pointercancel"]) {
  els.preview.addEventListener(type, (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 2) {
      // Back down to two fingers (from 3+): restart the pinch from the
      // current positions, or the stale snapshot would cause a jump.
      gesture = pinchState();
    } else if (pointers.size === 1) {
      // Pinch ended with one finger still down: continue as a pan.
      const [p] = pointers.values();
      gesture = { x: p.x, y: p.y };
    } else if (pointers.size === 0) {
      gesture = null;
      els.preview.classList.remove("panning");
    }
  });
}

els.preview.addEventListener("dragstart", (e) => e.preventDefault());

els.copySvg.addEventListener("click", async () => {
  if (!state.svg) return;
  try {
    await navigator.clipboard.writeText(state.svg);
    els.status.textContent = "SVG copied to clipboard.";
  } catch {
    els.status.textContent = "Clipboard unavailable. Use Save As instead.";
  }
});

function exportFileName(extension) {
  return `${state.fileName.replace(/\.[^.]+$/, "")}.${extension}`;
}

function downloadBlob(blob, extension) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFileName(extension);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function chooseSaveFile(extension, mimeType) {
  if (!("showSaveFilePicker" in window)) return null;
  try {
    return await window.showSaveFilePicker({
      suggestedName: exportFileName(extension),
      types: [{
        description: `${extension.toUpperCase()} file`,
        accept: { [mimeType]: [`.${extension}`] },
      }],
    });
  } catch (err) {
    if (err?.name === "AbortError") return undefined;
    throw err;
  }
}

async function saveBlob(blob, extension, fileHandle) {
  if (fileHandle === undefined) return { cancelled: true };
  if (!fileHandle) {
    downloadBlob(blob, extension);
    return { downloaded: true };
  }
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return { name: fileHandle.name };
}

function saveStatus(format, result, detail = "") {
  if (result.downloaded) return `${format} export sent to your browser downloads${detail}.`;
  return `${format} saved as ${result.name}${detail}.`;
}

els.download.addEventListener("click", async () => {
  if (!state.svg || els.download.disabled) return;
  try {
    const fileHandle = await chooseSaveFile("svg", "image/svg+xml");
    const result = await saveBlob(new Blob([state.svg], { type: "image/svg+xml" }), "svg", fileHandle);
    if (!result.cancelled) els.status.textContent = saveStatus("SVG", result);
  } catch (err) {
    showError(err.message || "SVG export failed.");
  }
});

// PNG render at the trace resolution (viewBox), not the display size:
// engraving and upload tools that reject SVG get the full detail.
els.downloadPng.addEventListener("click", async () => {
  if (!state.svg || els.downloadPng.disabled) return;
  try {
    const fileHandle = await chooseSaveFile("png", "image/png");
    if (fileHandle === undefined) return;
    els.downloadPng.disabled = true;
    const img = new Image();
    img.src = state.downloadUrl;
    await img.decode();
    const m = state.svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    const width = m ? Number(m[1]) : img.naturalWidth;
    const height = m ? Number(m[2]) : img.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(img, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const result = await saveBlob(blob, "png", fileHandle);
    els.status.textContent = saveStatus("PNG", result, ` at ${width}×${height} px`);
  } catch (err) {
    showError(err.message || "PNG export failed.");
  } finally {
    els.downloadPng.disabled = false;
  }
});

/** Physical export width in the given output unit, or null when off. */
function physicalWidthIn(unitsPerMm, unitsPerInch) {
  if (els.exportSize.value !== "physical") return null;
  const width = Number(els.physicalWidth.value);
  if (!(width > 0)) return null;
  const unit = els.physicalUnit.value;
  if (unit === "px") return null;
  if (unit === "in") return width * unitsPerInch;
  return width * unitsPerMm * (unit === "cm" ? 10 : 1);
}

els.downloadPdf.addEventListener("click", async () => {
  if (!state.svgRaw || els.downloadPdf.disabled) return;
  try {
    const parsed = parseSvgPaths(state.svgRaw);
    // Page size in points: the physical size when set, else source
    // pixels at 96 dpi (72/96 pt per px).
    const widthPt = physicalWidthIn(72 / 25.4, 72) ?? state.sourceWidth * 0.75;
    const heightPt = widthPt * (state.sourceHeight / state.sourceWidth);
    const pdf = toPdf(parsed, { pageWidth: widthPt, pageHeight: heightPt });
    const fileHandle = await chooseSaveFile("pdf", "application/pdf");
    const result = await saveBlob(new Blob([pdf], { type: "application/pdf" }), "pdf", fileHandle);
    if (!result.cancelled) {
      els.status.textContent = saveStatus("PDF", result, ` at ${formatDimensionsFromInches(widthPt / 72, heightPt / 72)}`);
    }
  } catch (err) {
    showError(err.message || "PDF export failed.");
  }
});

els.downloadDxf.addEventListener("click", async () => {
  if (!state.svgRaw || els.downloadDxf.disabled) return;
  try {
    const parsed = parseSvgPaths(state.svgRaw);
    // DXF units: mm when a physical size is set, else source pixels.
    const widthUnits = physicalWidthIn(1, 25.4) ?? state.sourceWidth;
    const dxf = toDxf(parsed, { scale: widthUnits / parsed.width });
    const fileHandle = await chooseSaveFile("dxf", "image/vnd.dxf");
    const result = await saveBlob(new Blob([dxf], { type: "image/vnd.dxf" }), "dxf", fileHandle);
    if (!result.cancelled) {
      const detail = els.exportSize.value === "physical"
        ? ` at ${widthUnits.toFixed(1)} mm wide`
        : ` at ${widthUnits} units (source pixels)`;
      els.status.textContent = saveStatus("DXF", result, detail);
    }
  } catch (err) {
    showError(err.message || "DXF export failed.");
  }
});

els.resetSettingsBtn.addEventListener("click", () => {
  resetSettings();
  els.restoredNote.hidden = true;
  saveSettings();
  scheduleRetrace();
  els.status.textContent = "Settings reset to defaults.";
});

// Persist on any control interaction; one delegated listener covers
// every current and future input in the column.
{
  for (const controlsRoot of document.querySelectorAll(".controls")) {
    controlsRoot.addEventListener("input", saveSettings);
    controlsRoot.addEventListener("change", saveSettings);
  }
}

restoreSettings();
preferences = readPreferences(els.physicalUnit.value);
applyMeasurementUnit(preferences.measurementUnit);
saveSettings();

// Offline support: static app, versioned assets. Registration failure
// (http, old browser) is harmless.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// Footer version: package.json is the single version source and is served
// alongside the app. Silent on failure so the footer never breaks.
fetch("package.json")
  .then((r) => r.json())
  .then(({ version }) => {
    if (version) {
      $("app-version").textContent = `v${version}`;
      $("about-version").textContent = version;
    }
  })
  .catch(() => {});
