import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCleanupActions,
  applyEraserMask,
  brushSizeForShortcut,
  snapPointToAngle,
  svgViewBox,
} from "../js/eraser.js";

test("brushSizeForShortcut changes every non-boundary keypress", () => {
  assert.equal(brushSizeForShortcut(2, true, 2, 240), 3);
  assert.equal(brushSizeForShortcut(3, false, 2, 240), 2);
  assert.equal(brushSizeForShortcut(32, true, 2, 240), 38);
  assert.equal(brushSizeForShortcut(32, false, 2, 240), 27);
  assert.equal(brushSizeForShortcut(240, true, 2, 240), 240);
  assert.equal(brushSizeForShortcut(2, false, 2, 240), 2);
});

test("svgViewBox reads comma and space separated values", () => {
  assert.deepEqual(svgViewBox('<svg viewBox="-2, 3, 100, 50"></svg>'), {
    x: -2,
    y: 3,
    width: 100,
    height: 50,
  });
});

test("applyEraserMask preserves untouched SVGs", () => {
  const svg = '<svg viewBox="0 0 100 50"><path d="M0 0"/></svg>';
  assert.equal(applyEraserMask(svg, []), svg);
});

test("applyEraserMask adds normalized round strokes and wraps artwork", () => {
  const svg = '<svg viewBox="0 0 200 100"><path d="M0 0"/></svg>';
  const result = applyEraserMask(svg, [
    {
      diameter: 0.1,
      points: [
        { x: 0.25, y: 0.5 },
        { x: 0.75, y: 0.5 },
      ],
    },
  ]);
  assert.match(result, /<mask id="rastertrace-eraser-mask"/);
  assert.match(result, /mask-type="luminance"/);
  assert.match(result, /color-interpolation="sRGB"/);
  assert.match(result, /stroke-width="10"/);
  assert.match(result, /d="M50 50 L150 50"/);
  assert.match(result, /<g mask="url\(#rastertrace-eraser-mask\)"><path/);
});

test("applyEraserMask renders a click as a circular erasure", () => {
  const result = applyEraserMask('<svg viewBox="0 0 80 40"></svg>', [
    {
      diameter: 0.25,
      points: [{ x: 0.5, y: 0.5 }],
    },
  ]);
  assert.match(result, /<circle cx="40" cy="20" r="5"/);
});

test("applyEraserMask snaps pixel-exact clicks to a square trace-pixel boundary", () => {
  const result = applyEraserMask(
    '<svg viewBox="0 0 80 40"></svg>',
    [
      {
        diameter: 0.25,
        points: [{ x: 0.506, y: 0.51 }],
      },
    ],
    { pixelExact: true },
  );
  assert.match(result, /<rect x="35" y="15" width="11" height="11"/);
  assert.match(result, /shape-rendering="crispEdges"/);
  assert.doesNotMatch(result, /<circle/);
});

test("applyEraserMask routes pixel-exact strokes along the trace-pixel grid", () => {
  const result = applyEraserMask(
    '<svg viewBox="0 0 20 10"></svg>',
    [
      {
        diameter: 0.1,
        points: [
          { x: 0.12, y: 0.22 },
          { x: 0.38, y: 0.67 },
        ],
      },
    ],
    { pixelExact: true },
  );
  assert.match(result, /d="M2\.5 2\.5H7\.5V6\.5"/);
  assert.match(result, /stroke-width="1"/);
  assert.match(result, /stroke-linecap="square"/);
  assert.match(result, /stroke-linejoin="miter"/);
});

test("applyEraserMask inserts the mask inside an SVG with an XML declaration", () => {
  const result = applyEraserMask('<?xml version="1.0"?><svg viewBox="0 0 10 10"><path/></svg>', [
    {
      diameter: 0.2,
      points: [{ x: 0.5, y: 0.5 }],
    },
  ]);
  assert.match(result, /^<\?xml version="1\.0"\?><svg[^>]*><defs>/);
});

test("applyEraserMask supports rectangle, ellipse, and polygon deletions", () => {
  const result = applyEraserMask('<svg viewBox="0 0 200 100"></svg>', [
    { type: "rect", x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    { type: "ellipse", cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.2 },
    {
      type: "polygon",
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0.5, y: 1 },
      ],
    },
  ]);
  assert.match(result, /<rect x="20" y="20" width="60" height="40" fill="#000"\/>/);
  assert.match(result, /<ellipse cx="100" cy="50" rx="20" ry="20" fill="#000"\/>/);
  assert.match(result, /<polygon points="0,0 200,0 100,100" fill="#000"\/>/);
});

test("applyCleanupActions adds vector fill strokes above the traced artwork", () => {
  const svg = '<svg viewBox="0 0 100 50"><path id="art"/></svg>';
  const result = applyCleanupActions(svg, [
    {
      mode: "fill",
      color: "#12ab34",
      diameter: 0.2,
      points: [{ x: 0.5, y: 0.5 }],
    },
  ]);
  assert.match(result, /<path id="art"\/><circle cx="50" cy="25" r="5" fill="#12ab34"\/>/);
});

test("applyCleanupActions preserves cleanup action order", () => {
  const svg = '<svg viewBox="0 0 100 100"><path id="art"/></svg>';
  const result = applyCleanupActions(svg, [
    { mode: "fill", color: "#abcdef", diameter: 0.1, points: [{ x: 0.2, y: 0.2 }] },
    { mode: "erase", diameter: 0.1, points: [{ x: 0.2, y: 0.2 }] },
    { mode: "fill", color: "#fedcba", diameter: 0.1, points: [{ x: 0.8, y: 0.8 }] },
  ]);
  assert.match(
    result,
    /<g mask="url\(#rastertrace-cleanup-mask-0\)"><path id="art"\/><circle[^>]+fill="#abcdef"\/><\/g><circle[^>]+fill="#fedcba"\/>/,
  );
});

test("applyCleanupActions fills rectangular, elliptical, and polygon selections", () => {
  const svg = '<svg viewBox="0 0 100 50"><path d="M0 0"/></svg>';
  const result = applyCleanupActions(svg, [
    { mode: "fill", color: "#123456", type: "rect", x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    { mode: "fill", color: "#abcdef", type: "ellipse", cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.2 },
    {
      mode: "fill",
      color: "#fedcba",
      type: "polygon",
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0.5, y: 1 },
      ],
    },
  ]);

  assert.match(result, /<rect x="10" y="10" width="30" height="20" fill="#123456"\/>/);
  assert.match(result, /<ellipse cx="50" cy="25" rx="10" ry="10" fill="#abcdef"\/>/);
  assert.match(result, /<polygon points="0,0 100,0 50,50" fill="#fedcba"\/>/);
});

test("snapPointToAngle locks polygon segments in image-space 45 degree increments", () => {
  const anchor = { x: 0.2, y: 0.2 };
  const diagonal = snapPointToAngle(anchor, { x: 0.4, y: 0.6 }, 200, 100);
  assert.ok(Math.abs(diagonal.x - 0.4) < 1e-10);
  assert.ok(Math.abs(diagonal.y - 0.6) < 1e-10);

  const horizontal = snapPointToAngle(anchor, { x: 0.5, y: 0.4 }, 200, 100);
  assert.ok(Math.abs(horizontal.y - anchor.y) < 1e-10);
});
