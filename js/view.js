// Zoom and pan: wheel zooms at the cursor, drag pans, two pointers
// pinch-zoom, buttons and keyboard step. Pointer handlers here must
// register after the selection and eraser handlers in cleanup-tools.js
// (which stop propagation while a tool is active), so app.js imports
// this module last.
import { els, hooks, state } from "./context.js?v=70";
import { renderSelection, renderSmoothPreview } from "./cleanup-tools.js?v=113";

const view = { scale: 1, tx: 0, ty: 0 };
const ZOOM_MIN = 0.001;
const ZOOM_MAX = 128;

function visiblePreviewImage() {
  return els.sourceView.hidden ? els.resultView : els.sourceView;
}

/**
 * Width of the drawn picture. Compare stretches both images over the whole
 * cell with object-fit: contain, so the box can be wider than the picture.
 * @param {HTMLImageElement} image
 */
function pictureWidth(image) {
  const rect = image.getBoundingClientRect();
  if (!image.naturalWidth || !image.naturalHeight) return rect.width;
  return Math.min(rect.width, (rect.height * image.naturalWidth) / image.naturalHeight);
}

function actualZoomPercent() {
  const displayWidth = pictureWidth(visiblePreviewImage());
  if (!state.sourceWidth || !displayWidth) return Math.round(view.scale * 100);
  return Math.round((displayWidth / state.sourceWidth) * 100);
}

function applyView() {
  els.panStage.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
  const fitted = view.scale === 1 && view.tx === 0 && view.ty === 0;
  els.zoomReset.textContent = fitted ? "Fit" : `${actualZoomPercent()}%`;
  // At Fit there is nothing to pan, so phones let one finger scroll the page.
  els.preview.classList.toggle("fitted", fitted);
  renderSelection();
  renderSmoothPreview();
  updateCompare();
}

export function resetView() {
  view.scale = 1;
  view.tx = 0;
  view.ty = 0;
  applyView();
}

/**
 * Zoom by factor, keeping the point (px, py) in preview coordinates fixed.
 * @param {number} factor
 * @param {number} px
 * @param {number} py
 */
function zoomAt(factor, px, py) {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.scale * factor));
  const f = next / view.scale;
  view.tx = px - (px - view.tx) * f;
  view.ty = py - (py - view.ty) * f;
  view.scale = next;
  applyView();
}

/**
 * @param {number} factor
 */
function zoomAtCenter(factor) {
  zoomAt(factor, els.preview.clientWidth / 2, els.preview.clientHeight / 2);
}

export function actualSizeView() {
  const image = visiblePreviewImage();
  if (!state.sourceWidth) return;
  resetView();
  const fittedWidth = pictureWidth(image);
  if (!fittedWidth) return;
  zoomAtCenter(state.sourceWidth / fittedWidth);
}

els.zoomIn.addEventListener("click", () => zoomAtCenter(1.5));
els.zoomOut.addEventListener("click", () => zoomAtCenter(1 / 1.5));
els.zoomReset.addEventListener("click", resetView);
/** @type {HTMLElement} */ (document.querySelector('[data-action="zoom-actual"]')).addEventListener(
  "click",
  actualSizeView,
);

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
      if (/** @type {TouchEvent} */ (e).touches.length > 1) e.preventDefault();
    },
    { passive: false },
  );
}

/**
 * @type {Record<string, [number, number]>}
 */
const PAN_KEYS = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };

els.preview.addEventListener("keydown", (e) => {
  const pan = PAN_KEYS[e.key];
  if (pan) {
    // Arrow keys move the view, like dragging: the keyboard alternative to
    // panning (WCAG 2.1.1). Shift takes larger steps.
    const step = e.shiftKey ? 160 : 40;
    view.tx += pan[0] * step;
    view.ty += pan[1] * step;
    applyView();
  } else if (e.key === "+" || e.key === "=") zoomAtCenter(1.5);
  else if (e.key === "-" || e.key === "_") zoomAtCenter(1 / 1.5);
  else if (e.key === "0") resetView();
  else return;
  e.preventDefault();
});

// One pointer pans; two pointers pinch-zoom around their midpoint (and
// pan with it, so the standard touch pinch-drag combo works). `gesture`
// holds the previous frame: { x, y } while panning, { dist, midX, midY }
// while pinching; deltas are applied incrementally.
/** @typedef {{ x: number, y: number }} PanGesture */
/** @typedef {{ dist: number, midX: number, midY: number }} PinchGesture */
const pointers = new Map();
/** @type {PanGesture | PinchGesture | null} */
let gesture = null;

function pinchState() {
  const [a, b] = [...pointers.values()];
  return {
    dist: Math.hypot(b.x - a.x, b.y - a.y),
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
  };
}

/** @param {PointerEvent} e */
function startPointer(e) {
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
}

els.preview.addEventListener("pointerdown", (e) => {
  if (
    state.picking ||
    state.palettePicking ||
    state.erasing ||
    state.blobFilling ||
    state.blobPicking ||
    state.smoothing ||
    e.button !== 0
  )
    return;
  startPointer(e);
});

// Holding Space pans with any tool active, like Illustrator's Hand tool.
// The window capture listener runs before the tools' preview listeners.
let spaceHeld = false;

/** @param {boolean} held */
function setSpacePan(held) {
  spaceHeld = held;
  els.preview.classList.toggle("space-pan", held);
}

// Text fields keep Space for typing. Elsewhere Space pans while the
// pointer is over the preview, even when a tool button kept focus (its
// Space press would otherwise toggle the tool), or when nothing else
// has focus.
const TYPING =
  'textarea, select, [contenteditable]:not([contenteditable="false"]), input:not([type="range"], [type="checkbox"], [type="radio"], [type="button"], [type="color"], [type="file"])';
let pointerOverPreview = false;
els.preview.addEventListener("pointerenter", () => (pointerOverPreview = true));
els.preview.addEventListener("pointerleave", () => (pointerOverPreview = false));

/** @param {EventTarget | null} target */
function spaceTarget(target) {
  if (target instanceof Element && target.matches(TYPING)) return false;
  return (
    pointerOverPreview ||
    target === null ||
    target === document.body ||
    (target instanceof Node && els.preview.contains(target))
  );
}

document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || !state.bitmap || !spaceTarget(e.target)) return;
  e.preventDefault();
  if (!e.repeat) setSpacePan(true);
});
// Buttons and checkboxes activate on Space keyup, so a pan's release
// must not reach them either.
document.addEventListener("keyup", (e) => {
  if (e.code !== "Space" || !spaceHeld) return;
  e.preventDefault();
  setSpacePan(false);
});
window.addEventListener("blur", () => setSpacePan(false));
window.addEventListener(
  "pointerdown",
  (e) => {
    if (!spaceHeld || e.button !== 0 || !(e.target instanceof Node)) return;
    if (!els.preview.contains(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    startPointer(e);
  },
  true,
);

// Cleanup tools own single touches, so a pinch that starts mid-stroke
// arrives here with its first finger already down.
hooks.startPinch = (first, second) => {
  pointers.clear();
  pointers.set(first.id, { x: first.x, y: first.y });
  pointers.set(second.pointerId, { x: second.clientX, y: second.clientY });
  gesture = pinchState();
  try {
    els.preview.setPointerCapture(second.pointerId);
  } catch {
    // synthetic events have no active pointer
  }
};

els.preview.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    const pan = /** @type {PanGesture} */ (gesture);
    view.tx += e.clientX - pan.x;
    view.ty += e.clientY - pan.y;
    gesture = { x: e.clientX, y: e.clientY };
    applyView();
  } else if (pointers.size === 2) {
    const now = pinchState();
    const rect = els.preview.getBoundingClientRect();
    const pinch = /** @type {PinchGesture} */ (gesture);
    if (pinch.dist > 0) {
      zoomAt(now.dist / pinch.dist, now.midX - rect.left, now.midY - rect.top);
    }
    view.tx += now.midX - pinch.midX;
    view.ty += now.midY - pinch.midY;
    applyView();
    gesture = now;
  }
});

for (const type of ["pointerup", "pointercancel"]) {
  els.preview.addEventListener(type, (e) => {
    if (!pointers.delete(/** @type {PointerEvent} */ (e).pointerId)) return;
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

// -- Compare: source left of the divider, result right ------------------

// The divider sits at a fixed screen position (percent of the preview
// width) while zoom and pan move the stacked images under it, so each
// image's clip is recomputed from where the divider crosses its box.
const COMPARE_KEY = "rastertrace:compare-split";
let split = 50;
try {
  const stored = Number(localStorage.getItem(COMPARE_KEY));
  if (localStorage.getItem(COMPARE_KEY) !== null && stored >= 0 && stored <= 100) split = stored;
} catch {
  // storage blocked: start centered
}

function updateCompare() {
  if (els.compareDivider.hidden) {
    els.sourceView.style.clipPath = "";
    els.resultView.style.clipPath = "";
    return;
  }
  els.compareDivider.style.left = `${split}%`;
  const preview = els.preview.getBoundingClientRect();
  const box = els.resultView.getBoundingClientRect();
  const x = preview.left + (preview.width * split) / 100;
  const edge = box.width ? Math.min(100, Math.max(0, ((x - box.left) / box.width) * 100)) : 50;
  els.sourceView.style.clipPath = `inset(0 ${100 - edge}% 0 0)`;
  els.resultView.style.clipPath = `inset(0 0 0 ${edge}%)`;
}
hooks.updateCompare = updateCompare;

/**
 * @param {number} value percent of the preview width
 * @param {boolean} [persist]
 */
function setSplit(value, persist) {
  split = Math.min(100, Math.max(0, value));
  els.preview.style.setProperty("--compare-split", `${split}%`);
  const now = Math.round(split);
  els.compareHandle.setAttribute("aria-valuenow", String(now));
  els.compareHandle.setAttribute("aria-valuetext", `${now}% source, ${100 - now}% result`);
  updateCompare();
  if (!persist) return;
  try {
    localStorage.setItem(COMPARE_KEY, String(split));
  } catch {
    // storage blocked: the position lasts until reload
  }
}
setSplit(split, false);

/**
 * @type {Record<string, number>}
 */
const SPLIT_KEYS = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };

els.compareHandle.addEventListener("keydown", (e) => {
  const step = SPLIT_KEYS[e.key];
  const now = Math.round(split);
  if (step) setSplit(now + step * (e.shiftKey ? 10 : 1), true);
  else if (e.key === "PageUp") setSplit(now + 10, true);
  else if (e.key === "PageDown") setSplit(now - 10, true);
  else if (e.key === "Home") setSplit(0, true);
  else if (e.key === "End") setSplit(100, true);
  else return;
  // The preview's own arrow keys pan; this press belongs to the divider.
  e.preventDefault();
  e.stopPropagation();
});

// Phones hit only the handle (CSS), so one finger elsewhere still
// scrolls the page or pans; mouse users can grab the whole line.
/** @type {number | null} */
let dragId = null;

/** @param {PointerEvent} e */
function splitFromPointer(e) {
  const rect = els.preview.getBoundingClientRect();
  if (rect.width) setSplit(((e.clientX - rect.left) / rect.width) * 100, false);
}

els.compareDivider.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  // Bubbling to the preview would start a pan.
  e.stopPropagation();
  e.preventDefault();
  dragId = e.pointerId;
  els.compareHandle.focus({ preventScroll: true });
  try {
    els.compareDivider.setPointerCapture(e.pointerId);
  } catch {
    // synthetic events have no active pointer
  }
  splitFromPointer(e);
});

els.compareDivider.addEventListener("pointermove", (e) => {
  if (e.pointerId === dragId) splitFromPointer(e);
});

for (const type of ["pointerup", "pointercancel"]) {
  els.compareDivider.addEventListener(type, (e) => {
    if (/** @type {PointerEvent} */ (e).pointerId !== dragId) return;
    dragId = null;
    setSplit(split, true);
  });
}

new ResizeObserver(updateCompare).observe(els.preview);
