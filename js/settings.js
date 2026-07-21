// Settings: measurement preferences, the live control values, export
// profiles and presets, and localStorage persistence across reloads.
import {
  DEFAULTS,
  EXPORT_PROFILES,
  parseHexColor,
  PRESETS,
  sanitizeSettings,
} from "./preprocess.js?v=43";
import { els, preferences } from "./context.js?v=3";
import { refreshExport, updatePhysicalHeightOut } from "./exporters.js?v=4";
import { setEyedropper } from "./cleanup-tools.js?v=4";

const PREFERENCES_KEY = "rastertrace-preferences";
const PHYSICAL_UNITS = new Set(["in", "cm", "mm"]);
const MEASUREMENT_UNITS = new Set(["px", "in", "cm", "mm"]);
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

function convertPhysicalValue(value, fromUnit, toUnit) {
  return value * MM_PER_UNIT[fromUnit] / MM_PER_UNIT[toUnit];
}

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
    stencilInk: document.querySelector('input[name="stencil-ink"]:checked').value,
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

export function updateOutputs() {
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
    els.stencil.closest("label").after(els.stencilThresholdField);
  }
}

/**
 * Apply a purpose-based export profile: moves the visible controls (like
 * presets do) and sets the export post-processing toggles. Everything
 * stays user-editable afterwards.
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
  document.querySelector(`input[name="mode"][value="${profile.mode}"]`).checked = true;
  els.hierarchical.value = profile.hierarchical;
  els.upscale.value = String(profile.upscale);
  els.stencil.checked = profile.stencil;
  document.querySelector(`input[name="stencil-ink"][value="${profile.stencilInk || "black"}"]`).checked = true;
  els.pathPrecision.value = String(profile.pathPrecision);
  if (profile.spliceThreshold) els.spliceThreshold.value = String(profile.spliceThreshold);
  els.minify.checked = profile.minify;
  els.preset.value = "";
  els.exportProfile.value = name; // resetSettings cleared the select
  updateStencilFields(); // after the select: Laser moves the threshold up top
  updateOutputs();
}

export function clearProfile() {
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
    stencilInk: document.querySelector('input[name="stencil-ink"]:checked').value,
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

export function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshotSettings()));
    } catch {
      // storage full or blocked (private mode): persistence is optional
    }
  }, 250);
}

export function restoreSettings() {
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
  if (saved.stencilInk) {
    document.querySelector(`input[name="stencil-ink"][value="${saved.stencilInk}"]`).checked = true;
  }
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

export function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  els.colors.value = preset.colors;
  els.speckle.value = preset.speckle;
  els.layerDiff.value = preset.layerDiff;
  updateOutputs();
}

export function updateTransparencyFields() {
  const mode = els.transparent.value;
  els.knockoutColorField.hidden = mode !== "custom";
  els.fuzzField.hidden = mode === "";
  els.edgeTrimField.hidden = mode === "";
  els.defringeField.hidden = mode === "";
  els.backgroundSummary.textContent = els.transparent.selectedOptions[0]?.textContent || "Keep background";
}

export function updateExportFields() {
  els.physicalSizeField.hidden = els.exportSize.value !== "physical";
}

export function resetSettings() {
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
  document.querySelector('input[name="stencil-ink"][value="black"]').checked = true;
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
