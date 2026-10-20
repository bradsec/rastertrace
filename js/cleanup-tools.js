// Cleanup tools: eyedropper background sampling, marquee, polygon lasso
// and magic wand selections, and the vector eraser with its undo/redo stack.
// Listener order matters: the selection and eraser pointer handlers must
// register before the pan handlers in view.js, so app.js imports this
// module first.
import { brushSizeForShortcut, snapPointToAngle, svgViewBox } from "./eraser.js?v=11";
import { parseHexColor, sampleRasterColor, toHexColor, tracePixels } from "./preprocess.js?v=76";
import { els, hooks, state } from "./context.js?v=49";
import { floodRegion, growMask, maskLoops, unionMasks } from "./magicwand.js?v=28";
import { refreshExport } from "./exporters.js?v=58";

/** @param {"result" | "source" | "compare"} view */
export function setView(view) {
  if (view !== "result") {
    if (state.erasing) setEraser(false);
    if (state.blobFilling) setBlobFill(false);
    clearSelection();
    setSelectionTool(null);
  }
  els.showResult.setAttribute("aria-pressed", String(view === "result"));
  els.showSource.setAttribute("aria-pressed", String(view === "source"));
  els.showCompare.setAttribute("aria-pressed", String(view === "compare"));
  els.resultView.hidden = view === "source";
  els.sourceView.hidden = view === "result";
  els.compareDivider.hidden = view !== "compare";
  els.preview.classList.toggle("comparing", view === "compare");
  els.preview.classList.toggle("showing-source", view === "source");
  hooks.updateCompare();
}

/**
 * After an edit, swap Source for Result so the change shows: on the
 * original it would look like nothing happened. Compare already shows the
 * result, and the eyedropper needs the source.
 */
export function showResultOverSource() {
  if (els.resultView.hidden && !state.picking) setView("result");
}

// -- Eyedropper: arm, click the source image to sample, Esc cancels ----

// The knockout runs against the worker's preprocessed pixels (grayscale,
// denoise, palette reduction), so the eyedropper samples and previews
// that raster instead of the original bitmap: a color picked off the
// untouched original may no longer exist once the palette is reduced,
// leaving the background only partly removed.
let pickUrl = null;
let pickToken = 0;

function clearPickPreview() {
  pickToken++;
  if (pickUrl) {
    URL.revokeObjectURL(pickUrl);
    pickUrl = null;
  }
  if (state.sourceUrl) els.sourceView.src = state.sourceUrl;
}

async function showPickPreview() {
  const raster = state.processedRaster;
  if (!raster?.data || !raster.width || !raster.height) return;
  const token = ++pickToken;
  const canvas = new OffscreenCanvas(raster.width, raster.height);
  canvas
    .getContext("2d")
    .putImageData(new ImageData(raster.data, raster.width, raster.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  // A newer arm/disarm may have landed while the blob encoded.
  if (token !== pickToken || !state.picking) return;
  pickUrl = URL.createObjectURL(blob);
  els.sourceView.src = pickUrl;
}

export function setEyedropper(armed) {
  state.picking = armed;
  els.pickFromImage.setAttribute("aria-pressed", String(armed));
  els.preview.classList.toggle("picking", armed);
  if (armed) {
    hooks.cancelPalettePick();
    setView("source");
    showPickPreview();
    els.status.textContent = "Click the image to sample the background color. Esc cancels.";
  } else {
    clearPickPreview();
    els.status.textContent = "";
  }
}

els.pickFromImage.addEventListener("click", () => setEyedropper(!state.picking));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.picking) setEyedropper(false);
});

export function deactivateCleanupTools() {
  const active =
    state.picking ||
    state.palettePicking ||
    state.erasing ||
    state.blobFilling ||
    state.blobPicking ||
    state.selection ||
    state.selectionTool;
  if (!active) return;
  if (state.picking) setEyedropper(false);
  hooks.cancelPalettePick();
  setEraser(false);
  setBlobFill(false);
  clearSelection();
  setSelectionTool(null);
  els.status.textContent = "";
}

document.addEventListener(
  "pointerdown",
  (event) => {
    if (!(event.target instanceof Element)) return;
    if (
      event.target.closest(
        ".tool-rail, .tool-options, #preview, #pick-from-image, #selection-actions",
      )
    )
      return;
    deactivateCleanupTools();
  },
  { capture: true },
);

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const bracketDirection =
    event.key === "]" || event.code === "BracketRight"
      ? 1
      : event.key === "[" || event.code === "BracketLeft"
        ? -1
        : 0;
  const rangeFocused = target instanceof HTMLInputElement && target.type === "range";
  if (
    bracketDirection &&
    (state.erasing || state.blobFilling) &&
    (!(target instanceof HTMLElement) ||
      rangeFocused ||
      !(/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable))
  ) {
    event.preventDefault();
    setEraserSize(
      brushSizeForShortcut(
        Number(els.eraserSize.value),
        bracketDirection > 0,
        Number(els.eraserSize.min),
        Number(els.eraserSize.max),
      ),
    );
    return;
  }
  // A focused slider (e.g. wand Tolerance) takes only arrow keys, so tool
  // shortcuts and Delete still act on the selection.
  const editing =
    target instanceof HTMLElement &&
    !rangeFocused &&
    (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable);
  if (editing) return;
  const key = event.key.toLowerCase();
  if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "e" && state.svg) {
    event.preventDefault();
    setEraser(!state.erasing);
  } else if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "b" && state.svg) {
    event.preventDefault();
    setBlobFill(!state.blobFilling);
  } else if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "m" && state.svg) {
    event.preventDefault();
    const tool = event.shiftKey
      ? state.selectionTool === "rect"
        ? "ellipse"
        : state.selectionTool === "ellipse"
          ? "rect"
          : "ellipse"
      : "rect";
    keepFinishedSelection();
    setSelectionTool(tool);
  } else if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "l" && state.svg) {
    event.preventDefault();
    keepFinishedSelection();
    setSelectionTool("polygon");
  } else if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "w" && state.svg) {
    event.preventDefault();
    keepFinishedSelection();
    setSelectionTool("wand");
  } else if (event.key === "Enter" && state.selection?.type === "polygon") {
    event.preventDefault();
    finishPolygon();
  } else if (event.key === "Escape" && (state.erasing || state.blobFilling || state.blobPicking)) {
    setEraser(false);
    setBlobFill(false);
  } else if (
    (event.key === "Escape" || (event.key === "Backspace" && !event.ctrlKey && !event.metaKey)) &&
    state.selection?.type === "polygon" &&
    !state.selection.finalized
  ) {
    event.preventDefault();
    state.selection.points.pop();
    state.selection.hover = null;
    if (!state.selection.points.length) abandonShape(state.selection.base);
    else renderSelection();
    els.status.textContent = state.selection
      ? "Last polygon point removed. Click to continue drawing."
      : "Polygon cleared. Click to start a new selection.";
  } else if (event.key === "Escape" && (state.selection || state.selectionTool)) {
    clearSelection();
    setSelectionTool(null);
  } else if (
    (event.ctrlKey || event.metaKey) &&
    event.key === "Backspace" &&
    state.selection?.finalized
  ) {
    event.preventDefault();
    commitSelection("fill");
  } else if (
    !event.ctrlKey &&
    !event.metaKey &&
    (event.key === "Delete" || event.key === "Backspace") &&
    state.selection?.finalized
  ) {
    event.preventDefault();
    commitSelection("erase");
  } else if (
    (event.ctrlKey || event.metaKey) &&
    (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z")) &&
    state.eraseRedo.length
  ) {
    event.preventDefault();
    els.eraserRedo.click();
  } else if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "z" &&
    state.eraseStrokes.length
  ) {
    event.preventDefault();
    els.eraserUndo.click();
  }
});

/** Sample the original bitmap, for the window before the first trace. */
function sampleBitmapColor(normalizedX, normalizedY) {
  const { width, height } = state.bitmap;
  const x = Math.min(width - 1, Math.max(0, Math.floor(normalizedX * width)));
  const y = Math.min(height - 1, Math.max(0, Math.floor(normalizedY * height)));
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(state.bitmap, x, y, 1, 1, 0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

els.sourceView.addEventListener("click", (e) => {
  if (!state.picking || !state.bitmap) return;
  const rect = els.sourceView.getBoundingClientRect();
  const normalizedX = (e.clientX - rect.left) / rect.width;
  const normalizedY = (e.clientY - rect.top) / rect.height;
  const color = /** @type {[number, number, number] | null} */ (
    state.processedRaster
      ? sampleRasterColor(state.processedRaster, normalizedX, normalizedY)
      : sampleBitmapColor(normalizedX, normalizedY)
  );
  if (!color) return;
  els.knockoutColor.value = toHexColor(color).toLowerCase();
  setEyedropper(false);
  setView("result");
  hooks.scheduleRetrace();
});

// -- Marquee and polygonal lasso selections ---------------------------

export function clearSelection() {
  state.selection = null;
  els.selectionOverlay.setAttribute("hidden", "");
  updateSelectionActions();
}

/** Buttons that finish a selection without a keyboard (WCAG 2.5.7). */
function updateSelectionActions() {
  const selection = state.selection;
  const ready = Boolean(selection?.finalized);
  const closable =
    selection?.type === "polygon" && !selection.finalized && selection.points.length >= 3;
  els.selectionClose.hidden = !closable;
  els.selectionErase.hidden = !ready;
  els.selectionFill.hidden = !ready;
  const hadFocus = els.selectionActions.contains(document.activeElement);
  els.selectionActions.hidden = !ready && !closable;
  // Committing hides the buttons; keep keyboard focus on the canvas.
  if (hadFocus && els.selectionActions.hidden) els.preview.focus({ preventScroll: true });
}

export function setSelectionTool(tool) {
  state.selectionTool = tool;
  if (tool) {
    hooks.cancelPalettePick();
    state.erasing = false;
    state.blobFilling = false;
    state.blobPicking = false;
    els.eraserTool.setAttribute("aria-pressed", "false");
    els.blobFillTool.setAttribute("aria-pressed", "false");
    els.blobFillPick.setAttribute("aria-pressed", "false");
    els.preview.classList.remove("erasing");
    els.preview.classList.remove("blob-filling", "blob-picking");
    els.eraserCursor.hidden = true;
    setView("result");
  }
  els.marqueeRect.setAttribute("aria-pressed", String(tool === "rect"));
  els.marqueeEllipse.setAttribute("aria-pressed", String(tool === "ellipse"));
  els.polygonLasso.setAttribute("aria-pressed", String(tool === "polygon"));
  els.magicWand.setAttribute("aria-pressed", String(tool === "wand"));
  els.preview.classList.toggle("selecting", Boolean(tool));
  updateSelectCursor();
  if (tool === "wand" && state.svg) {
    // Render ahead of the first click; a failure surfaces on that click.
    resultRaster().catch(() => {});
  } else if (tool !== "wand") {
    wandRaster = null;
  }
  if (tool === "wand") {
    els.status.textContent =
      "Click a color to select that connected area. Shift+click adds, Alt/Option+click subtracts.";
  } else if (tool === "polygon") {
    els.status.textContent =
      "Click around an area; double-click or press Enter to close. Shift or Alt/Option at the first click adds or subtracts.";
  } else if (tool) {
    els.status.textContent =
      "Drag to select. Shift or Alt/Option at the press adds or subtracts; pressed during the drag they make a square or circle, or draw from the center.";
  }
}

function marqueeGeometry(selection) {
  const box = svgViewBox(state.svgRaw || "");
  let dx = selection.current.x - selection.start.x;
  let dy = selection.current.y - selection.start.y;
  if (selection.constrain && box) {
    const side = Math.max(Math.abs(dx * box.width), Math.abs(dy * box.height));
    dx = (Math.sign(dx || 1) * side) / box.width;
    dy = (Math.sign(dy || 1) * side) / box.height;
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

const SVG_NS = "http://www.w3.org/2000/svg";

/** Overlay element for one finished shape, in overlay pixels. */
function shapeNode(shape, size) {
  if (shape.type === "rect") {
    const node = document.createElementNS(SVG_NS, "rect");
    node.setAttribute("x", String(shape.x * size.width));
    node.setAttribute("y", String(shape.y * size.height));
    node.setAttribute("width", String(shape.width * size.width));
    node.setAttribute("height", String(shape.height * size.height));
    return node;
  }
  if (shape.type === "ellipse") {
    const node = document.createElementNS(SVG_NS, "ellipse");
    node.setAttribute("cx", String(shape.cx * size.width));
    node.setAttribute("cy", String(shape.cy * size.height));
    node.setAttribute("rx", String(shape.rx * size.width));
    node.setAttribute("ry", String(shape.ry * size.height));
    return node;
  }
  return loopsNode(shape.type === "region" ? shape.loops : [shape.points], size);
}

function loopsNode(loops, size) {
  const node = document.createElementNS(SVG_NS, "path");
  node.setAttribute(
    "d",
    loops
      .map(
        (loop) =>
          loop.map((p, i) => `${i ? "L" : "M"}${p.x * size.width} ${p.y * size.height}`).join("") +
          "Z",
      )
      .join(""),
  );
  node.setAttribute("fill-rule", "evenodd");
  node.setAttribute("clip-rule", "evenodd");
  return node;
}

/** Built nodes per parts array: redraws while dragging reuse them. */
const partsNodes = new WeakMap();

/** One shape draws as itself; several draw as their merged outline. */
function partsNode(parts, size) {
  const cached = partsNodes.get(parts);
  if (cached?.width === size.width && cached.height === size.height) {
    return /** @type {Element} */ (cached.node.cloneNode());
  }
  const node =
    parts.length === 1 && parts[0].op === "add"
      ? shapeNode(parts[0].shape, size)
      : loopsNode(compositeOutline(parts), size);
  partsNodes.set(parts, { ...size, node: node.cloneNode() });
  return node;
}

function antsPair(node) {
  const dark = /** @type {Element} */ (node.cloneNode());
  dark.setAttribute("class", "selection-ants-dark");
  dark.setAttribute("vector-effect", "non-scaling-stroke");
  node.setAttribute("class", "selection-ants-light");
  node.setAttribute("vector-effect", "non-scaling-stroke");
  return [dark, node];
}

export function renderSelection() {
  const selection = state.selection;
  updateSelectionActions();
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
  const size = { width: imageRect.width, height: imageRect.height };
  let shape;
  if (selection.type === "composite") {
    shape = partsNode(selection.parts, size);
  } else if (selection.type === "polygon") {
    shape = document.createElementNS(SVG_NS, "polyline");
    const points = selection.hover ? [...selection.points, selection.hover] : selection.points;
    shape.setAttribute(
      "points",
      points.map((point) => `${point.x * size.width},${point.y * size.height}`).join(" "),
    );
  } else {
    shape = shapeNode(toShape(selection), size);
  }
  const selectionNodes = antsPair(shape);
  // While a shape is drawn, keep showing the parts it will join.
  if (selection.type !== "composite" && selection.base?.length) {
    selectionNodes.unshift(...antsPair(partsNode(selection.base, size)));
  }
  if (selection.finalized) {
    const defs = document.createElementNS(SVG_NS, "defs");
    const clipPath = document.createElementNS(SVG_NS, "clipPath");
    clipPath.id = "selection-image-edge-clip";
    clipPath.setAttribute("clipPathUnits", "userSpaceOnUse");
    const clipShape = /** @type {Element} */ (shape.cloneNode());
    clipShape.removeAttribute("class");
    clipShape.setAttribute("fill", "#fff");
    clipShape.setAttribute("stroke", "none");
    clipPath.appendChild(clipShape);
    defs.appendChild(clipPath);

    const edge = document.createElementNS(SVG_NS, "rect");
    edge.setAttribute("x", "0.75");
    edge.setAttribute("y", "0.75");
    edge.setAttribute("width", String(Math.max(0, imageRect.width - 1.5)));
    edge.setAttribute("height", String(Math.max(0, imageRect.height - 1.5)));
    edge.setAttribute("fill", "none");
    edge.setAttribute("clip-path", "url(#selection-image-edge-clip)");
    edge.setAttribute("vector-effect", "non-scaling-stroke");
    const darkEdge = /** @type {SVGRectElement} */ (edge.cloneNode());
    darkEdge.setAttribute("class", "selection-ants-dark");
    edge.setAttribute("class", "selection-ants-light");
    selectionNodes.unshift(defs);
    selectionNodes.push(darkEdge, edge);
  }
  els.selectionOverlay.replaceChildren(...selectionNodes);
  els.selectionOverlay.removeAttribute("hidden");
}

let renderFrame = 0;

/** Pointer moves can outpace the display: redraw at most once a frame. */
function scheduleRenderSelection() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    renderSelection();
  });
}

// -- Combining selections: Shift adds, Alt/Option subtracts -------------

/** Toolbar selection mode: "new", "add" or "subtract" (touch has no keys). */
let selectionMode = "new";

/** The operation a press starts: modifier keys win over the toolbar mode. */
function pressOp(event) {
  if (event.shiftKey) return "add";
  if (event.altKey) return "subtract";
  return selectionMode;
}

/** Finished parts the next shape combines with; "new" starts over. */
function baseParts(op) {
  return op !== "new" && state.selection?.type === "composite" ? state.selection.parts : [];
}

/** A finished marquee or lasso in the cleanup action format. */
function toShape(selection) {
  if (selection.type === "polygon") return { type: "polygon", points: selection.points };
  const g = marqueeGeometry(selection);
  if (selection.type === "ellipse") {
    return {
      type: "ellipse",
      cx: g.x + g.width / 2,
      cy: g.y + g.height / 2,
      rx: g.width / 2,
      ry: g.height / 2,
    };
  }
  return { type: "rect", ...g };
}

/** Add or subtract a finished shape and show the combined selection. */
function finishShape(op, base, shape) {
  if (op === "subtract" && !base.length) {
    clearSelection();
    els.status.textContent = "Nothing selected to subtract from.";
    return;
  }
  setComposite([...base, { op: op === "subtract" ? "subtract" : "add", shape }]);
}

/**
 * Switching selection tools keeps a finished selection, so a wand area can
 * be combined with a marquee; only a half-drawn shape is dropped.
 */
function keepFinishedSelection() {
  const selection = state.selection;
  if (selection && selection.type !== "composite") abandonShape(selection.base);
}

/** Drop a shape that went nowhere, keeping the parts drawn before it. */
function abandonShape(base) {
  if (base?.length) setComposite(base);
  else clearSelection();
}

function setComposite(parts) {
  const outline = parts.length > 1 ? compositeOutline(parts) : null;
  if (outline && !outline.length) {
    clearSelection();
    els.status.textContent = "Nothing is left selected after subtracting.";
    return;
  }
  state.selection = { type: "composite", parts, finalized: true };
  renderSelection();
  els.status.textContent =
    "Selection ready. Erase or fill it; Shift adds to it, Alt/Option subtracts.";
}

/** Traced outlines per parts array, so a drawn shape reuses its base's. */
const outlines = new WeakMap();

/**
 * Merged outline of several parts for the marching ants, traced from a
 * raster of them: SVG cannot union shapes. Display only; commits stay
 * vector masks.
 */
function compositeOutline(parts) {
  let outline = outlines.get(parts);
  if (!outline) {
    outline = traceOutline(parts);
    outlines.set(parts, outline);
  }
  return outline;
}

/** Normalized bounds of the added parts: subtracting never grows a selection. */
function addedBounds(parts) {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const include = (x, y) => {
    box.minX = Math.min(box.minX, x);
    box.minY = Math.min(box.minY, y);
    box.maxX = Math.max(box.maxX, x);
    box.maxY = Math.max(box.maxY, y);
  };
  for (const { op, shape } of parts) {
    if (op === "subtract") continue;
    if (shape.type === "rect") {
      include(shape.x, shape.y);
      include(shape.x + shape.width, shape.y + shape.height);
    } else if (shape.type === "ellipse") {
      include(shape.cx - Math.abs(shape.rx), shape.cy - Math.abs(shape.ry));
      include(shape.cx + Math.abs(shape.rx), shape.cy + Math.abs(shape.ry));
    } else {
      for (const loop of shape.type === "region" ? shape.loops : [shape.points]) {
        for (const p of loop) include(p.x, p.y);
      }
    }
  }
  return box;
}

function traceOutline(parts) {
  const width = state.processedRaster?.width || 1024;
  const height = state.processedRaster?.height || 1024;
  // Rasterize only the added parts' bounds, with a pixel of margin so the
  // trace sees their edges: the whole raster is up to 4096 px a side.
  const box = addedBounds(parts);
  const x0 = Math.max(0, Math.floor(box.minX * width) - 1);
  const y0 = Math.max(0, Math.floor(box.minY * height) - 1);
  const cropWidth = Math.min(width, Math.ceil(box.maxX * width) + 1) - x0;
  const cropHeight = Math.min(height, Math.ceil(box.maxY * height) + 1) - y0;
  if (!(cropWidth > 0 && cropHeight > 0)) return [];
  const canvas = new OffscreenCanvas(cropWidth, cropHeight);
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (
    canvas.getContext("2d", { willReadFrequently: true })
  );
  ctx.translate(-x0, -y0);
  ctx.scale(width, height);
  for (const { op, shape } of parts) {
    ctx.globalCompositeOperation = op === "subtract" ? "destination-out" : "source-over";
    ctx.beginPath();
    if (shape.type === "rect") {
      ctx.rect(shape.x, shape.y, shape.width, shape.height);
    } else if (shape.type === "ellipse") {
      ctx.ellipse(shape.cx, shape.cy, Math.abs(shape.rx), Math.abs(shape.ry), 0, 0, Math.PI * 2);
    } else {
      for (const loop of shape.type === "region" ? shape.loops : [shape.points]) {
        loop.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
      }
    }
    ctx.fill("evenodd");
  }
  const { data } = ctx.getImageData(0, 0, cropWidth, cropHeight);
  // Free the backing store now rather than at garbage collection: iOS
  // Safari caps total canvas memory, and every add or subtract traces anew.
  canvas.width = 0;
  canvas.height = 0;
  const mask = new Uint8Array(cropWidth * cropHeight);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  return maskLoops(mask, cropWidth, cropHeight, 1).map((loop) =>
    loop.map((p) => ({
      x: (x0 + p.x * cropWidth) / width,
      y: (y0 + p.y * cropHeight) / height,
    })),
  );
}

const modeButtons = {
  new: els.selModeNew,
  add: els.selModeAdd,
  subtract: els.selModeSubtract,
};

function setSelectionMode(mode) {
  selectionMode = mode;
  for (const [name, button] of Object.entries(modeButtons)) {
    button.setAttribute("aria-pressed", String(name === mode));
  }
  updateSelectCursor();
}

for (const [name, button] of Object.entries(modeButtons)) {
  button.addEventListener("click", () => setSelectionMode(name));
}

/** Show + or - beside the crosshair for the operation a press would start. */
function updateSelectCursor(event = null) {
  const op = event ? pressOp(event) : selectionMode;
  const armed = Boolean(state.selectionTool);
  els.preview.classList.toggle("sel-add", armed && op === "add");
  els.preview.classList.toggle("sel-subtract", armed && op === "subtract");
}

/** @param {KeyboardEvent} event */
function onModifierKey(event) {
  if (event.key === "Shift" || event.key === "Alt") updateSelectCursor(event);
}
document.addEventListener("keydown", onModifierKey);
document.addEventListener("keyup", onModifierKey);
window.addEventListener("blur", () => updateSelectCursor());
els.preview.addEventListener("pointermove", (event) => {
  if (state.selectionTool) updateSelectCursor(event);
});

function finishPolygon() {
  const selection = state.selection;
  if (selection?.type !== "polygon" || selection.points.length < 3) return;
  if (!selectionIntersectsImage(selection)) {
    abandonShape(selection.base);
    els.status.textContent = "Selection did not overlap the image.";
    return;
  }
  finishShape(selection.op, selection.base, toShape(selection));
}

function commitSelection(mode) {
  const selection = state.selection;
  if (selection?.type !== "composite") return;
  state.eraseRedo = [];
  const fill = mode === "fill" ? { mode: "fill", color: els.blobFillColor.value } : {};
  const { parts } = selection;
  const action =
    parts.length === 1 && parts[0].op === "add" ? parts[0].shape : { type: "composite", parts };
  state.eraseStrokes.push({ ...action, ...fill });
  clearSelection();
  refreshExport();
  els.status.textContent =
    mode === "fill"
      ? `Selected area filled with ${els.blobFillColor.value}. Ctrl/Cmd+Z restores it.`
      : "Selected area removed. Ctrl/Cmd+Z restores it.";
}

els.marqueeRect.addEventListener("click", () => {
  keepFinishedSelection();
  setSelectionTool("rect");
});
els.marqueeEllipse.addEventListener("click", () => {
  keepFinishedSelection();
  setSelectionTool("ellipse");
});
els.magicWand.addEventListener("click", () => {
  keepFinishedSelection();
  setSelectionTool("wand");
});
els.polygonLasso.addEventListener("click", () => {
  keepFinishedSelection();
  setSelectionTool("polygon");
});
els.selectionClose.addEventListener("click", finishPolygon);
els.selectionErase.addEventListener("click", () => commitSelection("erase"));
els.selectionFill.addEventListener("click", () => commitSelection("fill"));
els.selectionCancel.addEventListener("click", () => {
  clearSelection();
  els.status.textContent = "Selection cancelled.";
});

// -- Touch: a second finger hands the gesture to pinch-zoom -------------

/** The touch a tool is using, with how to undo what it started. */
let toolTouch = null;

function claimTouch(event, undo) {
  if (event.pointerType !== "touch") return;
  toolTouch = { id: event.pointerId, x: event.clientX, y: event.clientY, undo };
}

// Registered before the tool handlers below, so the second finger never
// starts a stroke or adds a point of its own. view.js cannot see the first
// finger (the tool stopped it), so it gets that position here.
els.preview.addEventListener(
  "pointerdown",
  (event) => {
    if (event.pointerType !== "touch" || !toolTouch || toolTouch.id === event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const first = toolTouch;
    toolTouch = null;
    first.undo();
    hooks.startPinch(first, event);
  },
  true,
);
els.preview.addEventListener(
  "pointermove",
  (event) => {
    if (toolTouch?.id !== event.pointerId) return;
    toolTouch.x = event.clientX;
    toolTouch.y = event.clientY;
  },
  true,
);
for (const type of ["pointerup", "pointercancel"]) {
  els.preview.addEventListener(
    type,
    (event) => {
      if (toolTouch?.id === /** @type {PointerEvent} */ (event).pointerId) toolTouch = null;
    },
    true,
  );
}

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
  return (
    bounds.x < 1 && bounds.y < 1 && bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0
  );
}

/** Select the connected region of the clicked color and combine it. */
async function wandSelect(point, op) {
  let raster;
  try {
    raster = await resultRaster();
  } catch (error) {
    console.error(error);
    els.status.textContent = "Could not read the result to select from. Try again.";
    return;
  }
  // The tool may have been switched while the result rendered.
  if (state.selectionTool !== "wand") return;
  const shape = regionShape(raster, [point]);
  if (!shape) {
    els.status.textContent =
      "No color here to select: that area is transparent or outside the image.";
    return;
  }
  finishShape(op, baseParts(op), shape);
}

/** Tolerance slider (0 to 50) as an Oklab distance (0 to 0.2). */
const wandTolerance = () => Number(els.wandTolerance.value) / 250;

/** The result as the wand last rendered it: { svg, pixels } or pending. */
let wandRaster = null;

/**
 * The result's pixels as displayed, so the wand selects the flat traced
 * shapes the user sees. The reduced raster can differ widely: at 256
 * colors it is not quantized at all, and tracing merges similar clusters.
 */
function resultRaster() {
  const svg = state.svg;
  if (wandRaster?.svg !== svg) {
    const pixels = renderResultRaster(svg);
    wandRaster = { svg, pixels };
    // A failed render is reported by the caller; the next click retries.
    pixels.catch(() => {
      if (wandRaster?.pixels === pixels) wandRaster = null;
    });
  }
  return wandRaster.pixels;
}

async function renderResultRaster(svg) {
  const box = svgViewBox(svg);
  const width = state.processedRaster?.width || Math.ceil(box?.width || 1024);
  const height = state.processedRaster?.height || Math.ceil(box?.height || 1024);
  // Without antialiasing, a shape's edge pixels keep its exact fill instead
  // of a blend with its neighbour that a low tolerance would stop at.
  const crisp = svg.replace(
    /<svg\b[^>]*>/,
    (tag) => `${tag}<style>*{shape-rendering:crispEdges}</style>`,
  );
  const url = URL.createObjectURL(new Blob([crisp], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = new OffscreenCanvas(width, height);
    const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (
      canvas.getContext("2d", { willReadFrequently: true })
    );
    ctx.drawImage(image, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height);
    // iOS Safari caps total canvas memory; free it now, not at collection.
    canvas.width = 0;
    canvas.height = 0;
    return pixels;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A wand region from its clicked points. Kept with the points, so changing
 * Tolerance, Expand or Smooth rebuilds the current selection in place.
 */
function regionShape(raster, seeds) {
  let mask = null;
  let width = 0;
  let height = 0;
  for (const seed of seeds) {
    const region = floodRegion(raster, seed.x, seed.y, wandTolerance());
    if (!region) continue;
    ({ width, height } = region);
    mask = mask ? unionMasks(mask, region.mask) : region.mask;
  }
  if (!mask) return null;
  // The raster is at trace scale; Expand and Smooth read the same at any.
  const scale = width / state.sourceWidth;
  const grown = growMask(mask, width, height, tracePixels(Number(els.wandExpand.value), scale));
  const loops = maskLoops(grown, width, height, tracePixels(Number(els.wandSmooth.value), scale));
  return { type: "region", seeds, loops };
}

/** Each rebuild floods every wand region again: one per frame is plenty. */
let wandRebuildFrame = 0;

for (const input of [els.wandTolerance, els.wandExpand, els.wandSmooth]) {
  input.addEventListener("input", () => {
    els.wandToleranceOut.textContent = els.wandTolerance.value;
    els.wandExpandOut.textContent = `${els.wandExpand.value} px`;
    els.wandSmoothOut.textContent = els.wandSmooth.value;
    if (state.selection?.type !== "composite" || wandRebuildFrame) return;
    wandRebuildFrame = requestAnimationFrame(async () => {
      wandRebuildFrame = 0;
      let raster;
      try {
        raster = await resultRaster();
      } catch (error) {
        console.error(error);
        els.status.textContent = "Could not read the result to select from. Try again.";
        return;
      }
      if (state.selection?.type !== "composite") return;
      setComposite(
        state.selection.parts.map((part) =>
          part.shape.type === "region"
            ? { ...part, shape: regionShape(raster, part.shape.seeds) ?? part.shape }
            : part,
        ),
      );
    });
  });
}

function constrainedPolygonPoint(point, shiftKey) {
  const selection = state.selection;
  if (!shiftKey || selection?.type !== "polygon" || !selection.points.length) return point;
  const box = svgViewBox(state.svgRaw || "");
  if (!box) return point;
  return snapPointToAngle(selection.points.at(-1), point, box.width, box.height);
}

els.preview.addEventListener(
  "pointerdown",
  (event) => {
    if (!state.selectionTool || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const point = selectionPoint(event, "free");
    // An active selection tool owns the whole preview, including the empty
    // canvas around the image, so selection gestures never pan the artwork.
    if (!point) return;
    const op = pressOp(event);
    if (state.selectionTool === "wand") {
      wandSelect(point, op);
      return;
    }
    if (state.selectionTool === "polygon") {
      if (event.detail > 1) {
        finishPolygon();
        return;
      }
      if (state.selection?.type !== "polygon") {
        const base = baseParts(op);
        state.selection = { type: "polygon", points: [], hover: null, finalized: false, op, base };
      }
      state.selection.points.push(
        constrainedPolygonPoint({ x: point.x, y: point.y }, event.shiftKey),
      );
      claimTouch(event, () => {
        const selection = state.selection;
        if (selection?.type !== "polygon" || selection.finalized) return;
        selection.points.pop();
        if (selection.points.length) renderSelection();
        else abandonShape(selection.base);
      });
      renderSelection();
      return;
    }
    const base = baseParts(op);
    state.selection = {
      type: state.selectionTool,
      start: { x: point.x, y: point.y },
      current: { x: point.x, y: point.y },
      constrain: false,
      fromCenter: false,
      // A key held at the press picks add or subtract; it constrains or
      // centers only once released and pressed again (Photoshop behavior).
      holdShift: event.shiftKey,
      holdAlt: event.altKey,
      finalized: false,
      op,
      base,
    };
    selectionPointer = event.pointerId;
    els.preview.setPointerCapture(event.pointerId);
    claimTouch(event, () => {
      selectionPointer = null;
      abandonShape(base);
    });
    renderSelection();
  },
  true,
);

els.preview.addEventListener(
  "dblclick",
  (event) => {
    if (state.selectionTool !== "polygon") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finishPolygon();
  },
  true,
);

els.preview.addEventListener(
  "pointermove",
  (event) => {
    if (
      state.selectionTool === "polygon" &&
      state.selection?.type === "polygon" &&
      !state.selection.finalized
    ) {
      // Null when the result image has collapsed to zero size; snapping
      // would dereference it.
      const point = selectionPoint(event, "free");
      state.selection.hover = point ? constrainedPolygonPoint(point, event.shiftKey) : null;
      scheduleRenderSelection();
    }
    if (selectionPointer !== event.pointerId || !state.selection) return;
    const point = selectionPoint(event, "free");
    if (!point) return;
    const selection = state.selection;
    selection.current = { x: point.x, y: point.y };
    if (!event.shiftKey) selection.holdShift = false;
    if (!event.altKey) selection.holdAlt = false;
    selection.constrain = event.shiftKey && !selection.holdShift;
    selection.fromCenter = event.altKey && !selection.holdAlt;
    scheduleRenderSelection();
  },
  true,
);

for (const type of ["pointerup", "pointercancel"]) {
  els.preview.addEventListener(
    type,
    (event) => {
      if (selectionPointer !== /** @type {PointerEvent} */ (event).pointerId) return;
      selectionPointer = null;
      const selection = state.selection;
      if (!selection || selection.type === "composite") return;
      const geometry = marqueeGeometry(selection);
      if (
        geometry.width < 0.001 ||
        geometry.height < 0.001 ||
        !selectionIntersectsImage(selection)
      ) {
        abandonShape(selection.base);
        return;
      }
      finishShape(selection.op, selection.base, toShape(selection));
    },
    true,
  );
}

// -- Vector eraser: normalized freehand strokes become an SVG mask -----

export function setEraser(active) {
  state.erasing = active && Boolean(state.svg);
  if (state.erasing) {
    hooks.cancelPalettePick();
    state.blobFilling = false;
    state.blobPicking = false;
    els.blobFillTool.setAttribute("aria-pressed", "false");
    els.blobFillPick.setAttribute("aria-pressed", "false");
    els.preview.classList.remove("blob-filling", "blob-picking");
    clearSelection();
    setSelectionTool(null);
  }
  els.eraserTool.setAttribute("aria-pressed", String(state.erasing));
  els.preview.classList.toggle("erasing", state.erasing);
  els.eraserCursor.hidden = true;
  if (state.erasing) {
    setView("result");
    els.status.textContent =
      "Drag over the vector to erase. [ and ] change the diameter. E or Esc exits.";
  }
}

export function setBlobFill(active) {
  state.blobFilling = active && Boolean(state.svg);
  state.blobPicking = false;
  if (state.blobFilling) {
    hooks.cancelPalettePick();
    state.erasing = false;
    els.eraserTool.setAttribute("aria-pressed", "false");
    els.preview.classList.remove("erasing");
    clearSelection();
    setSelectionTool(null);
  }
  els.blobFillTool.setAttribute("aria-pressed", String(state.blobFilling));
  els.blobFillPick.setAttribute("aria-pressed", "false");
  els.preview.classList.toggle("blob-filling", state.blobFilling);
  els.preview.classList.remove("blob-picking");
  els.eraserCursor.hidden = true;
  if (state.blobFilling) {
    setView("result");
    els.status.textContent =
      "Drag over the vector to paint. [ and ] change the diameter. B or Esc exits.";
  }
}

function setEraserSize(value) {
  const size = Math.min(
    Number(els.eraserSize.max),
    Math.max(Number(els.eraserSize.min), Math.round(value)),
  );
  els.eraserSize.value = String(size);
  els.eraserSizeOut.textContent = `${size} px`;
  previewBrushSize();
}

// Touch has no hover, so the brush circle never shows before a stroke.
// While the size changes, show it over the preview's centre (or where the
// pointer hovers), then hide it again unless a pointer is hovering.
let cursorHovering = false;
let sizePreviewTimer = 0;

function previewBrushSize() {
  if (!state.erasing && !state.blobFilling) return;
  const rect = els.resultView.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  if (!cursorHovering) {
    els.eraserCursor.style.left = `${els.preview.clientWidth / 2}px`;
    els.eraserCursor.style.top = `${els.preview.clientHeight / 2}px`;
  }
  sizeCleanupCursor(rect);
  els.eraserCursor.hidden = false;
  clearTimeout(sizePreviewTimer);
  sizePreviewTimer = window.setTimeout(() => {
    if (!cursorHovering) els.eraserCursor.hidden = true;
  }, 900);
}

/** @param {DOMRect} rect the result image's on-screen box */
function sizeCleanupCursor(rect) {
  const box = svgViewBox(state.svgRaw || "");
  const screenSize = box
    ? (Number(els.eraserSize.value) * rect.width) / box.width
    : Number(els.eraserSize.value);
  els.eraserCursor.style.width = `${screenSize}px`;
  els.eraserCursor.style.height = `${screenSize}px`;
}

els.eraserTool.addEventListener("click", () => setEraser(!state.erasing));
els.blobFillTool.addEventListener("click", () => setBlobFill(!state.blobFilling));
els.eraserSize.addEventListener("input", () => setEraserSize(Number(els.eraserSize.value)));

function setBlobColor(value) {
  const color = value.trim();
  if (!parseHexColor(color)) {
    els.blobFillHex.setAttribute("aria-invalid", "true");
    return false;
  }
  const normalized = `${color.startsWith("#") ? "" : "#"}${color}`.toLowerCase();
  els.blobFillColor.value = normalized;
  els.blobFillHex.value = normalized;
  els.blobFillHex.removeAttribute("aria-invalid");
  els.preview.style.setProperty("--blob-cursor-color", normalized);
  return true;
}

els.blobFillColor.addEventListener("input", () => setBlobColor(els.blobFillColor.value));
els.blobFillHex.addEventListener("change", () => {
  if (!setBlobColor(els.blobFillHex.value)) {
    els.status.textContent = "Enter a six-digit hex color such as #336699.";
  }
});
els.blobFillPick.addEventListener("click", () => {
  if (!state.svg) return;
  state.blobPicking = !state.blobPicking;
  if (state.blobPicking) {
    setBlobFill(true);
    state.blobPicking = true;
    els.blobFillPick.setAttribute("aria-pressed", "true");
    els.preview.classList.remove("blob-filling");
    els.preview.classList.add("blob-picking");
    els.status.textContent =
      "Place the eyedropper tip over a pixel and click to sample its fill color. Esc cancels.";
  } else {
    setBlobFill(true);
  }
});
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

function cleanupPoint(event) {
  const rect = els.resultView.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  return { x, y, rect };
}

function moveCleanupCursor(event) {
  if (!state.erasing && !state.blobFilling && !state.blobPicking) return;
  const point = cleanupPoint(event);
  cursorHovering = Boolean(point) && event.pointerType !== "touch";
  els.eraserCursor.hidden = !point;
  if (!point) return;
  const previewRect = els.preview.getBoundingClientRect();
  sizeCleanupCursor(point.rect);
  els.eraserCursor.style.left = `${event.clientX - previewRect.left}px`;
  els.eraserCursor.style.top = `${event.clientY - previewRect.top}px`;
}

let erasePointer = null;
let eraseStroke = null;
let eraseFrame = 0;

function redrawErasure() {
  if (eraseFrame) return;
  eraseFrame = requestAnimationFrame(() => {
    eraseFrame = 0;
    refreshExport();
  });
}

els.preview.addEventListener("pointerleave", () => {
  cursorHovering = false;
  els.eraserCursor.hidden = true;
});
els.preview.addEventListener("pointermove", (event) => {
  moveCleanupCursor(event);
  if (erasePointer !== event.pointerId) return;
  // Undo/redo shortcuts stay live during a drag, so the stroke this pointer
  // started can be popped off the stack mid-gesture. Drop the gesture then
  // instead of appending points to whatever action ended up last.
  if (state.eraseStrokes.at(-1) !== eraseStroke) {
    erasePointer = null;
    eraseStroke = null;
    return;
  }
  const point = cleanupPoint(event);
  if (!point) return;
  const previous = eraseStroke.points.at(-1);
  if (Math.hypot(point.x - previous.x, point.y - previous.y) < 0.001) return;
  eraseStroke.points.push({ x: point.x, y: point.y });
  redrawErasure();
});

els.preview.addEventListener(
  "pointerdown",
  (event) => {
    if (state.blobPicking || (!state.erasing && !state.blobFilling) || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const point = cleanupPoint(event);
    if (!point) return;
    const box = svgViewBox(state.svgRaw || "");
    if (!box) return;
    const redo = state.eraseRedo;
    state.eraseRedo = [];
    eraseStroke = {
      mode: state.blobFilling ? "fill" : "erase",
      ...(state.blobFilling ? { color: els.blobFillColor.value } : {}),
      diameter: Number(els.eraserSize.value) / Math.min(box.width, box.height),
      points: [{ x: point.x, y: point.y }],
    };
    const stroke = eraseStroke;
    state.eraseStrokes.push(stroke);
    erasePointer = event.pointerId;
    els.preview.setPointerCapture(event.pointerId);
    claimTouch(event, () => {
      if (state.eraseStrokes.at(-1) === stroke) state.eraseStrokes.pop();
      state.eraseRedo = redo;
      erasePointer = null;
      eraseStroke = null;
      refreshExport();
    });
    redrawErasure();
  },
  true,
);

els.preview.addEventListener(
  "pointerdown",
  (event) => {
    if (!state.blobPicking || event.button !== 0 || !state.processedRaster) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const point = cleanupPoint(event);
    if (!point || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return;
    const color = sampleRasterColor(state.processedRaster, point.x, point.y);
    if (!color) return;
    const [r, g, b] = color;
    setBlobColor(toHexColor([r, g, b]).toLowerCase());
    setBlobFill(true);
    els.status.textContent = `Fill color sampled: ${els.blobFillColor.value}.`;
  },
  true,
);

for (const type of ["pointerup", "pointercancel"]) {
  els.preview.addEventListener(
    type,
    (event) => {
      if (erasePointer !== /** @type {PointerEvent} */ (event).pointerId) return;
      erasePointer = null;
      eraseStroke = null;
      refreshExport();
    },
    true,
  );
}
