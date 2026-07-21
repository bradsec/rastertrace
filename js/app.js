// App core: the trace loop, image loading and transforms, menu and
// control wiring, and startup. Shared state lives in context.js; tools,
// settings, export, and zoom/pan live in their own modules.
import { capBitmap, decodeImage, invertBitmap, rasterize, rotateBitmap, Tracer } from "./pipeline.js?v=42";
import {
  analyzeFlatness,
  fitTraceScale,
  isStaleModuleError,
  MAX_TRACE_SIDE,
  MAX_TRACE_SIDE_ULTRA,
  PRESETS,
} from "./preprocess.js?v=42";
import { $, els, hooks, preferences, showError, state } from "./context.js?v=2";
import { refreshExport, setResultActions } from "./exporters.js?v=3";
import { clearSelection, setEraser, setSelectionTool, setView } from "./cleanup-tools.js?v=3";
import {
  applyExportProfile,
  applyMeasurementUnit,
  applyPreset,
  clearProfile,
  currentSettings,
  readPreferences,
  resetSettings,
  restoreSettings,
  savePreferences,
  saveSettings,
  updateExportFields,
  updateOutputs,
  updateStencilFields,
  updateTransparencyFields,
} from "./settings.js?v=3";
import { actualSizeView, resetView } from "./view.js?v=3";

const EMPTY_IMAGE_SRC = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

const tracer = new Tracer(new URL("./worker.js?v=42", import.meta.url));

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
    if (await recoverFromStaleCache(err.message)) return;
    setResultActions(false);
    els.status.textContent = "";
    showError(err.message || "Conversion failed.");
  }
}

function scheduleRetrace() {
  clearTimeout(state.debounce);
  state.debounce = setTimeout(retrace, 350);
}

hooks.scheduleRetrace = scheduleRetrace;

/**
 * A worker that cannot even load its modules means the service worker
 * cached mismatched copies: a deploy caught mid-propagation can pin an
 * old file body under a new ?v= URL, and cache-first then serves it
 * forever. Purge every cache and service worker, then reload once
 * (sessionStorage guards against a reload loop) to refetch clean files.
 */
async function recoverFromStaleCache(message) {
  if (!isStaleModuleError(message)) return false;
  const marker = "rastertrace-cache-recovered";
  try {
    if (sessionStorage.getItem(marker)) return false;
    sessionStorage.setItem(marker, "1");
  } catch {
    return false; // no sessionStorage: cannot guard the reload loop
  }
  try {
    for (const key of await caches.keys()) await caches.delete(key);
    const registrations = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(registrations.map((registration) => registration.unregister()));
  } catch {
    // caches API unavailable: the reload alone may still fetch fresh copies
  }
  location.reload();
  return true;
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
  preferences.measurementUnit = els.measurementUnitPreference.value;
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
for (const radio of document.querySelectorAll('input[name="stencil-ink"]')) {
  radio.addEventListener("change", () => {
    clearProfile();
    scheduleRetrace();
  });
}
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
  preferences.measurementUnit = els.physicalUnit.value;
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
Object.assign(preferences, readPreferences(els.physicalUnit.value));
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

// Signals the index.html boot guard that the module graph loaded and
// initialization ran; without it the guard purges caches and reloads.
window.__rastertraceBooted = true;
