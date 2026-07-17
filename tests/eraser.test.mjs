import test from "node:test";
import assert from "node:assert/strict";
import { applyEraserMask, svgViewBox } from "../js/eraser.js";

test("svgViewBox reads comma and space separated values", () => {
  assert.deepEqual(svgViewBox('<svg viewBox="-2, 3, 100, 50"></svg>'), {
    x: -2, y: 3, width: 100, height: 50,
  });
});

test("applyEraserMask preserves untouched SVGs", () => {
  const svg = '<svg viewBox="0 0 100 50"><path d="M0 0"/></svg>';
  assert.equal(applyEraserMask(svg, []), svg);
});

test("applyEraserMask adds normalized round strokes and wraps artwork", () => {
  const svg = '<svg viewBox="0 0 200 100"><path d="M0 0"/></svg>';
  const result = applyEraserMask(svg, [{
    diameter: 0.1,
    points: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }],
  }]);
  assert.match(result, /<mask id="rastertrace-eraser-mask"/);
  assert.match(result, /stroke-width="10"/);
  assert.match(result, /d="M50 50 L150 50"/);
  assert.match(result, /<g mask="url\(#rastertrace-eraser-mask\)"><path/);
});

test("applyEraserMask renders a click as a circular erasure", () => {
  const result = applyEraserMask('<svg viewBox="0 0 80 40"></svg>', [{
    diameter: 0.25,
    points: [{ x: 0.5, y: 0.5 }],
  }]);
  assert.match(result, /<circle cx="40" cy="20" r="5"/);
});

test("applyEraserMask inserts the mask inside an SVG with an XML declaration", () => {
  const result = applyEraserMask('<?xml version="1.0"?><svg viewBox="0 0 10 10"><path/></svg>', [{
    diameter: 0.2,
    points: [{ x: 0.5, y: 0.5 }],
  }]);
  assert.match(result, /^<\?xml version="1\.0"\?><svg[^>]*><defs>/);
});

test("applyEraserMask supports rectangle, ellipse, and polygon deletions", () => {
  const result = applyEraserMask('<svg viewBox="0 0 200 100"></svg>', [
    { type: "rect", x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    { type: "ellipse", cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.2 },
    { type: "polygon", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }] },
  ]);
  assert.match(result, /<rect x="20" y="20" width="60" height="40" fill="#000"\/>/);
  assert.match(result, /<ellipse cx="100" cy="50" rx="20" ry="20" fill="#000"\/>/);
  assert.match(result, /<polygon points="0,0 200,0 100,100" fill="#000"\/>/);
});
