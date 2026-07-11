// UI wiring: state, controls, preview, download.
import { capBitmap, decodeImage, rasterize, rotateBitmap, Tracer } from "./pipeline.js?v=18";
import {
  analyzeFlatness,
  countPaths,
  fitTraceScale,
  parseHexColor,
  PRESETS,
  toHexColor,
} from "./preprocess.js?v=18";

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
  preset: $("preset"),
  colors: $("colors"),
  colorsOut: $("colors-out"),
  speckle: $("speckle"),
  speckleOut: $("speckle-out"),
  layerDiff: $("layer-diff"),
  layerDiffOut: $("layer-diff-out"),
  upscale: $("upscale"),
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
  showResult: $("show-result"),
  showSource: $("show-source"),
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
  download: $("download"),
  panStage: $("pan-stage"),
  zoomIn: $("zoom-in"),
  zoomOut: $("zoom-out"),
  zoomReset: $("zoom-reset"),
};

const state = {
  bitmap: null, // capped at MAX_TRACE_SIDE; source dims kept separately
  sourceWidth: 0,
  sourceHeight: 0,
  fileName: "image",
  sourceUrl: null,
  svg: null,
  downloadUrl: null,
  debounce: 0,
  raster: null, // { scale, imageData } cache, keyed by current bitmap
  picking: false,
  loadToken: 0, // guards against overlapping loads (drop while decoding)
  flatNote: null, // status prefix when load-time detection fired
};

const tracer = new Tracer(new URL("./worker.js?v=18", import.meta.url));

function currentSettings() {
  return {
    colors: Number(els.colors.value),
    speckle: Number(els.speckle.value),
    layerDiff: Number(els.layerDiff.value),
    upscale: Number(els.upscale.value),
    mode: document.querySelector('input[name="mode"]:checked').value,
    grayscale: els.grayscale.checked,
    denoise: els.denoise.checked,
    crisp: els.crisp.checked,
    transparent:
      els.transparent.value === "auto" || els.transparent.value === "edges"
        ? els.transparent.value
        : els.transparent.value === "custom"
          ? parseHexColor(els.knockoutColor.value)
          : null,
    fuzz: Number(els.fuzz.value),
    edgeTrim: Number(els.edgeTrim.value),
  };
}

function updateOutputs() {
  const colors = Number(els.colors.value);
  els.colorsOut.textContent = colors >= 256 ? "All" : String(colors);
  els.speckleOut.textContent = els.speckle.value;
  els.layerDiffOut.textContent = els.layerDiff.value;
  els.fuzzOut.textContent = els.fuzz.value;
  els.edgeTrimOut.textContent = els.edgeTrim.value;
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  els.colors.value = preset.colors;
  els.speckle.value = preset.speckle;
  els.layerDiff.value = preset.layerDiff;
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
  els.download.setAttribute("aria-disabled", String(!enabled));
  if (!enabled) els.download.removeAttribute("href");
}

async function retrace() {
  if (!state.bitmap) return;
  setBusy(true);
  showError("");
  try {
    const settings = currentSettings();
    const scale = fitTraceScale(state.bitmap.width, state.bitmap.height, settings.upscale);
    if (!state.raster || state.raster.scale !== scale || state.raster.crisp !== settings.crisp) {
      state.raster = { scale, crisp: settings.crisp, imageData: rasterize(state.bitmap, scale, settings.crisp) };
    }
    const result = await tracer.trace(state.raster.imageData, settings, state.sourceWidth, state.sourceHeight);
    if (!result) return; // superseded by a newer request
    state.svg = result.svg;

    // Rendered via <img> + blob URL: sandboxes the generated markup and
    // avoids inflating the DOM with thousands of inline path nodes.
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml" }));
    els.resultView.src = state.downloadUrl;

    const paths = countPaths(result.svg);
    const kb = new Blob([result.svg]).size / 1024;
    els.statPaths.textContent = paths.toLocaleString();
    els.statSize.textContent = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`;
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
    const requestedSide = settings.upscale * Math.max(state.sourceWidth, state.sourceHeight);
    if (Math.max(width, height) < requestedSide) {
      statusText += ` Image resized to ${width}×${height} px for tracing.`;
    }
    els.status.textContent = statusText;

    els.download.href = state.downloadUrl;
    els.download.download = `${state.fileName.replace(/\.[^.]+$/, "")}.svg`;
    setResultActions(true);
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
 * nearest preset at or above it, and crisp resampling on. Controls move
 * in the open and stay fully user-editable; non-flat images reset crisp
 * so a previous image's detection never leaks onto a photo.
 */
function applyDetectedSettings(bitmap) {
  const { flat, colorCount } = analyzeFlatness(rasterize(bitmap, 1, false));
  els.crisp.checked = flat;
  if (!flat) {
    state.flatNote = null;
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
  state.flatNote = `Detected flat image (~${colorCount} colors), crisp settings applied.`;
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
    state.bitmap?.close();
    state.bitmap = bitmap;
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

els.preset.addEventListener("change", () => {
  applyPreset(els.preset.value);
  scheduleRetrace();
});

for (const input of [els.colors, els.speckle, els.layerDiff]) {
  input.addEventListener("input", () => {
    els.preset.value = ""; // manual change leaves the preset
    updateOutputs();
    scheduleRetrace();
  });
}

for (const input of [els.fuzz, els.edgeTrim]) {
  input.addEventListener("input", () => {
    updateOutputs();
    scheduleRetrace();
  });
}

els.transparent.addEventListener("change", () => {
  const mode = els.transparent.value;
  els.knockoutColorField.hidden = mode !== "custom";
  els.fuzzField.hidden = mode === "";
  els.edgeTrimField.hidden = mode === "";
  scheduleRetrace();
});

els.knockoutColor.addEventListener("input", scheduleRetrace);
els.upscale.addEventListener("change", scheduleRetrace);
els.grayscale.addEventListener("change", scheduleRetrace);
els.denoise.addEventListener("change", scheduleRetrace);
els.crisp.addEventListener("change", scheduleRetrace);

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
  radio.addEventListener("change", scheduleRetrace);
}

els.showResult.addEventListener("click", () => setView("result"));
els.showSource.addEventListener("click", () => setView("source"));

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

els.copySvg.addEventListener("click", async () => {
  if (!state.svg) return;
  try {
    await navigator.clipboard.writeText(state.svg);
    els.status.textContent = "SVG copied to clipboard.";
  } catch {
    els.status.textContent = "Clipboard unavailable. Use Download instead.";
  }
});

updateOutputs();

// Footer version: package.json is the single version source and is served
// alongside the app. Silent on failure so the footer never breaks.
fetch("package.json")
  .then((r) => r.json())
  .then(({ version }) => {
    if (version) $("app-version").textContent = `v${version}`;
  })
  .catch(() => {});
