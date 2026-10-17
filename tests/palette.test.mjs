import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nearestFill,
  PALETTE_GRID_MAX,
  pickColor,
  pruneEdits,
  recolorSvg,
  stencilFill,
  svgPalette,
} from "../js/palette.js";

test("svgPalette counts fills on paths, groups and rects, uppercased", () => {
  const svg =
    `<svg><rect fill="#000000"/><g fill="#ff0000"><path d="M0 0"/><path d="M1 1"/></g>` +
    `<path fill="#FF0000" d="M2 2"/><path fill="#00ff00" d="M3 3"/><path fill="none" d="M4 4"/></svg>`;
  assert.deepEqual(svgPalette(svg), [
    { fill: "#FF0000", count: 2 },
    { fill: "#000000", count: 1 },
    { fill: "#00FF00", count: 1 },
  ]);
});

test("recolorSvg swaps in one pass", () => {
  const svg = `<path fill="#FF0000"/><path fill="#0000FF"/>`;
  const edits = new Map([
    ["#FF0000", "#0000FF"],
    ["#0000FF", "#FF0000"],
  ]);
  assert.equal(recolorSvg(svg, edits), `<path fill="#0000FF"/><path fill="#FF0000"/>`);
});

test("recolorSvg matches fills case-insensitively", () => {
  assert.equal(
    recolorSvg(`<g fill="#ff0000">`, new Map([["#FF0000", "#123456"]])),
    `<g fill="#123456">`,
  );
});

test("recolorSvg returns input unchanged with no edits", () => {
  const svg = `<path fill="#abcdef"/>`;
  assert.equal(recolorSvg(svg, new Map()), svg);
});

test("nearestFill snaps to the closest palette color", () => {
  const palette = [{ fill: "#FF0000" }, { fill: "#0000FF" }];
  assert.equal(nearestFill([250, 10, 5], palette), "#FF0000");
  assert.equal(nearestFill([0, 0, 0], []), null);
});

test("pickColor returns null on transparent pixels", () => {
  const img = { width: 2, height: 1, data: new Uint8ClampedArray([10, 20, 30, 255, 0, 0, 0, 0]) };
  assert.deepEqual(pickColor(img, 0.1, 0.5), [10, 20, 30]);
  assert.equal(pickColor(img, 0.9, 0.5), null);
  assert.equal(pickColor(null, 0.5, 0.5), null);
});

test("pruneEdits drops only edits whose color left the palette", () => {
  const edits = new Map([
    ["#FF0000", "#000001"],
    ["#00FF00", "#000002"],
  ]);
  assert.equal(pruneEdits(edits, [{ fill: "#FF0000" }]), 1);
  assert.deepEqual([...edits.keys()], ["#FF0000"]);
});

test("grid threshold is 16 colors", () => {
  assert.equal(PALETTE_GRID_MAX, 16);
});

test("stencilFill maps stencil raster samples through the ink", () => {
  // The worker's stencil raster is always black ink on white; white ink
  // only swaps fills in the SVG, so raster black is the #FFFFFF shape.
  assert.equal(stencilFill([0, 0, 0], "white"), "#FFFFFF");
  assert.equal(stencilFill([255, 255, 255], "white"), "#000000");
  assert.equal(stencilFill([0, 0, 0], "black"), "#000000");
  assert.equal(stencilFill([255, 255, 255], "black"), null);
});
