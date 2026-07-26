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
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    listener(type) {
      return listeners.get(type);
    },
  };
}

const elements = new Map();
globalThis.window = {};
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  },
  querySelector() {
    return element();
  },
  querySelectorAll() {
    return [];
  },
};

let copied = "";
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    clipboard: {
      async writeText(value) {
        copied = value;
      },
    },
  },
});

// The query must match the specifier exporters.js uses: Node keys its module
// cache on the full specifier, so a mismatch hands the test a second, unused
// copy of the shared state object.
const { state } = await import("../js/context.js?v=7");
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

test("SVG export snapshots content before the save picker opens", async () => {
  let resolvePicker;
  let written;
  window.showSaveFilePicker = () =>
    new Promise((resolve) => {
      resolvePicker = resolve;
    });
  state.fileName = "first.png";
  state.svgRaw = '<svg viewBox="0 0 10 10"><path id="first" d="M0 0"/></svg>';
  state.svg = state.svgRaw;
  state.eraseStrokes = [];

  const exporting = elements.get("download").listener("click")();
  await Promise.resolve();
  state.fileName = "second.png";
  state.svgRaw = '<svg viewBox="0 0 20 20"><path id="second" d="M0 0"/></svg>';
  resolvePicker({
    name: "first.svg",
    async createWritable() {
      return {
        async close() {},
        async write(blob) {
          written = await blob.text();
        },
      };
    },
  });
  await exporting;

  assert.match(written, /id="first"/);
  assert.doesNotMatch(written, /id="second"/);
});
