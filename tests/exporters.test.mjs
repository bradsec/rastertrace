import test from "node:test";
import assert from "node:assert/strict";
import { sharedContext } from "./shared-state.mjs";

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

const { state } = await sharedContext("exporters.js");
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

test("export file names get an _rt suffix so they never overwrite the source", async () => {
  let suggested;
  window.showSaveFilePicker = async (options) => {
    suggested = options.suggestedName;
    throw Object.assign(new Error("cancelled"), { name: "AbortError" });
  };
  state.fileName = "logo.png";
  state.svgRaw = '<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>';
  state.svg = state.svgRaw;
  state.eraseStrokes = [];

  await elements.get("download").listener("click")();
  assert.equal(suggested, "logo_rt.svg");

  // The accessible <title> keeps the plain stem: it names the artwork, not
  // the file it is written to.
  await elements.get("copy-svg").listener("click")();
  assert.match(copied, /<title>logo<\/title>/);
});

test("export file names handle a source with no extension", async () => {
  let suggested;
  window.showSaveFilePicker = async (options) => {
    suggested = options.suggestedName;
    throw Object.assign(new Error("cancelled"), { name: "AbortError" });
  };
  state.fileName = "clipboard";
  state.svgRaw = '<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>';
  state.svg = state.svgRaw;
  state.eraseStrokes = [];

  await elements.get("download").listener("click")();
  assert.equal(suggested, "clipboard_rt.svg");
});
