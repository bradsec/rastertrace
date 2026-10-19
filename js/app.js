// App core: the trace loop, image loading and transforms, menu and
// control wiring, and startup. Shared state lives in context.js; tools,
// settings, export, and zoom/pan live in their own modules.
import {
  bitmapOperationIsCurrent,
  capBitmap,
  decodeImage,
  invertBitmap,
  rasterize,
  rotateBitmap,
  sniffImageSize,
  Tracer,
} from "./pipeline.js?v=58";
import {
  analyzeFlatness,
  detectedColorSettings,
  fitTraceScale,
  isStaleModuleError,
  MAX_TRACE_SIDE,
  MAX_TRACE_SIDE_ULTRA,
  parseAse,
  parseHexColor,
  parseSwatchText,
  presetName,
  PRESETS_MAX,
  sanitizePresets,
  SWATCHES_MAX,
  toHexColor,
  USER_PRESET_PREFIX,
  userPresetName,
} from "./preprocess.js?v=58";
import { $, els, hooks, preferences, showError, state } from "./context.js?v=28";
import { refreshExport, setResultActions } from "./exporters.js?v=36";
import {
  clearSelection,
  setBlobFill,
  setEraser,
  setSelectionTool,
  setView,
} from "./cleanup-tools.js?v=44";
import { afterTrace, resetPalette } from "./palette-ui.js?v=28";
import {
  applyExportProfile,
  applyMeasurementUnit,
  applyPreset,
  applySimplify,
  applyUserPreset,
  clearProfile,
  currentSettings,
  currentSwatches,
  deleteUserPreset,
  findUserPreset,
  flushSettings,
  importUserPresets,
  loadUserPresets,
  readPreferences,
  resetSettings,
  restoreSettings,
  savePreferences,
  saveSettings,
  saveUserPreset,
  setSwatches,
  updateColorSourceFields,
  updateExportFields,
  updateOutputs,
  updatePanelSummaries,
  updateStencilFields,
  updateTraceFields,
  updateTransparencyFields,
  userPresets,
} from "./settings.js?v=44";
import { actualSizeView, resetView } from "./view.js?v=44";

const EMPTY_IMAGE_SRC = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

const tracer = new Tracer(new URL("./worker.js?v=62", import.meta.url));

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

function setBitmapActionsEnabled(enabled) {
  els.rotateLeft.disabled = !enabled;
  els.rotateRight.disabled = !enabled;
  els.invertImage.disabled = !enabled;
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
    const upscale =
      settings.upscale === "auto" || settings.upscale === "ultra"
        ? Math.max(1, maxSide / Math.max(state.bitmap.width, state.bitmap.height))
        : Number(settings.upscale);
    const scale = fitTraceScale(state.bitmap.width, state.bitmap.height, upscale, maxSide);
    // Nearest-neighbor pairs with pixel-exact tracing only: it would
    // leave jaggies on anti-aliased sources.
    const nearest = settings.mode === "none";
    if (!state.raster || state.raster.scale !== scale || state.raster.nearest !== nearest) {
      state.raster = { scale, nearest, imageData: rasterize(state.bitmap, scale, nearest) };
    }
    const result = await tracer.trace(
      state.raster.imageData,
      settings,
      state.sourceWidth,
      state.sourceHeight,
    );
    if (!result) return; // superseded by a newer request
    state.processedRaster = result.processed ?? null;
    state.svgRaw = result.svg;
    state.svgMosaic = settings.hierarchical === "cutout";
    const paletteNote = afterTrace();
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
    if (paletteNote) statusText = `${statusText} ${paletteNote}`;
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
 * forever. Purge RasterTrace caches and its service worker, then reload once
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
    for (const key of await caches.keys()) {
      if (key.startsWith("rastertrace-")) await caches.delete(key);
    }
    const registration = await navigator.serviceWorker?.getRegistration?.(
      new URL("./", document.baseURI),
    );
    const expectedScript = new URL("sw.js", document.baseURI).href;
    if (registration?.active?.scriptURL === expectedScript) await registration.unregister();
  } catch {
    // caches API unavailable: the reload alone may still fetch fresh copies
  }
  location.reload();
  return true;
}

/**
 * Load-time content detection. With "Auto-detect colors" on, colors,
 * speckle and layer difference come from this image (detectedColorSettings);
 * with it off, every setting carries over from the previous image
 * unchanged. Manual color, preset or profile changes turn it off.
 */
function applyDetectedSettings(bitmap) {
  // Keep the 1x pixels for the trace that follows. Any source at or above
  // the trace cap scales to exactly 1, so this usually saves a full second
  // canvas draw and readback per load; retrace re-rasterizes on a miss.
  const imageData = rasterize(bitmap, 1, false);
  state.raster = { scale: 1, nearest: false, imageData };
  const analysis = analyzeFlatness(imageData);
  if (!analysis.flat) {
    // Tracing suits flat art. One-time hint.
    state.flatNote =
      "Photographic image: tracing works best on flat art. Try the Print profile or fewer colors; for engraving photos, a raster PNG usually works better.";
  }
  if (!els.autoDetect.checked) return;
  const detected = detectedColorSettings(analysis);
  els.colors.value = String(detected.colors);
  els.speckle.value = String(detected.speckle);
  els.layerDiff.value = String(detected.layerDiff);
  els.preset.value = "";
  clearProfile();
  updateOutputs();
  saveSettings();
  if (analysis.flat) {
    state.flatNote = `Detected flat image (~${analysis.colorCount} colors), color settings applied.`;
  }
}

async function loadFile(file) {
  if (!file) return;
  // Cleanup strokes and palette edits belong to the current image only.
  if (
    state.bitmap &&
    (state.eraseStrokes.length || state.colorEdits.size) &&
    !window.confirm("Open a new image? Your cleanup and color edits will be lost.")
  ) {
    return;
  }
  showError("");
  const token = ++state.loadToken;
  const wasEmpty = !state.bitmap;
  if (wasEmpty) {
    els.emptyState.hidden = true;
    els.workspace.hidden = false;
  }
  setBusy(true, "Loading image…");
  try {
    const sourceSize = await sniffImageSize(file);
    const decoded = await decodeImage(file, MAX_TRACE_SIDE, sourceSize);
    const sourceWidth = sourceSize?.width ?? decoded.width;
    const sourceHeight = sourceSize?.height ?? decoded.height;
    // Shrink oversized bitmaps right away: only the capped copy is
    // retained, so a huge photo does not hold its full decode in memory.
    const bitmap = await capBitmap(decoded);
    if (token !== state.loadToken) {
      bitmap.close(); // a newer load started while this one decoded
      return;
    }
    // Reset only once the new file has decoded, so a file that fails to
    // open leaves the current trace and its edits untouched.
    resetForNewImage();
    // Settings survive image replacement (batch workflows tune once,
    // convert many); flat-image detection below still adjusts colors.
    state.bitmap = bitmap;
    state.file = file;
    state.rotation = 0;
    // invert() flipped the knockout color to follow the inverted pixels;
    // the new image is not inverted, so flip it back.
    if (state.inverted) {
      const knockout = parseHexColor(els.knockoutColor.value);
      if (knockout) {
        els.knockoutColor.value = toHexColor(
          /** @type {[number, number, number]} */ (knockout.map((channel) => 255 - channel)),
        );
      }
    }
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
    setBlobFill(false);
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
    if (token === state.loadToken) setBitmapActionsEnabled(true);
    els.preview.focus({ preventScroll: false });
  } catch (err) {
    if (token === state.loadToken) {
      setBusy(false);
      els.status.textContent = "";
      if (wasEmpty && !state.bitmap) {
        els.workspace.hidden = true;
        els.emptyState.hidden = false;
      }
      showError(err.message || "Could not open that file.");
    }
  }
}

function resetForNewImage() {
  clearTimeout(state.debounce);
  tracer.cancelPending();
  state.bitmap?.close();
  state.bitmap = null;
  setBitmapActionsEnabled(false);
  state.file = null;
  state.svgRaw = null;
  state.svg = null;
  state.raster = null;
  state.processedRaster = null;
  state.eraseStrokes = [];
  state.eraseRedo = [];
  state.flatNote = null;
  resetPalette();
  clearSelection();
  setSelectionTool(null);
  setEraser(false);
  setBlobFill(false);
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
}

// -- Events ------------------------------------------------------------

els.pickFile.addEventListener("click", () => els.fileInput.click());
document.getElementById("try-sample").addEventListener("click", async () => {
  try {
    const response = await fetch("assets/samples/sample-landscape.png");
    if (!response.ok) throw new Error("Sample image request failed.");
    const blob = await response.blob();
    const file = new File([blob], "sample-landscape.png", { type: "image/png" });
    await loadFile(file);
  } catch {
    showError("Could not load the sample image.");
  }
});
els.errorDismiss.addEventListener("click", () => showError(""));
// The whole drop zone opens the picker: phones cannot drop files.
els.dropzone.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("button, input")) return;
  els.fileInput.click();
});

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
  document
    .querySelector(`[data-action="${action}"]`)
    .addEventListener("click", () => target.click());
}

const phoneSheet = window.matchMedia("(max-width: 680px)");
const panels = /** @type {NodeListOf<HTMLDetailsElement>} */ (
  document.querySelectorAll("details.panel[data-panel-key]")
);
for (const panel of panels) {
  const storageKey = `rastertrace:panel:${panel.dataset.panelKey}`;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) panel.open = stored === "true";
  } catch {
    // Disclosure state remains available for this session when storage is unavailable.
  }
  panel.addEventListener("toggle", () => {
    // Phone tabs open sections themselves; keep the desktop choice.
    if (phoneSheet.matches) return;
    try {
      localStorage.setItem(storageKey, String(panel.open));
    } catch {
      // Opening and closing panels does not depend on persistence.
    }
  });
}

// Dialogs open from menu items that close with the menu, so focus would
// drop to <body> on close. Return it to the menu button instead.
for (const dialog of document.querySelectorAll("dialog")) {
  let opener = null;
  dialog.addEventListener("focusin", (event) => {
    const from = event.relatedTarget;
    if (!opener && from instanceof HTMLElement && !dialog.contains(from)) opener = from;
  });
  dialog.addEventListener("close", () => {
    const menu = opener?.closest("details.app-menu");
    const target = menu?.querySelector("summary") ?? opener;
    opener = null;
    if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
  });
}

document.querySelector('[data-action="about"]').addEventListener("click", () => {
  /** @type {HTMLDialogElement} */ ($("about-dialog")).showModal();
});
for (const guide of ["tracing", "cleanup", "export"]) {
  document.querySelector(`[data-action="${guide}-guide"]`).addEventListener("click", () => {
    /** @type {HTMLDialogElement} */ ($(`${guide}-guide-dialog`)).showModal();
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

const appMenus = [
  .../** @type {NodeListOf<HTMLDetailsElement>} */ (document.querySelectorAll("details.app-menu")),
];
const closeMenus = (except) => {
  for (const menu of appMenus) if (menu !== except) menu.open = false;
};
for (const menu of appMenus) {
  menu.addEventListener("toggle", () => {
    if (menu.open) closeMenus(menu);
  });
  menu.querySelector("summary").addEventListener("pointerenter", (event) => {
    if (event.pointerType === "mouse" && !menu.open && appMenus.some((other) => other.open))
      menu.open = true;
  });
}
document.addEventListener(
  "pointerdown",
  (event) => {
    if (!(event.target instanceof Element) || !event.target.closest(".app-menu")) closeMenus();
  },
  { capture: true },
);
document.addEventListener("click", (event) => {
  if (
    event.target instanceof Element &&
    event.target.closest(".menu-popover button, .menu-popover a")
  )
    closeMenus();
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
  if (event.key === "0" && state.bitmap) {
    event.preventDefault();
    resetView();
  }
  if (event.key === "\\") {
    event.preventDefault();
    toggleBothPanels();
  }
});

// Rotation replaces the working bitmap, so the source view is re-rendered
// from it: eyedropper coordinates and the preview stay consistent.
async function updateSourceView(bitmap, token) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  if (!bitmapOperationIsCurrent(state, token, bitmap)) return false;
  if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
  state.sourceUrl = URL.createObjectURL(blob);
  els.sourceView.src = state.sourceUrl;
  return true;
}

let bitmapRevision = 0;

async function rotate(clockwise) {
  if (!state.bitmap || els.rotateLeft.disabled) return;
  bitmapRevision++;
  const token = state.loadToken;
  const sourceBitmap = state.bitmap;
  setBitmapActionsEnabled(false);
  try {
    const bitmap = await rotateBitmap(sourceBitmap, clockwise);
    if (!bitmapOperationIsCurrent(state, token, sourceBitmap)) {
      bitmap.close();
      return;
    }
    state.bitmap = bitmap;
    state.rotation = (state.rotation + (clockwise ? 1 : 3)) % 4;
    [state.sourceWidth, state.sourceHeight] = [state.sourceHeight, state.sourceWidth];
    state.raster = null;
    if (!(await updateSourceView(bitmap, token))) return;
    resetView();
    retrace();
  } catch (err) {
    if (token === state.loadToken) showError(err.message || "Could not rotate the image.");
  } finally {
    if (token === state.loadToken && state.bitmap) setBitmapActionsEnabled(true);
  }
}

async function invert() {
  if (!state.bitmap || els.invertImage.disabled) return;
  bitmapRevision++;
  const token = state.loadToken;
  const sourceBitmap = state.bitmap;
  setBitmapActionsEnabled(false);
  try {
    const bitmap = await invertBitmap(sourceBitmap);
    if (!bitmapOperationIsCurrent(state, token, sourceBitmap)) {
      bitmap.close();
      return;
    }
    state.bitmap = bitmap;
    state.inverted = !state.inverted;
    els.invertImage.setAttribute("aria-pressed", String(state.inverted));
    const knockout = parseHexColor(els.knockoutColor.value);
    if (knockout) {
      els.knockoutColor.value = toHexColor(
        /** @type {[number, number, number]} */ (knockout.map((channel) => 255 - channel)),
      );
    }
    state.raster = null;
    if (!(await updateSourceView(bitmap, token))) return;
    retrace();
  } catch (err) {
    if (token === state.loadToken) showError(err.message || "Could not invert the image.");
  } finally {
    if (token === state.loadToken && state.bitmap) setBitmapActionsEnabled(true);
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
  els.autoDetect.checked = false;
  applyPreset(els.preset.value);
  scheduleRetrace();
});

for (const input of [els.colors, els.speckle, els.layerDiff]) {
  input.addEventListener("input", () => {
    // The preset only names a color count, so it follows the Colors slider.
    if (input === els.colors) {
      const match = [...els.preset.options].some((o) => o.value === els.colors.value);
      els.preset.value = match ? els.colors.value : "";
    }
    els.autoDetect.checked = false; // and keeps the value for later images
    clearProfile();
    updateOutputs();
    scheduleRetrace();
  });
}

for (const input of [
  els.fuzz,
  els.specks,
  els.enclosedSize,
  els.enclosedMaxSize,
  els.edgeTrim,
  els.edgeSmooth,
  els.defringe,
]) {
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

els.contiguous.addEventListener("change", () => {
  updateTransparencyFields();
  scheduleRetrace();
});

els.enclosed.addEventListener("change", () => {
  updateTransparencyFields();
  scheduleRetrace();
});
els.gradient.addEventListener("change", scheduleRetrace);

/**
 * The bitmap is decoded at the 2048 cap. Ultra re-decodes the kept file
 * at 4096 so capped sources regain real detail, replaying any rotation.
 * Uncapped sources (small logos) skip this: upscaling covers them.
 */
let ultraBitmapPromise = null;
let ultraBitmapToken = -1;

async function loadUltraBitmap() {
  if (!state.file || !state.bitmap || state.decodedSide >= MAX_TRACE_SIDE_ULTRA) return;
  if (
    Math.max(state.sourceWidth, state.sourceHeight) <=
    Math.max(state.bitmap.width, state.bitmap.height)
  ) {
    state.decodedSide = MAX_TRACE_SIDE_ULTRA;
    return;
  }
  const token = state.loadToken;
  const revision = bitmapRevision;
  const sourceBitmap = state.bitmap;
  const rotation = state.rotation;
  const inverted = state.inverted;
  els.status.textContent = "Reloading image at 4096 px…";
  try {
    const decoded = await decodeImage(state.file, MAX_TRACE_SIDE_ULTRA);
    let bitmap = await capBitmap(decoded, MAX_TRACE_SIDE_ULTRA);
    for (let i = 0; i < rotation; i++) bitmap = await rotateBitmap(bitmap, true);
    if (inverted) bitmap = await invertBitmap(bitmap);
    if (token !== state.loadToken || revision !== bitmapRevision || state.bitmap !== sourceBitmap) {
      bitmap.close();
      return;
    }
    sourceBitmap.close();
    state.bitmap = bitmap;
    state.raster = null;
    state.decodedSide = MAX_TRACE_SIDE_ULTRA;
    if (state.rotation || state.inverted) await updateSourceView(bitmap, token);
  } catch (err) {
    showError(err.message || "Could not reload the image at 4096 px.");
  }
}

async function ensureUltraBitmap() {
  const token = state.loadToken;
  if (ultraBitmapPromise && ultraBitmapToken !== token) {
    await ultraBitmapPromise;
  }
  if (!ultraBitmapPromise) {
    ultraBitmapToken = token;
    ultraBitmapPromise = loadUltraBitmap().finally(() => {
      ultraBitmapPromise = null;
    });
  }
  return ultraBitmapPromise;
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
  updateTraceFields();
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
els.simplify.addEventListener("input", () => {
  applySimplify(Number(els.simplify.value));
  clearProfile();
  updateOutputs();
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
  if (name.startsWith(USER_PRESET_PREFIX)) applyUserPreset(name);
  else applyExportProfile(name);
  if (els.upscale.value === "ultra") await ensureUltraBitmap();
  refreshExport(); // minify may have changed; applies without waiting
  scheduleRetrace();
});

// -- My colors: a fixed palette the trace snaps to ------------------------

/** @param {string[]} list @param {string} [note] */
function changeSwatches(list, note = "") {
  setSwatches(list);
  els.swatchNote.textContent = note;
  clearProfile();
  saveSettings();
  if (els.colorSource.value === "custom") scheduleRetrace();
}

els.colorSource.addEventListener("change", () => {
  clearProfile();
  updateColorSourceFields();
  scheduleRetrace();
});

function addTypedSwatches() {
  const added = parseSwatchText(els.swatchInput.value);
  if (!added.length) {
    els.swatchNote.textContent = "No hex color codes found. Use codes like #1f2a3b.";
    return;
  }
  const current = currentSwatches();
  const merged = [...new Set([...current, ...added])];
  els.swatchInput.value = "";
  changeSwatches(
    merged.slice(0, SWATCHES_MAX),
    merged.length > SWATCHES_MAX ? `Kept the first ${SWATCHES_MAX} colors.` : "",
  );
}
els.swatchAdd.addEventListener("click", addTypedSwatches);
els.swatchInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addTypedSwatches();
});

els.swatchList.addEventListener("click", (event) => {
  const button = event.target instanceof Element && event.target.closest("[data-swatch]");
  if (!(button instanceof HTMLElement)) return;
  const index = [...els.swatchList.children].indexOf(button);
  changeSwatches(
    currentSwatches().filter((hex) => hex !== button.dataset.swatch),
    `Removed ${button.dataset.swatch}.`,
  );
  // The removed swatch had focus: move to its neighbour, or the input.
  const next = els.swatchList.children[Math.min(index, els.swatchList.children.length - 1)];
  (next instanceof HTMLElement ? next : els.swatchInput).focus();
});

els.swatchClear.addEventListener("click", () => {
  changeSwatches([], "Colors cleared.");
  els.swatchInput.focus();
});

// Swatch files are small; anything far larger is not one.
const SWATCH_FILE_MAX_BYTES = 1_000_000;

els.swatchImport.addEventListener("click", () => els.swatchFile.click());
els.swatchFile.addEventListener("change", async () => {
  const file = els.swatchFile.files?.[0];
  els.swatchFile.value = "";
  if (!file) return;
  let swatches = [];
  let approximate = false;
  try {
    if (file.size > SWATCH_FILE_MAX_BYTES)
      throw new Error("That file is too large to be a swatch file.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (String.fromCharCode(...bytes.subarray(0, 4)) === "ASEF") {
      ({ swatches, approximate } = parseAse(bytes));
    } else {
      swatches = parseSwatchText(new TextDecoder().decode(bytes));
    }
  } catch (err) {
    els.swatchNote.textContent = err.message || "That swatch file could not be read.";
    return;
  }
  if (!swatches.length) {
    els.swatchNote.textContent = "No colors found in that file.";
    return;
  }
  // A swatch file is a whole palette: it replaces the list.
  changeSwatches(
    swatches,
    `Imported ${swatches.length} color${swatches.length === 1 ? "" : "s"} from ${file.name}.` +
      (approximate
        ? " CMYK, Lab and spot colors are converted to screen RGB, so they are approximate."
        : ""),
  );
});

// -- Saved presets -------------------------------------------------------

const PRESET_STORAGE_ERROR = "Presets could not be saved: browser storage is full or blocked.";

els.savePreset.addEventListener("click", () => {
  els.savePresetDialog.returnValue = "";
  els.presetName.value = userPresetName(els.exportProfile.value) ?? "";
  els.savePresetDialog.showModal();
  els.presetName.select();
});
els.savePresetDialog.addEventListener("close", () => {
  if (els.savePresetDialog.returnValue !== "save") return;
  const name = presetName(els.presetName.value);
  if (!name) {
    els.status.textContent = "Preset not saved: enter a name.";
    return;
  }
  const existing = findUserPreset(name);
  if (existing && !window.confirm(`Replace the preset "${existing.name}"?`)) return;
  if (!existing && userPresets.length >= PRESETS_MAX) {
    showError(`You can save up to ${PRESETS_MAX} presets. Delete one in File > Manage presets.`);
    return;
  }
  if (!saveUserPreset(name)) {
    showError(PRESET_STORAGE_ERROR);
    return;
  }
  saveSettings();
  els.status.textContent = `Preset "${name}" saved.`;
});

function renderPresetList() {
  els.presetList.replaceChildren(
    ...userPresets.map(({ name }) => {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button button-secondary";
      remove.textContent = "Delete";
      remove.setAttribute("aria-label", `Delete preset ${name}`);
      remove.addEventListener("click", () => {
        if (!window.confirm(`Delete the preset "${name}"?`)) return;
        if (!deleteUserPreset(name)) {
          els.presetMessage.textContent = PRESET_STORAGE_ERROR;
          return;
        }
        saveSettings();
        renderPresetList();
        els.presetMessage.textContent = `Deleted "${name}".`;
        // The focused row is gone; keep focus inside the dialog.
        els.presetImport.focus();
      });
      item.append(label, remove);
      return item;
    }),
  );
  els.presetEmpty.hidden = userPresets.length > 0;
  els.presetExport.disabled = userPresets.length === 0;
}

document.querySelector('[data-action="manage-presets"]').addEventListener("click", () => {
  els.presetMessage.textContent = "";
  renderPresetList();
  els.presetsDialog.showModal();
});

els.presetExport.addEventListener("click", () => {
  const file = JSON.stringify({ app: "rastertrace", version: 1, presets: userPresets }, null, 2);
  const url = URL.createObjectURL(new Blob([file], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "rastertrace-presets.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const count = userPresets.length;
  els.presetMessage.textContent = `Exported ${count} preset${count === 1 ? "" : "s"}.`;
});

// Preset files are small JSON; anything far larger is not one.
const PRESET_FILE_MAX_BYTES = 1_000_000;

els.presetImport.addEventListener("click", () => els.presetImportInput.click());
els.presetImportInput.addEventListener("change", async () => {
  const file = els.presetImportInput.files?.[0];
  els.presetImportInput.value = "";
  if (!file) return;
  let incoming = [];
  try {
    if (file.size <= PRESET_FILE_MAX_BYTES)
      incoming = sanitizePresets(JSON.parse(await file.text()));
  } catch {
    // Not JSON: reported below like a file with no presets.
  }
  if (!incoming.length) {
    els.presetMessage.textContent = "No rastertrace presets found in that file.";
    return;
  }
  const conflicts = incoming.filter((p) => findUserPreset(p.name));
  const replace =
    conflicts.length > 0 &&
    window.confirm(
      conflicts.length === 1
        ? `Replace the existing preset "${conflicts[0].name}"?`
        : `Replace ${conflicts.length} existing presets that have the same names?`,
    );
  const result = importUserPresets(incoming, replace);
  if (!result) {
    els.presetMessage.textContent = PRESET_STORAGE_ERROR;
    return;
  }
  saveSettings();
  renderPresetList();
  const imported = result.added.length + result.replaced.length;
  const skipped = result.skipped.length;
  els.presetMessage.textContent =
    `Imported ${imported} preset${imported === 1 ? "" : "s"}.` +
    (skipped
      ? ` Skipped ${skipped}: same name kept or the ${PRESETS_MAX}-preset limit reached.`
      : "");
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

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener("change", () => {
    clearProfile();
    updateTraceFields();
    scheduleRetrace();
  });
}

// Phone section tabs: one settings section shows at a time.
const sheetTabs = /** @type {NodeListOf<HTMLButtonElement>} */ (
  document.querySelectorAll("[data-sheet-tab]")
);
for (const tab of sheetTabs) {
  tab.addEventListener("click", () => {
    const sheet = tab.dataset.sheetTab;
    els.workspace.dataset.sheet = sheet;
    for (const other of sheetTabs) other.setAttribute("aria-pressed", String(other === tab));
    const section = els.workspace.querySelector(`[data-sheet="${sheet}"]`);
    if (section instanceof HTMLDetailsElement) section.open = true;
  });
}
if (phoneSheet.matches) {
  const section = els.workspace.querySelector(`[data-sheet="${els.workspace.dataset.sheet}"]`);
  if (section instanceof HTMLDetailsElement) section.open = true;
}

// Each side panel folds to a narrow rail, like Illustrator's or
// Lightroom's panel toggles, so the preview can take the room.
const FOLD_KEY = "rastertrace:folded";
const foldButtons = { left: els.foldLeft, right: els.foldRight };
const foldLabels = { left: "presets and palette", right: "settings" };

function isFolded(side) {
  return els.workspace.classList.contains(`${side}-folded`);
}

function setFolded(side, folded) {
  els.workspace.classList.toggle(`${side}-folded`, folded);
  const action = folded ? "Show" : "Hide";
  foldButtons[side].setAttribute("aria-expanded", String(!folded));
  foldButtons[side].setAttribute("aria-label", `${action} ${foldLabels[side]}`);
  foldButtons[side].title = `${action} panel (Ctrl+\\ for both)`;
}

function saveFolds() {
  try {
    localStorage.setItem(
      FOLD_KEY,
      JSON.stringify({ left: isFolded("left"), right: isFolded("right") }),
    );
  } catch {
    // Folding still works for this session when storage is unavailable.
  }
}

/** Fold both panels while either is open; otherwise show both. */
function toggleBothPanels() {
  const fold = !isFolded("left") || !isFolded("right");
  setFolded("left", fold);
  setFolded("right", fold);
  saveFolds();
}

{
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(FOLD_KEY) ?? "null");
  } catch {
    // Unreadable or blocked storage: use the defaults below.
  }
  // Without a saved choice, narrow desktops start with the presets folded.
  setFolded("left", stored ? stored.left === true : window.innerWidth <= 1180);
  setFolded("right", stored?.right === true);
}
for (const side of /** @type {const} */ (["left", "right"])) {
  foldButtons[side].addEventListener("click", () => {
    setFolded(side, !isFolded(side));
    saveFolds();
  });
}
document
  .querySelector('[data-action="toggle-left-panel"]')
  .addEventListener("click", () => els.foldLeft.click());
document
  .querySelector('[data-action="toggle-right-panel"]')
  .addEventListener("click", () => els.foldRight.click());
document.querySelector('[data-action="toggle-panels"]').addEventListener("click", toggleBothPanels);

els.showResult.addEventListener("click", () => setView("result"));
els.showSource.addEventListener("click", () => setView("source"));
// One backdrop at a time; each button's id is also the preview's class for it.
const backdropButtons = [els.greenScreen, els.whiteScreen, els.blackScreen];
for (const button of backdropButtons) {
  button.addEventListener("click", () => {
    const enabled = button.getAttribute("aria-pressed") !== "true";
    for (const other of backdropButtons) {
      const on = enabled && other === button;
      other.setAttribute("aria-pressed", String(on));
      els.preview.classList.toggle(other.id, on);
    }
    els.preview.classList.toggle("checkerboard", !enabled);
  });
}

// Turning auto-detect back on applies it to the current image right away.
els.autoDetect.addEventListener("change", () => {
  if (!els.autoDetect.checked || !state.bitmap) return;
  applyDetectedSettings(state.bitmap);
  scheduleRetrace();
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
    controlsRoot.addEventListener("input", updatePanelSummaries);
    controlsRoot.addEventListener("change", updatePanelSummaries);
  }
}
// pagehide covers reload and navigation; iOS can discard a backgrounded
// tab without firing it, so also flush when the page is hidden.
addEventListener("pagehide", flushSettings);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushSettings();
});

loadUserPresets(); // before restore: a saved session may have a preset selected
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
