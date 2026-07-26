import test from "node:test";
import assert from "node:assert/strict";
import { sharedContext } from "./shared-state.mjs";

// cleanup-tools.js wires pointer and keyboard handlers at import time, so the
// regression below needs a DOM stand-in rather than a pure function call. The
// stub keeps every listener registered for a type: #preview alone takes two
// pointerdown handlers, and a Map keyed by type would silently drop one.
function element(id) {
  const listeners = new Map();
  const attributes = new Map();
  return {
    id,
    value: "",
    min: "1",
    max: "500",
    checked: false,
    disabled: false,
    hidden: false,
    textContent: "",
    src: "",
    title: "",
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    setAttribute(name, next) {
      attributes.set(name, String(next));
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    replaceChildren() {},
    appendChild() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    closest: () => null,
    focus() {},
    click() {
      for (const listener of listeners.get("click") ?? []) listener({});
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }),
    dispatch(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    selectedOptions: [],
  };
}

const elements = new Map();
const documentListeners = new Map();
globalThis.window = {};
// The module guards keyboard shortcuts with `instanceof` checks, so the
// constructors have to exist. `tagName` is what those guards actually read.
globalThis.Element = class Element {
  tagName = "DIV";
};
globalThis.HTMLElement = class HTMLElement extends globalThis.Element {};
globalThis.HTMLInputElement = class HTMLInputElement extends globalThis.HTMLElement {
  type = "text";
};
globalThis.requestAnimationFrame = () => 1;
globalThis.URL.createObjectURL = () => "blob:stub";
globalThis.URL.revokeObjectURL = () => {};

globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  },
  querySelector: () => element("query"),
  querySelectorAll: () => [],
  createElementNS: () => element("svg-node"),
  addEventListener(type, listener) {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(listener);
  },
};

function dispatchDocument(type, event) {
  for (const listener of documentListeners.get(type) ?? []) listener(event);
}

const { state } = await sharedContext("cleanup-tools.js");
await import("../js/cleanup-tools.js?v=cleanup-test");

const preview = elements.get("preview");

function startErase() {
  state.svgRaw = '<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>';
  state.svg = state.svgRaw;
  state.eraseStrokes = [];
  state.eraseRedo = [];
  state.erasing = true;
  state.blobFilling = false;
  state.blobPicking = false;
  elements.get("eraser-size").value = "10";
  preview.dispatch("pointerdown", {
    button: 0,
    pointerId: 7,
    clientX: 100,
    clientY: 100,
    preventDefault() {},
    stopImmediatePropagation() {},
  });
}

function movePointer(pointerId, clientX) {
  preview.dispatch("pointermove", { pointerId, clientX, clientY: 100 });
}

test("CT-001: undo during an eraser drag does not corrupt the stroke stack", () => {
  startErase();
  assert.equal(state.eraseStrokes.length, 1, "pointerdown starts a stroke");

  movePointer(7, 140);
  assert.equal(state.eraseStrokes[0].points.length, 2, "moves extend the active stroke");

  // Ctrl+Z stays live during a drag and pops the stroke this pointer owns.
  dispatchDocument("keydown", {
    key: "z",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    code: "KeyZ",
    target: preview,
    preventDefault() {},
  });
  assert.equal(state.eraseStrokes.length, 0, "undo removed the in-progress stroke");

  // The drag continues. It must not throw and must not resurrect the stroke.
  assert.doesNotThrow(() => movePointer(7, 180));
  assert.equal(state.eraseStrokes.length, 0, "the abandoned gesture adds nothing back");
});

test("CT-001: undo mid-drag never appends to an unrelated action", () => {
  startErase();
  // A finalized marquee has no points array: the old code read .points on it.
  const marquee = { type: "rect", x: 0, y: 0, width: 0.5, height: 0.5 };
  state.eraseStrokes.unshift(marquee);
  assert.equal(state.eraseStrokes.length, 2);

  dispatchDocument("keydown", {
    key: "z",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    code: "KeyZ",
    target: preview,
    preventDefault() {},
  });
  assert.deepEqual(state.eraseStrokes, [marquee], "only the marquee remains");

  assert.doesNotThrow(() => movePointer(7, 180));
  assert.deepEqual(state.eraseStrokes, [marquee], "the marquee is untouched");
  assert.equal(marquee.points, undefined, "no points array was grafted onto it");
});

test("CT-001: an uninterrupted drag still records every move", () => {
  startErase();
  movePointer(7, 130);
  movePointer(7, 160);
  movePointer(7, 190);
  assert.equal(state.eraseStrokes.length, 1);
  assert.equal(state.eraseStrokes[0].points.length, 4);
});

// The knockout matches against the worker's preprocessed pixels, so a color
// picked off the untouched original can be absent from the reduced palette.
test("BG-001: the eyedropper samples the preprocessed raster, not the original", () => {
  state.bitmap = { width: 2, height: 2 };
  // Two flat palette colors: left half red, right half blue.
  state.processedRaster = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([200, 0, 0, 255, 0, 0, 200, 255, 200, 0, 0, 255, 0, 0, 200, 255]),
  };
  state.picking = true;
  state.sourceUrl = null;

  // The stub rect is 200x200, so clientX 150 lands in the right-hand column.
  elements.get("source-view").dispatch("click", { clientX: 150, clientY: 50 });

  assert.equal(elements.get("knockout-color").value, "#0000c8");
  assert.equal(state.picking, false, "sampling disarms the eyedropper");
});

test("BG-001: the eyedropper falls back to the bitmap before the first trace", () => {
  let drawn = null;
  globalThis.OffscreenCanvas = class {
    getContext() {
      return {
        drawImage(_bitmap, x, y) {
          drawn = { x, y };
        },
        getImageData: () => ({ data: new Uint8ClampedArray([17, 34, 51, 255]) }),
      };
    }
  };
  state.bitmap = { width: 4, height: 4 };
  state.processedRaster = null;
  state.picking = true;
  state.sourceUrl = null;

  elements.get("source-view").dispatch("click", { clientX: 150, clientY: 50 });

  assert.deepEqual(drawn, { x: 3, y: 1 }, "click maps to the bitmap pixel");
  assert.equal(elements.get("knockout-color").value, "#112233");
});
