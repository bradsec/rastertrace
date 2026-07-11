// UI wiring: state, controls, preview, download.
import { capBitmap, decodeImage, rasterize, rotateBitmap, Tracer } from "./pipeline.js?v=26";
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
} from "./preprocess.js?v=26";

const $ = (id) => document.getElementById(id);

const els = {
  emptyState: $("empty-state"),
  workspace: $("workspace"),
  dropzone: $("dropzone"),
  pickFile: $("pick-file"),
  fileInput: $("file-input"),
  replaceImage: $("replace-image"),
  rotateLeft: $("rotate-left"),
  rotateRight: $("rotate-right"),
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
  hierarchical: $("hierarchical"),
  upscale: $("upscale"),
  pathPrecision: $("path-precision"),
  pathPrecisionOut: $("path-precision-out"),
  lengthThreshold: $("length-threshold"),
  lengthThresholdOut: $("length-threshold-out"),
  spliceThreshold: $("splice-threshold"),
  spliceThresholdOut: $("splice-threshold-out"),
  stencil: $("stencil"),
  grayscale: $("grayscale"),
  crisp: $("crisp"),
  transparent: $("transparent"),
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
  download: $("download"),
  resetSettingsBtn: $("reset-settings"),
  panStage: $("pan-stage"),
  zoomIn: $("zoom-in"),
  zoomOut: $("zoom-out"),
  zoomReset: $("zoom-reset"),
};

const state = {
  bitmap: null, // capped at decodedSide; source dims kept separately
  file: null, // original file, kept for the Ultra re-decode
  rotation: 0, // quarter turns applied since load, for re-decode replay
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
};

const tracer = new Tracer(new URL("./worker.js?v=26", import.meta.url));

function currentSettings() {
  return {
    colors: Number(els.colors.value),
    speckle: Number(els.speckle.value),
    layerDiff: Number(els.layerDiff.value),
    cornerThreshold: Number(els.cornerThreshold.value),
    hierarchical: els.hierarchical.value,
    upscale: els.upscale.value === "auto" || els.upscale.value === "ultra"
      ? els.upscale.value
      : Number(els.upscale.value),
    mode: document.querySelector('input[name="mode"]:checked').value,
    grayscale: els.grayscale.checked,
    denoise: els.denoise.checked,
    crisp: els.crisp.checked,
    stencil: els.stencil.checked,
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
  els.fuzzOut.textContent = els.fuzz.value;
  els.edgeTrimOut.textContent = els.edgeTrim.value;
  els.defringeOut.textContent = els.defringe.value;
  els.pathPrecisionOut.textContent = els.pathPrecision.value;
  els.lengthThresholdOut.textContent = els.lengthThreshold.value;
  els.spliceThresholdOut.textContent = els.spliceThreshold.value;
}

/**
 * Apply a purpose-based export profile: moves the visible controls (like
 * presets do) and sets the export post-processing toggles. Everything
 * stays user-editable afterwards.
 */
function applyExportProfile(name) {
  const profile = EXPORT_PROFILES[name];
  if (!profile) return;
  els.colors.value = String(profile.colors);
  els.speckle.value = String(profile.speckle);
  els.layerDiff.value = String(profile.layerDiff);
  els.cornerThreshold.value = String(profile.cornerThreshold);
  document.querySelector(`input[name="mode"][value="${profile.mode}"]`).checked = true;
  els.hierarchical.value = profile.hierarchical;
  els.upscale.value = String(profile.upscale);
  els.stencil.checked = profile.stencil;
  els.pathPrecision.value = String(profile.pathPrecision);
  if (profile.spliceThreshold) els.spliceThreshold.value = String(profile.spliceThreshold);
  els.minify.checked = profile.minify;
  els.preset.value = "";
  updateOutputs();
}

function clearProfile() {
  els.exportProfile.value = "";
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
    hierarchical: els.hierarchical.value,
    upscale: els.upscale.value === "auto" || els.upscale.value === "ultra"
      ? els.upscale.value
      : Number(els.upscale.value),
    mode: document.querySelector('input[name="mode"]:checked').value,
    grayscale: els.grayscale.checked,
    denoise: els.denoise.checked,
    crisp: els.crisp.checked,
    stencil: els.stencil.checked,
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
  set(els.hierarchical, "hierarchical");
  set(els.upscale, "upscale");
  if (saved.mode) {
    document.querySelector(`input[name="mode"][value="${saved.mode}"]`).checked = true;
  }
  check(els.grayscale, "grayscale");
  check(els.denoise, "denoise");
  check(els.crisp, "crisp");
  check(els.stencil, "stencil");
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
  updateOutputs();
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
  updateOutputs();
}

let elapsedTimer = 0;

function setBusy(busy) {
  els.tracingVeil.hidden = !busy;
  clearInterval(elapsedTimer);
  if (busy) {
    els.status.textContent = "Tracing…";
    els.veilStage.textContent = "Starting…";
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
  els.download.setAttribute("aria-disabled", String(!enabled));
  if (!enabled) els.download.removeAttribute("href");
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
  state.svg = applyExportOptions(state.svgRaw, exportOptions());

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
  els.download.href = state.downloadUrl;
  els.download.download = `${state.fileName.replace(/\.[^.]+$/, "")}.svg`;
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
    state.bitmap?.close();
    state.bitmap = bitmap;
    state.file = file;
    state.rotation = 0;
    state.decodedSide = MAX_TRACE_SIDE;
    state.sourceWidth = sourceWidth;
    state.sourceHeight = sourceHeight;
    state.raster = null;
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
    if (token === state.loadToken) showError(err.message || "Could not open that file.");
  }
}

function setView(view) {
  const showResult = view === "result";
  els.showResult.setAttribute("aria-pressed", String(showResult));
  els.showSource.setAttribute("aria-pressed", String(!showResult));
  els.resultView.hidden = !showResult;
  els.sourceView.hidden = showResult;
}

// -- Events ------------------------------------------------------------

els.pickFile.addEventListener("click", () => els.fileInput.click());
els.replaceImage.addEventListener("click", () => els.fileInput.click());

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
  }
}

els.rotateLeft.addEventListener("click", () => rotate(false));
els.rotateRight.addEventListener("click", () => rotate(true));
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
    if (token !== state.loadToken) {
      bitmap.close(); // a new image loaded while re-decoding
      return;
    }
    state.bitmap?.close();
    state.bitmap = bitmap;
    state.raster = null;
    state.decodedSide = MAX_TRACE_SIDE_ULTRA;
    if (state.rotation) await updateSourceView();
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

// -- Zoom & pan: wheel zooms at the cursor, drag pans, buttons step ----

const view = { scale: 1, tx: 0, ty: 0 };
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 32;

function applyView() {
  els.panStage.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
  els.zoomReset.textContent = view.scale === 1 && view.tx === 0 && view.ty === 0
    ? "Fit"
    : `${Math.round(view.scale * 100)}%`;
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

els.zoomIn.addEventListener("click", () => zoomAtCenter(1.5));
els.zoomOut.addEventListener("click", () => zoomAtCenter(1 / 1.5));
els.zoomReset.addEventListener("click", resetView);

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
  if (state.picking || e.button !== 0) return;
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
    els.status.textContent = "Clipboard unavailable. Use Download instead.";
  }
});

// PNG render at the trace resolution (viewBox), not the display size:
// engraving and upload tools that reject SVG get the full detail.
els.downloadPng.addEventListener("click", async () => {
  if (!state.svg || els.downloadPng.disabled) return;
  els.downloadPng.disabled = true;
  try {
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
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.fileName.replace(/\.[^.]+$/, "")}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    els.status.textContent = `PNG exported at ${width}×${height} px.`;
  } catch (err) {
    showError(err.message || "PNG export failed.");
  } finally {
    els.downloadPng.disabled = false;
  }
});

els.resetSettingsBtn.addEventListener("click", () => {
  resetSettings();
  saveSettings();
  scheduleRetrace();
  els.status.textContent = "Settings reset to defaults.";
});

// Persist on any control interaction; one delegated listener covers
// every current and future input in the column.
{
  const controlsRoot = document.querySelector(".controls");
  controlsRoot.addEventListener("input", saveSettings);
  controlsRoot.addEventListener("change", saveSettings);
}

restoreSettings();

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
    if (version) $("app-version").textContent = `v${version}`;
  })
  .catch(() => {});
