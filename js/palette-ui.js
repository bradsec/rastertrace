// Palette panel: swatch grid, color editor, and the result eyedropper
// that picks a traced color to edit. Edits recolor fills only; they
// only retrace when switching layering.
import { els, hooks, state } from "./context.js?v=70";
import { deactivateCleanupTools, setView, showResultOverSource } from "./cleanup-tools.js?v=117";
import { refreshExport } from "./exporters.js?v=94";
import {
  mergeEdits,
  mergeGroups,
  nearestFill,
  paletteMapping,
  PALETTE_GRID_MAX,
  pickColor,
  pruneEdits,
  rasterPalette,
  stencilFill,
  svgPalette,
} from "./palette.js?v=55";
import { parseHexColor, toHexColor } from "./preprocess.js?v=101";

// Local lookup: adding it to els would bump context.js at every importer.
const paletteHiddenNote = /** @type {HTMLElement} */ (
  document.getElementById("palette-hidden-note")
);
const paletteHiddenCount = /** @type {HTMLElement} */ (
  document.getElementById("palette-hidden-count")
);
const paletteOriginalHidden = /** @type {HTMLElement} */ (
  document.getElementById("palette-original-hidden")
);
const paletteError = /** @type {HTMLElement} */ (document.getElementById("palette-error"));
const paletteSelect = /** @type {HTMLButtonElement} */ (document.getElementById("palette-select"));
const paletteMerge = /** @type {HTMLButtonElement} */ (document.getElementById("palette-merge"));

/** @type {string | null} Original fill the editor is open on, or null when closed. */
let editing = null;
let refreshFrame = 0;
/** Swatches (by their largest color) chosen for merging. */
const selected = new Set();
/** Select mode: plain clicks select, for touch screens without modifiers. */
let selecting = false;
const hiddenColors = new Map();
const paletteHide = /** @type {HTMLButtonElement} */ (document.getElementById("palette-hide"));

const paletteLayeringNote = /** @type {HTMLElement} */ (
  document.getElementById("palette-layering-note")
);
const paletteUseCutout = /** @type {HTMLButtonElement} */ (
  document.getElementById("palette-use-cutout")
);

function syncLayeringNote() {
  paletteLayeringNote.hidden =
    els.hierarchical.value === "cutout" || ![...state.colorEdits.values()].includes("none");
}

els.hierarchical.addEventListener("change", syncLayeringNote);
paletteUseCutout.addEventListener("click", () => {
  els.hierarchical.value = "cutout";
  els.hierarchical.dispatchEvent(new Event("change", { bubbles: true }));
});

function syncEditor() {
  if (!editing) return;
  const merged = membersOf(editing).length > 1;
  els.paletteReset.textContent = merged ? "Split colors" : "Reset color";
  els.paletteReset.title = merged
    ? "Undo the merge: every color goes back to its traced color"
    : "Go back to the traced color";
  const hidden = editedFill(editing) === "none";
  paletteOriginalHidden.hidden = !hidden;
  paletteHide.textContent = hidden ? "Show color" : "Hide color";
  for (const input of [
    els.paletteColor,
    els.paletteHex,
    els.paletteR,
    els.paletteG,
    els.paletteB,
  ]) {
    input.disabled = hidden;
  }
}

// The native color input fires `input` continuously while dragging, and
// each refresh is a full string pass over the trace: one per frame.
function scheduleRefresh() {
  showResultOverSource();
  if (refreshFrame) return;
  refreshFrame = requestAnimationFrame(() => {
    refreshFrame = 0;
    refreshExport();
  });
}

function currentPalette() {
  return state.paletteColors;
}

/**
 * Palette for the current trace, and how SVG fills resolve to it. Stencil
 * traces and unreduced rasters (over 256 colors) fall back to exact SVG
 * fills: the stencil raster is always black on white whatever the ink.
 */
function computePalette() {
  if (!state.svgRaw) return { colors: [], mapping: null };
  const raster = els.stencil.checked ? null : rasterPalette(state.processedRaster);
  if (!raster) return { colors: svgPalette(state.svgRaw), mapping: null };
  const mapping = paletteMapping(state.svgRaw, raster);
  // Colors whose every region the speckle filter dropped have no fill.
  const traced = new Set(mapping.values());
  return { colors: raster.filter((entry) => traced.has(entry.fill)), mapping };
}

/**
 * @param {string} fill
 */
function editedFill(fill) {
  return state.colorEdits.get(fill) ?? fill;
}

/** Grid swatches: traced colors edited to one value merge into one. */
function swatchGroups() {
  return mergeGroups(currentPalette(), state.colorEdits);
}

/**
 * Every traced color sharing a swatch with `fill`, largest first.
 * @param {string} fill
 * @returns {string[]}
 */
function membersOf(fill) {
  return swatchGroups().find((group) => group.members.includes(fill))?.members ?? [fill];
}

/**
 * @param {boolean} on
 */
function setSelecting(on) {
  selecting = on;
  paletteSelect.setAttribute("aria-pressed", String(on));
  if (!on) selected.clear();
  renderPalette();
}

/**
 * @param {string} fill
 */
function toggleSelected(fill) {
  if (selected.has(fill)) selected.delete(fill);
  else selected.add(fill);
  renderPalette();
}

/**
 * @param {string} fill
 * @param {string} className
 */
function swatchButton(fill, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.fill = fill;
  button.style.background = editedFill(fill) === "none" ? fill : editedFill(fill);
  button.addEventListener("click", (event) => {
    if (selecting || event.shiftKey || event.ctrlKey || event.metaKey) toggleSelected(fill);
    else openEditor(fill);
  });
  return button;
}

export function renderPalette() {
  const groups = swatchGroups();
  // A merge can make another color the swatch's name: follow it.
  const open = editing;
  if (open) editing = groups.find((group) => group.members.includes(open))?.fill ?? open;
  for (const fill of [...selected]) {
    if (!groups.some((group) => group.fill === fill)) selected.delete(fill);
  }
  if (editing) syncEditor();
  syncLayeringNote();
  const palette = currentPalette();
  const merged = groups.filter((group) => group.members.length > 1).length;
  const hiddenCount = [...state.colorEdits.values()].filter((value) => value === "none").length;
  const edited = state.colorEdits.size - hiddenCount;
  paletteHiddenNote.hidden = hiddenCount === 0;
  paletteHiddenCount.textContent = `${hiddenCount} ${hiddenCount === 1 ? "color" : "colors"} hidden`;
  els.paletteSummary.textContent = palette.length
    ? `${groups.length} colors${merged ? `, ${merged} merged` : ""}${edited ? `, ${edited} edited` : ""}${hiddenCount ? `, ${hiddenCount} hidden` : ""}`
    : "No trace";
  els.palettePick.disabled = !palette.length;

  const showGrid = palette.length > 0 && palette.length <= PALETTE_GRID_MAX;
  paletteSelect.disabled = !showGrid || groups.length < 2;
  paletteMerge.hidden = selected.size < 2;
  paletteMerge.textContent = `Merge ${selected.size} colors`;
  els.paletteGrid.hidden = !showGrid;
  els.paletteHint.hidden = showGrid;
  els.paletteGrid.replaceChildren(
    ...(showGrid
      ? groups.map(({ fill, members }) => {
          const button = swatchButton(fill, "swatch");
          button.setAttribute("role", "listitem");
          const hidden = editedFill(fill) === "none";
          const count = members.length;
          button.classList.toggle("hidden-color", hidden);
          button.classList.toggle("selected", selected.has(fill));
          const name = count > 1 ? `${editedFill(fill)}, merged from ${count} colors` : fill;
          button.setAttribute(
            "aria-label",
            hidden
              ? `Color ${fill} hidden`
              : selecting
                ? `Select color ${name}`
                : `Edit color ${name}`,
          );
          button.title = hidden
            ? `Color ${fill} hidden`
            : count > 1
              ? `${count} colors merged into ${editedFill(fill)}`
              : state.colorEdits.has(fill)
                ? `${fill} changed to ${editedFill(fill)}`
                : fill;
          if (count > 1) {
            const badge = document.createElement("span");
            badge.className = "swatch-merge-badge";
            badge.setAttribute("aria-hidden", "true");
            badge.textContent = String(count);
            button.append(badge);
          }
          if (hidden) {
            const badge = document.createElement("span");
            badge.className = "swatch-hidden-badge";
            badge.setAttribute("aria-hidden", "true");
            const icon = document.createElement("span");
            icon.className = "material-icon icon-visibility_off";
            badge.append(icon);
            button.append(badge);
          }
          button.classList.toggle("edited", state.colorEdits.has(fill) && !hidden);
          button.setAttribute(
            "aria-pressed",
            String(selecting || selected.size ? selected.has(fill) : fill === editing),
          );
          return button;
        })
      : []),
  );

  els.paletteEdits.replaceChildren(
    ...[...state.colorEdits].map(([fill, value]) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "palette-edit-row";
      const hidden = value === "none";
      button.setAttribute(
        "aria-label",
        hidden ? `Color ${fill} hidden` : `Edit color ${fill}, now ${value}`,
      );
      const from = document.createElement("span");
      from.className = "palette-chip";
      from.style.background = fill;
      const to = document.createElement("span");
      to.className = hidden ? "palette-chip hidden-color" : "palette-chip";
      to.style.background = hidden ? fill : value;
      const label = document.createElement("code");
      label.textContent = hidden ? `${fill} hidden` : `${fill} to ${value}`;
      button.append(from, to, label);
      button.addEventListener("click", () => openEditor(fill));
      item.append(button);
      return item;
    }),
  );
  els.paletteResetAll.disabled = state.colorEdits.size === 0;
}

/**
 * Show `hex` in every editor field except `source`, the one being typed in.
 * @param {HTMLInputElement | null} [source]
 * @param {string} hex
 */
function syncFields(hex, source = null) {
  const rgb = /** @type {[number, number, number]} */ (parseHexColor(hex));
  if (source !== els.paletteColor) els.paletteColor.value = hex.toLowerCase();
  if (source !== els.paletteHex) els.paletteHex.value = hex;
  const channels = [els.paletteR, els.paletteG, els.paletteB];
  channels.forEach((input, i) => {
    if (input !== source) input.value = String(rgb[i]);
  });
  for (const input of [els.paletteHex, ...channels]) {
    if (input !== source) input.removeAttribute("aria-invalid");
  }
  showFieldError();
}

/** Explain the first invalid field; color alone does not (WCAG 1.4.1). */
function showFieldError() {
  /**
   * @param {HTMLInputElement} input
   */
  const invalid = (input) => input.getAttribute("aria-invalid") === "true";
  let message = "";
  if (invalid(els.paletteHex)) message = "Use six hex digits, like #336699.";
  else if ([els.paletteR, els.paletteG, els.paletteB].some(invalid)) {
    message = "Use a whole number from 0 to 255.";
  }
  paletteError.textContent = message;
  paletteError.hidden = !message;
}

/**
 * @param {string} fill
 */
function openEditor(fill) {
  const members = membersOf(fill);
  const original = /** @type {string} */ (members[0]);
  editing = original;
  els.paletteEditor.hidden = false;
  els.paletteOriginalSwatch.style.background = original;
  els.paletteOriginalHex.textContent =
    members.length > 1 ? `${original} and ${members.length - 1} more` : original;
  syncFields(editedFill(fill) === "none" ? (hiddenColors.get(fill) ?? fill) : editedFill(fill));
  syncEditor();
  renderPalette();
}

function closeEditor() {
  editing = null;
  els.paletteEditor.hidden = true;
  renderPalette();
}

/**
 * Record `hex` for the open swatch, every merged color with it; a color
 * set back to its own traced value has no edit.
 * @param {string} hex
 */
function applyEdit(hex) {
  if (!editing) return;
  for (const fill of membersOf(editing)) {
    if (hex === fill) state.colorEdits.delete(fill);
    else state.colorEdits.set(fill, hex);
  }
  renderPalette();
  scheduleRefresh();
}

function onHexInput() {
  const rgb = /** @type {[number, number, number] | null} */ (parseHexColor(els.paletteHex.value));
  if (!rgb) {
    els.paletteHex.setAttribute("aria-invalid", "true");
    showFieldError();
    return;
  }
  els.paletteHex.removeAttribute("aria-invalid");
  const hex = toHexColor(rgb);
  syncFields(hex, els.paletteHex);
  applyEdit(hex);
}

/**
 * @param {Event} event
 */
function onChannelInput(event) {
  const input = /** @type {HTMLInputElement} */ (event.currentTarget);
  const raw = input.value.trim();
  const value = Number(raw);
  if (!/^\d{1,3}$/.test(raw) || value > 255) {
    input.setAttribute("aria-invalid", "true");
    showFieldError();
    return;
  }
  input.removeAttribute("aria-invalid");
  const channels = [els.paletteR, els.paletteG, els.paletteB];
  if (channels.some((c) => c.getAttribute("aria-invalid") === "true")) {
    showFieldError();
    return;
  }
  const hex = toHexColor(
    /** @type {[number, number, number]} */ (channels.map((c) => Number(c.value))),
  );
  syncFields(hex, input);
  applyEdit(hex);
}

els.paletteColor.addEventListener("input", () => {
  const hex = toHexColor(
    /** @type {[number, number, number]} */ (parseHexColor(els.paletteColor.value)),
  );
  syncFields(hex, els.paletteColor);
  applyEdit(hex);
});
els.paletteHex.addEventListener("input", onHexInput);
for (const input of [els.paletteR, els.paletteG, els.paletteB]) {
  input.addEventListener("input", onChannelInput);
}
els.paletteReset.addEventListener("click", () => {
  if (!editing) return;
  // On a merged swatch this is Split: each color back to its own.
  const members = membersOf(editing);
  for (const fill of members) {
    hiddenColors.delete(fill);
    state.colorEdits.delete(fill);
  }
  if (members.length > 1) {
    els.paletteOriginalHex.textContent = editing;
    els.status.textContent = `Split ${members.length} colors back to their traced colors.`;
  }
  syncFields(editing);
  syncEditor();
  renderPalette();
  scheduleRefresh();
});
paletteHide.addEventListener("click", () => {
  if (!editing) return;
  if (editedFill(editing) === "none") {
    // Showing brings back every color hidden with it as one merged swatch.
    const color = hiddenColors.get(editing) ?? editing;
    for (const [fill, before] of [...hiddenColors]) {
      if (before !== color || state.colorEdits.get(fill) !== "none") continue;
      if (before === fill) state.colorEdits.delete(fill);
      else state.colorEdits.set(fill, before);
      hiddenColors.delete(fill);
    }
    // Hidden before its color was remembered: back to the traced color.
    if (state.colorEdits.get(editing) === "none") state.colorEdits.delete(editing);
    renderPalette();
    scheduleRefresh();
  } else {
    for (const fill of membersOf(editing)) hiddenColors.set(fill, editedFill(fill));
    applyEdit("none");
  }
  syncFields(editedFill(editing) === "none" ? hiddenColors.get(editing) : editedFill(editing));
  syncEditor();
});
els.paletteClose.addEventListener("click", closeEditor);
paletteSelect.addEventListener("click", () => setSelecting(!selecting));
paletteMerge.addEventListener("click", () => {
  const groups = swatchGroups().filter((group) => selected.has(group.fill));
  const fills = groups.flatMap((group) => group.members);
  if (groups.length < 2) return;
  const color = mergeEdits(state.colorEdits, currentPalette(), fills);
  for (const fill of fills) hiddenColors.delete(fill);
  selected.clear();
  selecting = false;
  paletteSelect.setAttribute("aria-pressed", "false");
  if (editing && fills.includes(editing)) syncFields(color);
  renderPalette();
  scheduleRefresh();
  els.status.textContent = `Merged ${fills.length} colors into ${color}.`;
});
els.paletteResetAll.addEventListener("click", () => {
  state.colorEdits.clear();
  hiddenColors.clear();
  if (editing) syncFields(editing);
  syncEditor();
  renderPalette();
  scheduleRefresh();
  els.status.textContent = "All color edits reset.";
});

// -- Eyedropper on the result -----------------------------------------

/**
 * @param {boolean} armed
 */
export function setPalettePick(armed) {
  const next = armed && Boolean(state.svgRaw);
  if (next) deactivateCleanupTools();
  if (!next && !state.palettePicking) return;
  state.palettePicking = next;
  els.palettePick.setAttribute("aria-pressed", String(next));
  els.preview.classList.toggle("picking", next);
  if (next) {
    setView("result");
    els.status.textContent = "Click the result to choose a color to edit. Esc cancels.";
  } else {
    els.status.textContent = "";
  }
}

hooks.cancelPalettePick = () => setPalettePick(false);

els.palettePick.addEventListener("click", () => setPalettePick(!state.palettePicking));

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (state.palettePicking) setPalettePick(false);
  if (selecting || selected.size) setSelecting(false);
});

// Registered before view.js's pan handler (app.js import order), so the
// pick consumes the press instead of starting a pan.
els.preview.addEventListener("pointerdown", (event) => {
  if (!state.palettePicking || event.button !== 0) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const rect = els.resultView.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  const rgb = pickColor(state.processedRaster, x, y);
  const ink = /** @type {HTMLInputElement | null} */ (
    document.querySelector('input[name="stencil-ink"]:checked')
  );
  const fill =
    rgb &&
    (els.stencil.checked
      ? stencilFill(rgb, ink?.value ?? "black")
      : nearestFill(rgb, currentPalette()));
  if (!fill) {
    els.status.textContent = "No traced color here: that area is transparent or empty background.";
    return;
  }
  setPalettePick(false);
  openEditor(fill);
  els.status.textContent = `Editing ${fill}.`;
});

/**
 * Reconcile edits with a new trace: keep those whose original color is
 * still present, drop the rest. Returns a status note when any dropped.
 * @returns {string | null}
 */
export function afterTrace() {
  const { colors, mapping } = computePalette();
  state.paletteColors = colors;
  state.paletteMapping = mapping;
  const removed = pruneEdits(state.colorEdits, colors);
  pruneEdits(hiddenColors, colors);
  if (editing && !colors.some((p) => p.fill === editing)) {
    closeEditor();
  } else {
    renderPalette();
  }
  return removed
    ? "Some color edits were cleared because those colors changed after re-tracing."
    : null;
}

/** Drop every edit and close the editor, for a newly loaded image. */
export function resetPalette() {
  state.colorEdits.clear();
  hiddenColors.clear();
  selected.clear();
  selecting = false;
  paletteSelect.setAttribute("aria-pressed", "false");
  state.paletteColors = [];
  state.paletteMapping = null;
  setPalettePick(false);
  closeEditor();
}

renderPalette();
