import test from "node:test";
import assert from "node:assert/strict";

function element() {
  const listeners = new Map();
  return {
    value: "",
    checked: false,
    disabled: false,
    textContent: "",
    src: "",
    title: "",
    addEventListener(type, listener) { listeners.set(type, listener); },
    listener(type) { return listeners.get(type); },
  };
}

const elements = new Map();
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  },
  querySelector() { return element(); },
  querySelectorAll() { return []; },
};

let copied = "";
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { clipboard: { async writeText(value) { copied = value; } } },
});

const { state } = await import("../js/context.js?v=2");
await import("../js/exporters.js?v=test");

test("copy SVG rebuilds cleanup instead of using stale export state", async () => {
  state.fileName = "test.png";
  state.svgRaw = '<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>';
  state.svg = state.svgRaw;
  state.eraseStrokes = [{ diameter: 0.2, points: [{ x: 0.5, y: 0.5 }] }];

  await elements.get("copy-svg").listener("click")();

  assert.match(copied, /mask-type="luminance"/);
  assert.match(copied, /<circle cx="50" cy="50" r="10"/);
});
