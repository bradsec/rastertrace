import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeEdits,
  mergeGroups,
  nearestFill,
  paletteMapping,
  PALETTE_GRID_MAX,
  pickColor,
  pruneEdits,
  rasterPalette,
  recolorSvg,
  snapFills,
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

test("grid threshold is 32 colors", () => {
  assert.equal(PALETTE_GRID_MAX, 32);
});

test("stencilFill maps stencil raster samples through the ink", () => {
  // The worker's stencil raster is always black ink on white; white ink
  // only swaps fills in the SVG, so raster black is the #FFFFFF shape.
  assert.equal(stencilFill([0, 0, 0], "white"), "#FFFFFF");
  // No backing behind white ink either: background samples pick nothing.
  assert.equal(stencilFill([255, 255, 255], "white"), null);
  assert.equal(stencilFill([0, 0, 0], "black"), "#000000");
  assert.equal(stencilFill([255, 255, 255], "black"), null);
});

test("rasterPalette counts opaque colors, most used first", () => {
  const img = {
    width: 4,
    height: 1,
    data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 9, 9, 9, 0]),
  };
  assert.deepEqual(rasterPalette(img), [
    { fill: "#FF0000", count: 2 },
    { fill: "#0000FF", count: 1 },
  ]);
});

test("rasterPalette returns null above the color cap", () => {
  const img = {
    width: 3,
    height: 1,
    data: new Uint8ClampedArray([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255]),
  };
  assert.equal(rasterPalette(img, 2), null);
  assert.equal(rasterPalette(null), null);
});

test("paletteMapping sends near-duplicate fills to their palette color", () => {
  // vtracer averages each region's pixels, so one quantized color comes
  // back as several slightly different fills.
  const svg = `<path fill="#14222D"/><path fill="#15232e"/><path fill="#020203"/><path fill="#050505"/>`;
  const mapping = paletteMapping(svg, [{ fill: "#14222D" }, { fill: "#020203" }]);
  assert.equal(mapping.get("#15232E"), "#14222D");
  assert.equal(mapping.get("#050505"), "#020203");
  assert.equal(mapping.get("#14222D"), "#14222D");
});

test("snapFills leaves only palette colors in the SVG", () => {
  const svg = `<svg><path fill="#14222D"/><path fill="#15232e"/><g fill="#050505"><path fill="none"/></g></svg>`;
  assert.equal(
    snapFills(svg, [{ fill: "#14222D" }, { fill: "#020203" }]),
    `<svg><path fill="#14222D"/><path fill="#14222D"/><g fill="#020203"><path fill="none"/></g></svg>`,
  );
});

test("recolorSvg with a mapping recolors every fill of the edited color", () => {
  const svg = `<path fill="#14222D"/><path fill="#15232E"/><path fill="#020203"/>`;
  const mapping = new Map([
    ["#14222D", "#14222D"],
    ["#15232E", "#14222D"],
    ["#020203", "#020203"],
  ]);
  assert.equal(
    recolorSvg(svg, new Map([["#14222D", "#ADD8E6"]]), mapping),
    `<path fill="#ADD8E6"/><path fill="#ADD8E6"/><path fill="#020203"/>`,
  );
});

test("recolorSvg hides an exact fill with none", () => {
  assert.equal(
    recolorSvg('<path fill="#ff0000"/><path fill="#00FF00"/>', new Map([["#FF0000", "none"]])),
    '<path fill="none"/><path fill="#00FF00"/>',
  );
});

test("recolorSvg hides mapped fills on paths and groups", () => {
  const edits = new Map([["#FF0000", "none"]]);
  const mapping = new Map([
    ["#FE0000", "#FF0000"],
    ["#FD0000", "#FF0000"],
  ]);
  assert.equal(
    recolorSvg('<g fill="#fe0000"><path/></g><path fill="#FD0000"/>', edits, mapping),
    '<g fill="none"><path/></g><path fill="none"/>',
  );
});

test("pruneEdits keeps hidden edits when the palette is unchanged", () => {
  const edits = new Map([["#FF0000", "none"]]);
  assert.equal(pruneEdits(edits, [{ fill: "#FF0000" }]), 0);
  assert.equal(edits.get("#FF0000"), "none");
});

// Palette entries come sorted by area, largest first.
const AREA = [{ fill: "#3A2010" }, { fill: "#331811" }, { fill: "#2E1510" }, { fill: "#FFFFFF" }];

test("mergeGroups joins colors edited to the same value, largest first", () => {
  const edits = new Map([
    ["#331811", "#3A2010"],
    ["#2E1510", "#3A2010"],
  ]);
  assert.deepEqual(mergeGroups(AREA, edits), [
    { fill: "#3A2010", color: "#3A2010", members: ["#3A2010", "#331811", "#2E1510"] },
    { fill: "#FFFFFF", color: "#FFFFFF", members: ["#FFFFFF"] },
  ]);
});

test("mergeGroups keeps hidden colors apart and merges equal manual edits", () => {
  const edits = new Map([
    ["#3A2010", "none"],
    ["#331811", "none"],
    ["#2E1510", "#123456"],
    ["#FFFFFF", "#123456"],
  ]);
  assert.deepEqual(
    mergeGroups(AREA, edits).map((g) => g.members),
    [["#3A2010"], ["#331811"], ["#2E1510", "#FFFFFF"]],
  );
});

test("mergeEdits gives every chosen color the largest one's color", () => {
  const edits = new Map([["#331811", "none"]]);
  assert.equal(mergeEdits(edits, AREA, ["#2E1510", "#331811", "#3A2010"]), "#3A2010");
  assert.deepEqual(
    [...edits],
    [
      ["#331811", "#3A2010"],
      ["#2E1510", "#3A2010"],
    ],
  );
});

test("mergeEdits follows the largest color's own edit and skips hidden ones", () => {
  const edits = new Map([
    ["#3A2010", "none"],
    ["#331811", "#AA0000"],
  ]);
  assert.equal(mergeEdits(edits, AREA, ["#3A2010", "#331811", "#FFFFFF"]), "#AA0000");
  assert.equal(edits.get("#3A2010"), "#AA0000");
  assert.equal(edits.get("#FFFFFF"), "#AA0000");
  const merged = mergeGroups(AREA, edits).find((g) => g.members.length > 1);
  assert.deepEqual(merged.members, ["#3A2010", "#331811", "#FFFFFF"]);
});
