// Settings: measurement preferences, the live control values, export
// profiles and presets, and localStorage persistence across reloads.
import { parseHexColor } from "./color.js?v=1";
import {
  DEFAULTS,
  ENCLOSED_NO_LIMIT,
  EXPORT_PROFILES,
  mergePresets,
  PRESETS,
  sanitizePresets,
  sanitizeSettings,
  SIMPLIFY_LEVELS,
  simplifyLevel,
  toGrayscaleColor,
  USER_PRESET_PREFIX,
  userPresetName,
} from "./preprocess.js?v=104";
import { els, preferences } from "./context.js?v=70";
import { refreshExport, updatePhysicalHeightOut } from "./exporters.js?v=97";
import { setEyedropper } from "./cleanup-tools.js?v=120";

/**
 * @returns {HTMLInputElement}
 * @param {string} selector
 */
const radioEl = (selector) => /** @type {HTMLInputElement} */ (document.querySelector(selector));

const PREFERENCES_KEY = "rastertrace-preferences";
const PHYSICAL_UNITS = new Set(["in", "cm", "mm"]);
const MEASUREMENT_UNITS = new Set(["px", "in", "cm", "mm"]);
/**
 * @type {Record<string, number>}
 */
const MM_PER_UNIT = { in: 25.4, cm: 10, mm: 1 };

export function readPreferences(fallbackUnit = "mm") {
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

export function savePreferences() {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences still apply for this session when storage is unavailable.
  }
}

/**
 * @param {number} value
 * @param {string} fromUnit
 * @param {string} toUnit
 */
function convertPhysicalValue(value, fromUnit, toUnit) {
  return (value * MM_PER_UNIT[fromUnit]) / MM_PER_UNIT[toUnit];
}

/**
 * @param {string} unit
 */
export function applyMeasurementUnit(unit, preserveSize = true) {
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

export function currentSettings() {
  let transparent =
    els.transparent.value === "auto" || els.transparent.value === "edges"
      ? els.transparent.value
      : els.transparent.value === "custom"
        ? parseHexColor(els.knockoutColor.value)
        : null;
  if (Array.isArray(transparent) && (els.grayscale.checked || els.stencil.checked)) {
    transparent = toGrayscaleColor(/** @type {[number, number, number]} */ (transparent));
  }
  return {
    colors: Number(els.colors.value),
    speckle: Number(els.speckle.value),
    layerDiff: Number(els.layerDiff.value),
    cornerThreshold: Number(els.cornerThreshold.value),
    straighten: Number(els.straighten.value),
    smoothOutlines: Number(els.smoothOutlines.value),
    hierarchical: els.hierarchical.value,
    upscale:
      els.upscale.value === "auto" || els.upscale.value === "ultra"
        ? els.upscale.value
        : Number(els.upscale.value),
    mode: radioEl('input[name="mode"]:checked').value,
    grayscale: els.grayscale.checked,
    denoise: els.denoise.checked,
    stencil: els.stencil.checked,
    stencilThreshold: Number(els.stencilThreshold.value),
    stencilInk: radioEl('input[name="stencil-ink"]:checked').value,
    pathPrecision: Number(els.pathPrecision.value),
    lengthThreshold: Number(els.lengthThreshold.value),
    spliceThreshold: Number(els.spliceThreshold.value),
    transparent,
    contiguous: els.contiguous.checked,
    enclosed: els.enclosed.checked,
    enclosedSize: Number(els.enclosedSize.value),
    enclosedMaxSize: Number(els.enclosedMaxSize.value),
    gradient: els.gradient.checked,
    specks: Number(els.specks.value),
    fuzz: Number(els.fuzz.value),
    edgeTrim: Number(els.edgeTrim.value),
    defringe: Number(els.defringe.value),
    edgeSmooth: Number(els.edgeSmooth.value),
    swatches:
      els.colorSource.value === "custom" && currentSwatches().length ? currentSwatches() : null,
  };
}

/** "My colors" swatches, held comma-joined in a hidden input so snapshots see them. */
export function currentSwatches() {
  return els.swatches.value ? els.swatches.value.split(",") : [];
}

/**
 * Replace the swatch list and redraw it; each swatch button removes itself.
 * @param {string[]} list
 */
export function setSwatches(list) {
  els.swatches.value = list.join(",");
  els.swatchList.replaceChildren(
    ...list.map((hex) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "swatch";
      button.dataset.swatch = hex;
      button.style.background = hex;
      button.title = `${hex} (click to remove)`;
      button.setAttribute("aria-label", `Remove ${hex}`);
      return button;
    }),
  );
  els.swatchEmpty.hidden = list.length > 0;
  els.swatchClear.disabled = list.length === 0;
  updateTraceFields();
}

export function updateColorSourceFields() {
  els.swatchField.hidden = els.colorSource.value !== "custom";
  updateTraceFields();
}

export function updateOutputs() {
  const colors = Number(els.colors.value);
  els.colorsOut.textContent = colors >= 256 ? "All" : String(colors);
  els.speckleOut.textContent = els.speckle.value;
  els.layerDiffOut.textContent = els.layerDiff.value;
  els.cornerThresholdOut.textContent = els.cornerThreshold.value;
  els.straightenOut.textContent = Number(els.straighten.value) === 0 ? "Off" : els.straighten.value;
  els.smoothOutlinesOut.textContent =
    Number(els.smoothOutlines.value) === 0 ? "Off" : els.smoothOutlines.value;
  els.fuzzOut.textContent = els.fuzz.value;
  els.specksOut.textContent = els.specks.value;
  els.enclosedSizeOut.textContent = `${els.enclosedSize.value} px`;
  els.enclosedMaxSizeOut.textContent =
    Number(els.enclosedMaxSize.value) >= ENCLOSED_NO_LIMIT
      ? "No limit"
      : `${els.enclosedMaxSize.value} px`;
  els.edgeTrimOut.textContent = els.edgeTrim.value;
  els.defringeOut.textContent = els.defringe.value;
  els.edgeSmoothOut.textContent = els.edgeSmooth.value;
  els.pathPrecisionOut.textContent = els.pathPrecision.value;
  els.lengthThresholdOut.textContent = els.lengthThreshold.value;
  els.spliceThresholdOut.textContent = els.spliceThreshold.value;
  updateSimplify();
  els.stencilThresholdOut.textContent = els.stencilThreshold.value;
  updatePanelSummaries();
}

/** The current value each settings section shows while it is folded. */
export function updatePanelSummaries() {
  const profile = els.exportProfile.selectedOptions[0];
  els.profileSummary.textContent = profile && profile.value ? profile.textContent : "Custom";
  const colors = Number(els.colors.value);
  const swatches = currentSwatches().length;
  els.colorsSummary.textContent = els.stencil.checked
    ? "Stencil"
    : els.colorSource.value === "custom" && swatches > 0
      ? `${swatches} of my colors`
      : colors >= 256
        ? "All colors"
        : `${colors} colors`;
  els.tracingSummary.textContent =
    radioEl('input[name="mode"]:checked').closest("label")?.textContent?.trim() ?? "";
  els.exportSummary.textContent =
    els.exportSize.value === "physical"
      ? `${els.physicalWidth.value} ${els.physicalUnit.value}`
      : "Source size";
}

/**
 * Simplify has no stored value of its own: it shows the level matching
 * the Advanced curve settings, or Custom (at the nearest level) when they
 * were set by hand.
 */
function updateSimplify() {
  const length = Number(els.lengthThreshold.value);
  const splice = Number(els.spliceThreshold.value);
  const level = simplifyLevel(length, splice);
  if (level === -1) {
    /**
     * @param {{ spliceThreshold: number }} l
     */
    const distance = (l) => Math.abs(l.spliceThreshold - splice);
    const nearest = SIMPLIFY_LEVELS.reduce(
      (best, l, i) => (distance(l) < distance(SIMPLIFY_LEVELS[best]) ? i : best),
      0,
    );
    els.simplify.value = String(nearest);
    els.simplifyOut.textContent = "Custom";
  } else {
    els.simplify.value = String(level);
    els.simplifyOut.textContent = String(level);
  }
}

/**
 * Set the Advanced curve settings from a Simplify level.
 * @param {number} level
 */
export function applySimplify(level) {
  const { lengthThreshold, spliceThreshold } = SIMPLIFY_LEVELS[level];
  els.lengthThreshold.value = String(lengthThreshold);
  els.spliceThreshold.value = String(spliceThreshold);
}

/**
 * Disable controls the current trace ignores, so they never look broken:
 * stencil traces brightness in black and white, and only spline fitting
 * uses the curve settings.
 */
export function updateTraceFields() {
  const stencil = els.stencil.checked;
  // My colors sets the palette, so the color count no longer applies.
  els.colors.disabled =
    stencil || (els.colorSource.value === "custom" && currentSwatches().length > 0);
  els.preset.disabled = els.colors.disabled;
  els.layerDiff.disabled = stencil;
  els.grayscale.disabled = stencil;
  const spline = radioEl('input[name="mode"]:checked').value === "spline";
  for (const input of [
    els.simplify,
    els.cornerThreshold,
    els.lengthThreshold,
    els.spliceThreshold,
  ]) {
    input.disabled = !spline;
  }
}

export function updateStencilFields() {
  els.stencilThresholdField.hidden = !els.stencil.checked;
  els.stencilInkField.hidden = !els.stencil.checked;
  // The Laser profile's main dial belongs at the top, under the profile
  // select; anywhere else it lives in the Tracing panel next to the
  // stencil checkbox. Moving the node keeps value and listeners.
  const atTop = els.stencil.checked && els.exportProfile.value === "laser";
  els.stencilThresholdSlot.hidden = !atTop;
  if (atTop && els.stencilThresholdField.parentElement !== els.stencilThresholdSlot) {
    els.stencilThresholdSlot.appendChild(els.stencilThresholdField);
  } else if (!atTop && els.stencilThresholdField.parentElement === els.stencilThresholdSlot) {
    /** @type {HTMLLabelElement} */ (els.stencil.closest("label")).after(els.stencilThresholdField);
  }
}

/**
 * Apply a purpose-based export profile: moves the visible controls (like
 * presets do) and sets the export post-processing toggles. Everything
 * stays user-editable afterwards.
 * @param {string} name
 */
export function applyExportProfile(name) {
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
  if (profile.smoothOutlines !== undefined) {
    els.smoothOutlines.value = String(profile.smoothOutlines);
  }
  radioEl(`input[name="mode"][value="${profile.mode}"]`).checked = true;
  els.hierarchical.value = profile.hierarchical;
  els.upscale.value = String(profile.upscale);
  els.stencil.checked = profile.stencil;
  radioEl(`input[name="stencil-ink"][value="${profile.stencilInk || "black"}"]`).checked = true;
  els.pathPrecision.value = String(profile.pathPrecision);
  if (profile.spliceThreshold) els.spliceThreshold.value = String(profile.spliceThreshold);
  if (profile.lengthThreshold) els.lengthThreshold.value = String(profile.lengthThreshold);
  if (profile.stencilThreshold) els.stencilThreshold.value = String(profile.stencilThreshold);
  els.denoise.checked = Boolean(profile.denoise);
  els.minify.checked = profile.minify;
  els.preset.value = "";
  // Most profiles choose the color settings, so detection must not replace
  // them; autoDetect profiles let flat art keep its own colors.
  els.autoDetect.checked = Boolean(profile.autoDetect);
  els.exportProfile.value = name; // resetSettings cleared the select
  updateStencilFields(); // after the select: Laser moves the threshold up top
  updateTraceFields();
  updateOutputs();
}

export function clearProfile() {
  els.exportProfile.value = "";
  updateStencilFields(); // threshold slides back into the Tracing panel
  updatePanelSummaries();
}

// -- Settings persistence: survive reloads, keep tuned values ----------

const SETTINGS_KEY = "rastertrace-settings";
// The defaults in effect when the settings were saved. A saved value that
// still equals its default then was never chosen, so it follows today's
// default instead of pinning the old one.
const SAVED_DEFAULTS_KEY = "rastertrace-settings-defaults";
// Saves from before SAVED_DEFAULTS_KEY existed: the defaults that changed
// since, so values left at those follow the new defaults too.
const LEGACY_DEFAULTS = { straighten: 0, lengthThreshold: 4, spliceThreshold: 45 };
/** @type {Record<string, unknown> | null} This page's defaults, read before saved settings apply. */
let pageDefaults = null;

function snapshotSettings() {
  return {
    profile: els.exportProfile.value,
    autoDetect: els.autoDetect.checked,
    preset: els.preset.value,
    colors: Number(els.colors.value),
    speckle: Number(els.speckle.value),
    layerDiff: Number(els.layerDiff.value),
    cornerThreshold: Number(els.cornerThreshold.value),
    straighten: Number(els.straighten.value),
    smoothOutlines: Number(els.smoothOutlines.value),
    hierarchical: els.hierarchical.value,
    upscale:
      els.upscale.value === "auto" || els.upscale.value === "ultra"
        ? els.upscale.value
        : Number(els.upscale.value),
    mode: radioEl('input[name="mode"]:checked').value,
    grayscale: els.grayscale.checked,
    denoise: els.denoise.checked,
    stencil: els.stencil.checked,
    stencilThreshold: Number(els.stencilThreshold.value),
    stencilInk: radioEl('input[name="stencil-ink"]:checked').value,
    transparent: els.transparent.value,
    knockoutColor: els.knockoutColor.value,
    contiguous: els.contiguous.checked,
    enclosed: els.enclosed.checked,
    enclosedSize: Number(els.enclosedSize.value),
    enclosedMaxSize: Number(els.enclosedMaxSize.value),
    gradient: els.gradient.checked,
    specks: Number(els.specks.value),
    fuzz: Number(els.fuzz.value),
    edgeTrim: Number(els.edgeTrim.value),
    defringe: Number(els.defringe.value),
    edgeSmooth: Number(els.edgeSmooth.value),
    pathPrecision: Number(els.pathPrecision.value),
    lengthThreshold: Number(els.lengthThreshold.value),
    spliceThreshold: Number(els.spliceThreshold.value),
    exportSize: els.exportSize.value,
    physicalWidth: Number(els.physicalWidth.value),
    physicalUnit: els.physicalUnit.value,
    minify: els.minify.checked,
    colorSource: els.colorSource.value,
    swatches: currentSwatches(),
  };
}

let saveTimer = 0;

function writeSettings() {
  saveTimer = 0;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshotSettings()));
    if (pageDefaults) localStorage.setItem(SAVED_DEFAULTS_KEY, JSON.stringify(pageDefaults));
  } catch {
    // storage full or blocked (private mode): persistence is optional
  }
}

export function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeSettings, 250);
}

/** Write a pending debounced save now, before the page goes away. */
export function flushSettings() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  writeSettings();
}

/**
 * Set every control present in a sanitized snapshot; absent keys keep
 * their current value. Profile and auto-detect are the caller's call.
 * @param {Record<string, any>} saved
 */
function applySnapshot(saved) {
  /**
   * @param {HTMLInputElement | HTMLSelectElement} el
   * @param {string} key
   */
  const set = (el, key) => {
    if (saved[key] !== undefined) el.value = String(saved[key]);
  };
  /**
   * @param {HTMLInputElement} el
   * @param {string} key
   */
  const check = (el, key) => {
    if (saved[key] !== undefined) el.checked = saved[key];
  };
  set(els.preset, "preset");
  set(els.colors, "colors");
  set(els.speckle, "speckle");
  set(els.layerDiff, "layerDiff");
  set(els.cornerThreshold, "cornerThreshold");
  set(els.straighten, "straighten");
  set(els.smoothOutlines, "smoothOutlines");
  set(els.hierarchical, "hierarchical");
  set(els.upscale, "upscale");
  if (saved.mode) {
    radioEl(`input[name="mode"][value="${saved.mode}"]`).checked = true;
  }
  check(els.grayscale, "grayscale");
  check(els.denoise, "denoise");
  check(els.stencil, "stencil");
  set(els.stencilThreshold, "stencilThreshold");
  if (saved.stencilInk) {
    radioEl(`input[name="stencil-ink"][value="${saved.stencilInk}"]`).checked = true;
  }
  set(els.transparent, "transparent");
  set(els.knockoutColor, "knockoutColor");
  check(els.contiguous, "contiguous");
  check(els.enclosed, "enclosed");
  set(els.enclosedSize, "enclosedSize");
  set(els.enclosedMaxSize, "enclosedMaxSize");
  check(els.gradient, "gradient");
  set(els.specks, "specks");
  set(els.fuzz, "fuzz");
  set(els.edgeTrim, "edgeTrim");
  set(els.defringe, "defringe");
  set(els.edgeSmooth, "edgeSmooth");
  set(els.pathPrecision, "pathPrecision");
  set(els.lengthThreshold, "lengthThreshold");
  set(els.spliceThreshold, "spliceThreshold");
  set(els.exportSize, "exportSize");
  set(els.physicalWidth, "physicalWidth");
  set(els.physicalUnit, "physicalUnit");
  check(els.minify, "minify");
  set(els.colorSource, "colorSource");
  if (saved.swatches) setSwatches(saved.swatches);
  updateColorSourceFields();
  updateTransparencyFields();
  updateExportFields();
  updateStencilFields();
  updateTraceFields();
  updateOutputs();
}

export function restoreSettings() {
  let saved;
  try {
    saved = sanitizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null"));
  } catch {
    return;
  }
  pageDefaults = snapshotSettings();
  const defaults = JSON.stringify(pageDefaults);
  /** @type {Record<string, unknown> | null} */
  let savedDefaults = null;
  try {
    savedDefaults = JSON.parse(localStorage.getItem(SAVED_DEFAULTS_KEY) ?? "null");
  } catch {
    // Unreadable: treat the save as one from before defaults were kept.
  }
  if (!savedDefaults || typeof savedDefaults !== "object") {
    savedDefaults = { ...pageDefaults, ...LEGACY_DEFAULTS };
  }
  for (const key of Object.keys(saved)) {
    if (
      Object.prototype.hasOwnProperty.call(DEFAULTS, key) &&
      JSON.stringify(saved[key]) === JSON.stringify(savedDefaults[key])
    ) {
      delete saved[key];
    }
  }
  if (saved.profile !== undefined) els.exportProfile.value = saved.profile;
  // Saves from before the checkbox existed: a chosen profile or preset
  // means the user picked color settings, so keep them across images.
  if (saved.autoDetect === undefined && (saved.profile || saved.preset)) saved.autoDetect = false;
  if (saved.autoDetect !== undefined) els.autoDetect.checked = saved.autoDetect;
  applySnapshot(saved);
  // Tell the user their previous session's settings are in effect, so a
  // surprising result (e.g. an old stencil threshold) is explainable.
  els.restoredNote.hidden = JSON.stringify(snapshotSettings()) === defaults;
}

// Set per image by auto-detect, so they never count as carried over.
const DETECTED_KEYS = ["colors", "speckle", "layerDiff"];

/**
 * Show the settings reminder when an image opens with settings that differ
 * from the defaults: they carry over from image to image, and a result
 * shaped by an earlier image's choices should be explainable. Values
 * auto-detect sets for each image do not count while it is on.
 */
export function noteCarriedSettings() {
  const defaults = pageDefaults;
  if (!defaults) return;
  /** @type {Record<string, unknown>} */
  const current = snapshotSettings();
  const detected = els.autoDetect.checked ? DETECTED_KEYS : [];
  const differs = Object.keys(defaults).some(
    (key) =>
      !detected.includes(key) && JSON.stringify(current[key]) !== JSON.stringify(defaults[key]),
  );
  els.restoredNote.hidden = !differs;
}

/**
 * Quick color count: sets Colors only, leaving cleanup settings alone.
 * @param {string} name
 */
export function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  els.colors.value = String(preset.colors);
  updateOutputs();
}

export function updateTransparencyFields() {
  const mode = els.transparent.value;
  els.knockoutColorField.hidden = mode !== "custom";
  els.contiguousField.hidden = mode !== "custom";
  // Enclosed holes and gradient following only apply to border-connected
  // removal.
  const connected = mode === "edges" || (mode === "custom" && els.contiguous.checked);
  els.enclosedField.hidden = !connected;
  els.enclosedSizeField.hidden = !connected || !els.enclosed.checked;
  els.enclosedMaxSizeField.hidden = els.enclosedSizeField.hidden;
  els.gradientField.hidden = !connected;
  els.fuzzField.hidden = mode === "";
  els.specksField.hidden = mode === "";
  els.edgeTrimField.hidden = mode === "";
  els.defringeField.hidden = mode === "";
  els.edgeSmoothField.hidden = mode === "";
  els.backgroundSummary.textContent =
    els.transparent.selectedOptions[0]?.textContent || "Keep background";
}

export function updateExportFields() {
  els.physicalSizeField.hidden = els.exportSize.value !== "physical";
}

export function resetSettings() {
  els.exportProfile.value = "";
  els.preset.value = "";
  els.autoDetect.checked = DEFAULTS.autoDetect;
  els.colors.value = String(DEFAULTS.colors);
  els.speckle.value = String(DEFAULTS.speckle);
  els.layerDiff.value = String(DEFAULTS.layerDiff);
  els.cornerThreshold.value = String(DEFAULTS.cornerThreshold);
  els.straighten.value = String(DEFAULTS.straighten);
  els.smoothOutlines.value = String(DEFAULTS.smoothOutlines);
  els.hierarchical.value = DEFAULTS.hierarchical;
  els.upscale.value = String(DEFAULTS.upscale);
  radioEl(`input[name="mode"][value="${DEFAULTS.mode}"]`).checked = true;
  els.grayscale.checked = DEFAULTS.grayscale;
  els.denoise.checked = DEFAULTS.denoise;
  els.transparent.value = DEFAULTS.transparent;
  els.knockoutColor.value = "#ffffff";
  els.contiguous.checked = DEFAULTS.contiguous;
  els.enclosed.checked = DEFAULTS.enclosed;
  els.enclosedSize.value = String(DEFAULTS.enclosedSize);
  els.enclosedMaxSize.value = String(DEFAULTS.enclosedMaxSize);
  els.gradient.checked = DEFAULTS.gradient;
  els.specks.value = String(DEFAULTS.specks);
  els.fuzz.value = String(DEFAULTS.fuzz);
  els.edgeTrim.value = String(DEFAULTS.edgeTrim);
  els.defringe.value = String(DEFAULTS.defringe);
  els.edgeSmooth.value = String(DEFAULTS.edgeSmooth);
  els.stencil.checked = DEFAULTS.stencil;
  els.stencilThreshold.value = String(DEFAULTS.stencilThreshold);
  radioEl(`input[name="stencil-ink"][value="${DEFAULTS.stencilInk}"]`).checked = true;
  els.pathPrecision.value = String(DEFAULTS.pathPrecision);
  els.lengthThreshold.value = String(DEFAULTS.lengthThreshold);
  els.spliceThreshold.value = String(DEFAULTS.spliceThreshold);
  els.exportSize.value = "px";
  els.physicalWidth.value = "100";
  // The unit is a preference (Preferences dialog), not a per-trace setting.
  els.physicalUnit.value = preferences.measurementUnit;
  els.minify.checked = false;
  // The swatch list is kept: switching back to My colors restores it.
  els.colorSource.value = "auto";
  updateColorSourceFields();
  setEyedropper(false);
  updateTransparencyFields();
  updateExportFields();
  updateStencilFields();
  updateTraceFields();
  updateOutputs();
}

// -- Saved user presets: named snapshots listed under the profiles ------

const PRESETS_KEY = "rastertrace-presets";

/** @type {{ name: string, settings: object }[]} */
export let userPresets = [];

export function loadUserPresets() {
  try {
    userPresets = sanitizePresets(JSON.parse(localStorage.getItem(PRESETS_KEY) || "[]"));
  } catch {
    userPresets = [];
  }
  renderPresetOptions();
}

/**
 * Store `presets`; false when browser storage is full or blocked.
 * @param {{ name: string, settings: object }[]} presets
 */
function storeUserPresets(presets) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch {
    return false;
  }
  userPresets = presets;
  renderPresetOptions();
  return true;
}

/** List the saved profiles under "My profiles" in the profile select, keeping its value. */
function renderPresetOptions() {
  const value = els.exportProfile.value;
  els.exportProfile.querySelector("optgroup[data-user-presets]")?.remove();
  if (userPresets.length) {
    const group = document.createElement("optgroup");
    group.label = "My profiles";
    group.dataset.userPresets = "";
    for (const { name } of userPresets) {
      group.append(new Option(name, USER_PRESET_PREFIX + name));
    }
    els.exportProfile.append(group);
  }
  els.exportProfile.value = value;
  // The active preset was deleted: the controls are now just custom.
  if (els.exportProfile.value !== value) clearProfile();
}

/**
 * Existing preset with this name (case-insensitive), or undefined.
 * @param {string} name
 */
export function findUserPreset(name) {
  return userPresets.find((p) => p.name.toLowerCase() === name.toLowerCase());
}

/**
 * Save the current controls as `name`, replacing a same-named preset.
 * @param {string} name
 */
export function saveUserPreset(name) {
  const settings = sanitizePresets([{ name, settings: snapshotSettings() }])[0]?.settings;
  if (!settings) return false;
  const { presets } = mergePresets(userPresets, [{ name, settings }]);
  if (!storeUserPresets(presets)) return false;
  els.exportProfile.value = USER_PRESET_PREFIX + (findUserPreset(name)?.name ?? name);
  updateStencilFields();
  return true;
}

/**
 * @param {string} name
 */
export function deleteUserPreset(name) {
  return storeUserPresets(userPresets.filter((p) => p.name !== name));
}

/**
 * Merge imported presets (already sanitized). Same names are replaced
 * only with `replace`. Returns mergePresets' report, or null when the
 * result could not be stored.
 * @param {{ name: string, settings: object }[]} incoming
 * @param {boolean} replace
 */
export function importUserPresets(incoming, replace) {
  const result = mergePresets(userPresets, incoming, { replace });
  return storeUserPresets(result.presets) ? result : null;
}

/**
 * Apply a saved preset like a profile: defaults first, then its values.
 * @param {string} profileValue
 */
export function applyUserPreset(profileValue) {
  const name = userPresetName(profileValue);
  const preset = name && findUserPreset(name);
  if (!preset) return;
  resetSettings();
  els.restoredNote.hidden = true;
  applySnapshot(preset.settings);
  // The preset chose the color settings; detection must not replace them.
  els.autoDetect.checked = false;
  els.exportProfile.value = profileValue;
  updateStencilFields();
}
