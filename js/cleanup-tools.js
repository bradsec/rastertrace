// Cleanup tools: eyedropper background sampling, marquee and polygon
// lasso selections, and the vector eraser with its undo/redo stack.
// Listener order matters: the selection and eraser pointer handlers must
// register before the pan handlers in view.js, so app.js imports this
// module first.
import { snapPointToAngle, svgViewBox } from "./eraser.js?v=4";
import { toHexColor } from "./preprocess.js?v=42";
import { els, hooks, state } from "./context.js?v=2";
import { refreshExport } from "./exporters.js?v=3";

export function setView(view) {
  const showResult = view === "result";
  if (!showResult) {
    if (state.erasing) setEraser(false);
    clearSelection();
    setSelectionTool(null);
  }
  els.showResult.setAttribute("aria-pressed", String(showResult));
  els.showSource.setAttribute("aria-pressed", String(!showResult));
  els.resultView.hidden = !showResult;
  els.sourceView.hidden = showResult;
}

// -- Eyedropper: arm, click the source image to sample, Esc cancels ----

export function setEyedropper(armed) {
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

document.addEventListener("keydown", (event) => {
  const editing = /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName) || event.target.isContentEditable;
  if (editing) return;
  const key = event.key.toLowerCase();
  if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "e" && state.svg) {
    event.preventDefault();
    setEraser(!state.erasing);
  } else if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "m" && state.svg) {
    event.preventDefault();
    const tool = event.shiftKey
      ? (state.selectionTool === "rect" ? "ellipse" : state.selectionTool === "ellipse" ? "rect" : "ellipse")
      : "rect";
    clearSelection();
    setSelectionTool(tool);
  } else if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "l" && state.svg) {
    event.preventDefault();
    clearSelection();
    setSelectionTool("polygon");
  } else if (event.key === "Enter" && state.selection?.type === "polygon") {
    event.preventDefault();
    finishPolygon();
  } else if (event.key === "Escape" && state.erasing) {
    setEraser(false);
  } else if (event.key === "Escape" && state.selection?.type === "polygon" && !state.selection.finalized) {
    event.preventDefault();
    state.selection.points.pop();
    state.selection.hover = null;
    if (!state.selection.points.length) clearSelection();
    else renderSelection();
    els.status.textContent = state.selection
      ? "Last polygon point removed. Click to continue drawing."
      : "Polygon cleared. Click to start a new selection.";
  } else if (event.key === "Escape" && (state.selection || state.selectionTool)) {
    clearSelection();
    setSelectionTool(null);
  } else if ((event.key === "Delete" || event.key === "Backspace") && state.selection?.finalized) {
    event.preventDefault();
    deleteSelection();
  } else if (event.key === "[" || event.key === "]") {
    if (!state.erasing) return;
    event.preventDefault();
    const factor = event.key === "]" ? 1.2 : 1 / 1.2;
    setEraserSize(Number(els.eraserSize.value) * factor);
  } else if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z")) && state.eraseRedo.length) {
    event.preventDefault();
    els.eraserRedo.click();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && state.eraseStrokes.length) {
    event.preventDefault();
    els.eraserUndo.click();
  }
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
  hooks.scheduleRetrace();
});

// -- Marquee and polygonal lasso selections ---------------------------

export function clearSelection() {
  state.selection = null;
  els.selectionOverlay.setAttribute("hidden", "");
}

export function setSelectionTool(tool) {
  state.selectionTool = tool;
  if (tool) {
    state.erasing = false;
    els.eraserTool.setAttribute("aria-pressed", "false");
    els.preview.classList.remove("erasing");
    els.eraserCursor.hidden = true;
    setView("result");
  }
  els.marqueeRect.setAttribute("aria-pressed", String(tool === "rect"));
  els.marqueeEllipse.setAttribute("aria-pressed", String(tool === "ellipse"));
  els.polygonLasso.setAttribute("aria-pressed", String(tool === "polygon"));
  els.preview.classList.toggle("selecting", Boolean(tool));
  if (tool === "polygon") {
    els.status.textContent = "Click around an area. Hold Shift for 45° segments; double-click or press Enter to close.";
  } else if (tool) {
    els.status.textContent = "Drag anywhere in the preview. Hold Shift for a square or circle; Alt/Option draws from the center.";
  }
}

function marqueeGeometry(selection) {
  const box = svgViewBox(state.svgRaw || "");
  let dx = selection.current.x - selection.start.x;
  let dy = selection.current.y - selection.start.y;
  if (selection.constrain && box) {
    const side = Math.max(Math.abs(dx * box.width), Math.abs(dy * box.height));
    dx = Math.sign(dx || 1) * side / box.width;
    dy = Math.sign(dy || 1) * side / box.height;
  }
  const x2 = selection.start.x + dx;
  const y2 = selection.start.y + dy;
  if (selection.fromCenter) {
    return {
      x: selection.start.x - Math.abs(dx),
      y: selection.start.y - Math.abs(dy),
      width: Math.abs(dx) * 2,
      height: Math.abs(dy) * 2,
    };
  }
  return {
    x: Math.min(selection.start.x, x2),
    y: Math.min(selection.start.y, y2),
    width: Math.abs(dx),
    height: Math.abs(dy),
  };
}

export function renderSelection() {
  const selection = state.selection;
  if (!selection) {
    els.selectionOverlay.setAttribute("hidden", "");
    return;
  }
  const imageRect = els.resultView.getBoundingClientRect();
  const previewRect = els.preview.getBoundingClientRect();
  els.selectionOverlay.style.left = `${imageRect.left - previewRect.left}px`;
  els.selectionOverlay.style.top = `${imageRect.top - previewRect.top}px`;
  els.selectionOverlay.style.width = `${imageRect.width}px`;
  els.selectionOverlay.style.height = `${imageRect.height}px`;
  els.selectionOverlay.style.overflow = selection.finalized ? "hidden" : "visible";
  els.selectionOverlay.setAttribute("viewBox", `0 0 ${imageRect.width} ${imageRect.height}`);
  const px = (point) => ({ x: point.x * imageRect.width, y: point.y * imageRect.height });
  let shape;
  if (selection.type === "polygon") {
    shape = document.createElementNS("http://www.w3.org/2000/svg", selection.finalized ? "polygon" : "polyline");
    const points = selection.hover && !selection.finalized
      ? [...selection.points, selection.hover]
      : selection.points;
    shape.setAttribute("points", points.map((point) => {
      const screenPoint = px(point);
      return `${screenPoint.x},${screenPoint.y}`;
    }).join(" "));
  } else {
    const geometry = marqueeGeometry(selection);
    if (selection.type === "ellipse") {
      shape = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
      shape.setAttribute("cx", String((geometry.x + geometry.width / 2) * imageRect.width));
      shape.setAttribute("cy", String((geometry.y + geometry.height / 2) * imageRect.height));
      shape.setAttribute("rx", String(geometry.width * imageRect.width / 2));
      shape.setAttribute("ry", String(geometry.height * imageRect.height / 2));
    } else {
      shape = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      shape.setAttribute("x", String(geometry.x * imageRect.width));
      shape.setAttribute("y", String(geometry.y * imageRect.height));
      shape.setAttribute("width", String(geometry.width * imageRect.width));
      shape.setAttribute("height", String(geometry.height * imageRect.height));
    }
  }
  const darkAnts = shape.cloneNode();
  darkAnts.setAttribute("class", "selection-ants-dark");
  darkAnts.setAttribute("vector-effect", "non-scaling-stroke");
  shape.setAttribute("class", "selection-ants-light");
  shape.setAttribute("vector-effect", "non-scaling-stroke");
  const selectionNodes = [darkAnts, shape];
  if (selection.finalized) {
    const ns = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(ns, "defs");
    const clipPath = document.createElementNS(ns, "clipPath");
    clipPath.id = "selection-image-edge-clip";
    clipPath.setAttribute("clipPathUnits", "userSpaceOnUse");
    const clipShape = shape.cloneNode();
    clipShape.removeAttribute("class");
    clipShape.setAttribute("fill", "#fff");
    clipShape.setAttribute("stroke", "none");
    clipPath.appendChild(clipShape);
    defs.appendChild(clipPath);

    const edge = document.createElementNS(ns, "rect");
    edge.setAttribute("x", "0.75");
    edge.setAttribute("y", "0.75");
    edge.setAttribute("width", String(Math.max(0, imageRect.width - 1.5)));
    edge.setAttribute("height", String(Math.max(0, imageRect.height - 1.5)));
    edge.setAttribute("fill", "none");
    edge.setAttribute("clip-path", "url(#selection-image-edge-clip)");
    edge.setAttribute("vector-effect", "non-scaling-stroke");
    const darkEdge = edge.cloneNode();
    darkEdge.setAttribute("class", "selection-ants-dark");
    edge.setAttribute("class", "selection-ants-light");
    selectionNodes.unshift(defs);
    selectionNodes.push(darkEdge, edge);
  }
  els.selectionOverlay.replaceChildren(...selectionNodes);
  els.selectionOverlay.removeAttribute("hidden");
}

function finishPolygon() {
  if (state.selection?.type !== "polygon" || state.selection.points.length < 3) return;
  if (!selectionIntersectsImage(state.selection)) {
    clearSelection();
    els.status.textContent = "Selection did not overlap the image.";
    return;
  }
  state.selection.finalized = true;
  state.selection.hover = null;
  renderSelection();
  els.status.textContent = "Selection ready. Press Delete or Backspace to remove it.";
}

function deleteSelection() {
  const selection = state.selection;
  if (!selection?.finalized) return;
  state.eraseRedo = [];
  if (selection.type === "polygon") {
    state.eraseStrokes.push({ type: "polygon", points: selection.points });
  } else {
    const geometry = marqueeGeometry(selection);
    if (selection.type === "ellipse") {
      state.eraseStrokes.push({
        type: "ellipse",
        cx: geometry.x + geometry.width / 2,
        cy: geometry.y + geometry.height / 2,
        rx: geometry.width / 2,
        ry: geometry.height / 2,
      });
    } else {
      state.eraseStrokes.push({ type: "rect", ...geometry });
    }
  }
  clearSelection();
  refreshExport();
  els.status.textContent = "Selected area removed. Ctrl/Cmd+Z restores it.";
}

els.marqueeRect.addEventListener("click", () => { clearSelection(); setSelectionTool("rect"); });
els.marqueeEllipse.addEventListener("click", () => { clearSelection(); setSelectionTool("ellipse"); });
els.polygonLasso.addEventListener("click", () => { clearSelection(); setSelectionTool("polygon"); });

let selectionPointer = null;

function selectionPoint(event, mode = "strict") {
  const rect = els.resultView.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  if (mode === "strict" && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  if (mode === "free") return { x, y };
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

function selectionIntersectsImage(selection) {
  let bounds;
  if (selection.type === "polygon") {
    const xs = selection.points.map((point) => point.x);
    const ys = selection.points.map((point) => point.y);
    bounds = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  } else {
    bounds = marqueeGeometry(selection);
  }
  return bounds.x < 1 && bounds.y < 1 && bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0;
}

function constrainedPolygonPoint(point, shiftKey) {
  const selection = state.selection;
  if (!shiftKey || selection?.type !== "polygon" || !selection.points.length) return point;
  const box = svgViewBox(state.svgRaw || "");
  if (!box) return point;
  return snapPointToAngle(selection.points.at(-1), point, box.width, box.height);
}

els.preview.addEventListener("pointerdown", (event) => {
  if (!state.selectionTool || event.button !== 0) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const point = selectionPoint(event, "free");
  // An active selection tool owns the whole preview, including the empty
  // canvas around the image, so selection gestures never pan the artwork.
  if (!point) return;
  if (state.selectionTool === "polygon") {
    if (event.detail > 1) {
      finishPolygon();
      return;
    }
    if (!state.selection || state.selection.finalized) {
      state.selection = { type: "polygon", points: [], hover: null, finalized: false };
    }
    state.selection.points.push(constrainedPolygonPoint({ x: point.x, y: point.y }, event.shiftKey));
    renderSelection();
    return;
  }
  state.selection = {
    type: state.selectionTool,
    start: { x: point.x, y: point.y },
    current: { x: point.x, y: point.y },
    constrain: event.shiftKey,
    fromCenter: event.altKey,
    finalized: false,
  };
  selectionPointer = event.pointerId;
  els.preview.setPointerCapture(event.pointerId);
  renderSelection();
}, true);

els.preview.addEventListener("dblclick", (event) => {
  if (state.selectionTool !== "polygon") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  finishPolygon();
}, true);

els.preview.addEventListener("pointermove", (event) => {
  if (state.selectionTool === "polygon" && state.selection?.type === "polygon" && !state.selection.finalized) {
    const point = selectionPoint(event, "free");
    state.selection.hover = constrainedPolygonPoint(point, event.shiftKey);
    renderSelection();
  }
  if (selectionPointer !== event.pointerId || !state.selection) return;
  const point = selectionPoint(event, "free");
  if (!point) return;
  state.selection.current = { x: point.x, y: point.y };
  state.selection.constrain = event.shiftKey;
  state.selection.fromCenter = event.altKey;
  renderSelection();
}, true);

for (const type of ["pointerup", "pointercancel"]) {
  els.preview.addEventListener(type, (event) => {
    if (selectionPointer !== event.pointerId) return;
    selectionPointer = null;
    if (!state.selection) return;
    const geometry = marqueeGeometry(state.selection);
    if (geometry.width < 0.001 || geometry.height < 0.001 || !selectionIntersectsImage(state.selection)) {
      clearSelection();
      return;
    }
    state.selection.finalized = true;
    renderSelection();
    els.status.textContent = "Selection ready. Press Delete or Backspace to remove it.";
  }, true);
}

// -- Vector eraser: normalized freehand strokes become an SVG mask -----

export function setEraser(active) {
  state.erasing = active && Boolean(state.svg);
  if (state.erasing) {
    clearSelection();
    setSelectionTool(null);
  }
  els.eraserTool.setAttribute("aria-pressed", String(state.erasing));
  els.preview.classList.toggle("erasing", state.erasing);
  els.eraserCursor.hidden = true;
  if (state.erasing) {
    setView("result");
    els.status.textContent = "Drag over the vector to erase. [ and ] change the diameter. E or Esc exits.";
  }
}

function setEraserSize(value) {
  const size = Math.min(Number(els.eraserSize.max), Math.max(Number(els.eraserSize.min), Math.round(value)));
  els.eraserSize.value = String(size);
  els.eraserSizeOut.textContent = `${size} px`;
}

els.eraserTool.addEventListener("click", () => setEraser(!state.erasing));
els.eraserSize.addEventListener("input", () => setEraserSize(Number(els.eraserSize.value)));
els.eraserUndo.addEventListener("click", () => {
  const action = state.eraseStrokes.pop();
  if (!action) return;
  state.eraseRedo.push(action);
  refreshExport();
  els.status.textContent = "Cleanup action undone.";
});
els.eraserRedo.addEventListener("click", () => {
  const action = state.eraseRedo.pop();
  if (!action) return;
  state.eraseStrokes.push(action);
  refreshExport();
  els.status.textContent = "Cleanup action restored.";
});
els.eraserClear.addEventListener("click", () => {
  state.eraseStrokes = [];
  state.eraseRedo = [];
  clearSelection();
  refreshExport();
  els.status.textContent = "Original traced result restored.";
});

function eraserPoint(event) {
  const rect = els.resultView.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  return { x, y, rect };
}

function moveEraserCursor(event) {
  if (!state.erasing) return;
  const point = eraserPoint(event);
  els.eraserCursor.hidden = !point;
  if (!point) return;
  const previewRect = els.preview.getBoundingClientRect();
  const box = svgViewBox(state.svgRaw || "");
  const screenSize = box ? Number(els.eraserSize.value) * point.rect.width / box.width : Number(els.eraserSize.value);
  els.eraserCursor.style.width = `${screenSize}px`;
  els.eraserCursor.style.height = `${screenSize}px`;
  els.eraserCursor.style.left = `${event.clientX - previewRect.left}px`;
  els.eraserCursor.style.top = `${event.clientY - previewRect.top}px`;
}

let erasePointer = null;
let eraseFrame = 0;

function redrawErasure() {
  if (eraseFrame) return;
  eraseFrame = requestAnimationFrame(() => {
    eraseFrame = 0;
    refreshExport();
  });
}

els.preview.addEventListener("pointerleave", () => { els.eraserCursor.hidden = true; });
els.preview.addEventListener("pointermove", (event) => {
  moveEraserCursor(event);
  if (erasePointer !== event.pointerId) return;
  const point = eraserPoint(event);
  if (!point) return;
  const stroke = state.eraseStrokes.at(-1);
  const previous = stroke.points.at(-1);
  if (Math.hypot(point.x - previous.x, point.y - previous.y) < 0.001) return;
  stroke.points.push({ x: point.x, y: point.y });
  redrawErasure();
});

els.preview.addEventListener("pointerdown", (event) => {
  if (!state.erasing || event.button !== 0) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const point = eraserPoint(event);
  if (!point) return;
  const box = svgViewBox(state.svgRaw || "");
  if (!box) return;
  state.eraseRedo = [];
  state.eraseStrokes.push({
    diameter: Number(els.eraserSize.value) / Math.min(box.width, box.height),
    points: [{ x: point.x, y: point.y }],
  });
  erasePointer = event.pointerId;
  els.preview.setPointerCapture(event.pointerId);
  redrawErasure();
}, true);

for (const type of ["pointerup", "pointercancel"]) {
  els.preview.addEventListener(type, (event) => {
    if (erasePointer !== event.pointerId) return;
    erasePointer = null;
    refreshExport();
  }, true);
}
