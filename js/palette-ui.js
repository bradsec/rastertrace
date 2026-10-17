// Palette panel: swatch grid, color editor, and the result eyedropper
// that picks a traced color to edit. Edits recolor fills only; they
// never retrace.
import { els, hooks, state } from "./context.js?v=16";
import { deactivateCleanupTools, setView } from "./cleanup-tools.js?v=25";
import { refreshExport } from "./exporters.js?v=21";
import {
  nearestFill,
  paletteMapping,
  PALETTE_GRID_MAX,
  pickColor,
  pruneEdits,
  rasterPalette,
  stencilFill,
  svgPalette,
} from "./palette.js?v=3";
import { parseHexColor, toHexColor } from "./preprocess.js?v=52";

// Local lookup: adding it to els would bump context.js at every importer.
const paletteError = /** @type {HTMLElement} */ (document.getElementById("palette-error"));

/** Original fill the editor is open on, or null when closed. */
let editing = null;
let refreshFrame = 0;

// The native color input fires `input` continuously while dragging, and
// each refresh is a full string pass over the trace: one per frame.
function scheduleRefresh() {
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

function editedFill(fill) {
  return state.colorEdits.get(fill) ?? fill;
}

function swatchButton(fill, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.fill = fill;
  button.style.background = editedFill(fill);
  button.addEventListener("click", () => openEditor(fill));
  return button;
}

export function renderPalette() {
  const palette = currentPalette();
  const edited = state.colorEdits.size;
  els.paletteSummary.textContent = palette.length
    ? `${palette.length} colors${edited ? `, ${edited} edited` : ""}`
    : "No trace";
  els.palettePick.disabled = !palette.length;

  const showGrid = palette.length > 0 && palette.length <= PALETTE_GRID_MAX;
  els.paletteGrid.hidden = !showGrid;
  els.paletteHint.hidden = showGrid;
  els.paletteGrid.replaceChildren(
    ...(showGrid
      ? palette.map(({ fill }) => {
          const button = swatchButton(fill, "swatch");
          button.setAttribute("role", "listitem");
          button.setAttribute("aria-label", `Edit color ${fill}`);
          button.title = state.colorEdits.has(fill)
            ? `${fill} changed to ${editedFill(fill)}`
            : fill;
          button.classList.toggle("edited", state.colorEdits.has(fill));
          button.setAttribute("aria-pressed", String(fill === editing));
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
      button.setAttribute("aria-label", `Edit color ${fill}, now ${value}`);
      const from = document.createElement("span");
      from.className = "palette-chip";
      from.style.background = fill;
      const to = document.createElement("span");
      to.className = "palette-chip";
      to.style.background = value;
      const label = document.createElement("code");
      label.textContent = `${fill} to ${value}`;
      button.append(from, to, label);
      button.addEventListener("click", () => openEditor(fill));
      item.append(button);
      return item;
    }),
  );
  els.paletteResetAll.disabled = edited === 0;
}

/** Show `hex` in every editor field except `source`, the one being typed in. */
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
  const invalid = (input) => input.getAttribute("aria-invalid") === "true";
  let message = "";
  if (invalid(els.paletteHex)) message = "Use six hex digits, like #336699.";
  else if ([els.paletteR, els.paletteG, els.paletteB].some(invalid)) {
    message = "Use a whole number from 0 to 255.";
  }
  paletteError.textContent = message;
  paletteError.hidden = !message;
}

function openEditor(fill) {
  editing = fill;
  els.paletteEditor.hidden = false;
  els.paletteOriginalSwatch.style.background = fill;
  els.paletteOriginalHex.textContent = fill;
  syncFields(editedFill(fill));
  renderPalette();
}

function closeEditor() {
  editing = null;
  els.paletteEditor.hidden = true;
  renderPalette();
}

/** Record `hex` as the edit for the open color; equal to the original clears it. */
function applyEdit(hex) {
  if (!editing) return;
  if (hex === editing) state.colorEdits.delete(editing);
  else state.colorEdits.set(editing, hex);
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
  syncFields(editing);
  applyEdit(editing);
});
els.paletteClose.addEventListener("click", closeEditor);
els.paletteResetAll.addEventListener("click", () => {
  state.colorEdits.clear();
  if (editing) syncFields(editing);
  renderPalette();
  scheduleRefresh();
  els.status.textContent = "All color edits reset.";
});

// -- Eyedropper on the result -----------------------------------------

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
  if (e.key === "Escape" && state.palettePicking) setPalettePick(false);
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
  state.paletteColors = [];
  state.paletteMapping = null;
  setPalettePick(false);
  closeEditor();
}

renderPalette();
