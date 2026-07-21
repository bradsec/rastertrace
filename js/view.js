// Zoom and pan: wheel zooms at the cursor, drag pans, two pointers
// pinch-zoom, buttons and keyboard step. Pointer handlers here must
// register after the selection and eraser handlers in cleanup-tools.js
// (which stop propagation while a tool is active), so app.js imports
// this module last.
import { els, state } from "./context.js?v=2";
import { renderSelection } from "./cleanup-tools.js?v=3";

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
  els.zoomReset.textContent = view.scale === 1 && view.tx === 0 && view.ty === 0
    ? "Fit"
    : `${actualZoomPercent()}%`;
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
  if (state.picking || state.erasing || e.button !== 0) return;
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
