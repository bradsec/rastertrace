// Zoom and pan: wheel zooms at the cursor, drag pans, two pointers
// pinch-zoom, buttons and keyboard step. Pointer handlers here must
// register after the selection and eraser handlers in cleanup-tools.js
// (which stop propagation while a tool is active), so app.js imports
// this module last.
import { els, hooks, state } from "./context.js?v=26";
import { renderSelection } from "./cleanup-tools.js?v=41";

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
  const fitted = view.scale === 1 && view.tx === 0 && view.ty === 0;
  els.zoomReset.textContent = fitted ? "Fit" : `${actualZoomPercent()}%`;
  // At Fit there is nothing to pan, so phones let one finger scroll the page.
  els.preview.classList.toggle("fitted", fitted);
  renderSelection();
}

export function resetView() {
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

export function actualSizeView() {
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
      if (/** @type {TouchEvent} */ (e).touches.length > 1) e.preventDefault();
    },
    { passive: false },
  );
}

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
