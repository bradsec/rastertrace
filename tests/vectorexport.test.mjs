import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenCubic, parseSvgPaths, toDxf, toPdf } from "../js/vectorexport.js";

// Shaped like real vtracer output: uppercase absolute commands, per-path
// fill and translate, compound paths (hole = second subpath).
const SAMPLE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="100" height="80" viewBox="0 0 200 160">',
  '<path d="M0 0 L200 0 L200 160 L0 160 Z " fill="#FFFFFF" transform="translate(0,0)"/>',
  '<path d="M0 0 C20 0 40 10 40 30 L0 30 Z M10 10 L20 10 L20 20 Z " fill="#FF0000" transform="translate(30,40)"/>',
  "</svg>",
].join("\n");

test("parseSvgPaths reads dims, fills, subpaths, and applies translate", () => {
  const parsed = parseSvgPaths(SAMPLE);
  assert.equal(parsed.width, 200);
  assert.equal(parsed.height, 160);
  assert.equal(parsed.paths.length, 2);
  assert.equal(parsed.paths[0].fill, "#FFFFFF");
  assert.equal(parsed.paths[1].fill, "#FF0000");
  assert.equal(parsed.paths[1].subpaths.length, 2);
  const [outer, hole] = parsed.paths[1].subpaths;
  // translate(30,40) applied
  assert.deepEqual(outer.start, { x: 30, y: 40 });
  assert.equal(outer.closed, true);
  assert.equal(outer.segments[0].kind, "cubic");
  assert.deepEqual(outer.segments[0].to, { x: 70, y: 70 });
  assert.deepEqual(hole.start, { x: 40, y: 50 });
  assert.equal(
    hole.segments.every((s) => s.kind === "line"),
    true,
  );
});

test("parseSvgPaths takes fill from an enclosing group", () => {
  // finalizeSvg groups adjacent same-fill paths and strips their fill
  const svg = [
    '<svg width="10" height="10" viewBox="0 0 10 10">',
    '<path d="M0 0 L1 0 Z " fill="#112233" transform="translate(0,0)"/>',
    '<g fill="#00FF00">',
    '<path d="M2 0 L3 0 Z " transform="translate(0,0)"/>',
    '<path d="M4 0 L5 0 Z " transform="translate(0,0)"/>',
    "</g>",
    '<path d="M6 0 L7 0 Z " fill="#445566"/>',
    "</svg>",
  ].join("\n");
  const parsed = parseSvgPaths(svg);
  assert.deepEqual(
    parsed.paths.map((p) => p.fill),
    ["#112233", "#00FF00", "#00FF00", "#445566"],
  );
});

test("parseSvgPaths handles implicit command repetition", () => {
  const svg =
    '<svg width="10" height="10" viewBox="0 0 10 10">\n<path d="M0 0 C1 0 2 0 3 0 4 0 5 0 6 0 L7 0 8 0 Z " fill="#000000"/>\n</svg>';
  const parsed = parseSvgPaths(svg);
  const seg = parsed.paths[0].subpaths[0].segments;
  assert.deepEqual(
    seg.map((s) => s.kind),
    ["cubic", "cubic", "line", "line"],
  );
  assert.deepEqual(seg[1].to, { x: 6, y: 0 });
});

test("flattenCubic stays within tolerance and keeps endpoints", () => {
  // Cubic approximation of a quarter circle radius 100 centered at origin
  const k = 100 * 0.5523;
  const pts = flattenCubic(
    { x: 100, y: 0 },
    { x: 100, y: k },
    { x: k, y: 100 },
    { x: 0, y: 100 },
    0.25,
  );
  const last = pts[pts.length - 1];
  assert.deepEqual({ x: Math.round(last.x), y: Math.round(last.y) }, { x: 0, y: 100 });
  assert.ok(pts.length >= 4, "curve subdivides");
  for (const p of pts) {
    const r = Math.hypot(p.x, p.y);
    assert.ok(Math.abs(r - 100) < 1, `point near arc, r=${r}`);
  }
});

test("toDxf writes closed R12 polylines per subpath with flipped y", () => {
  const dxf = toDxf(parseSvgPaths(SAMPLE));
  assert.match(dxf, /AC1009/);
  assert.equal((dxf.match(/^POLYLINE$/gm) || []).length, 3); // 1 + 2 subpaths
  assert.equal((dxf.match(/^SEQEND$/gm) || []).length, 3);
  assert.match(dxf, /\n70\n1\n/); // closed flag
  assert.match(dxf, /^C_FF0000$/m); // layer per fill color
  assert.match(dxf, /^EOF$/m);
  // First path starts at (0,0) in SVG -> y flips to height 160
  assert.match(dxf, /\n10\n0\n20\n160\n/);
});

test("toDxf applies unit scale", () => {
  const dxf = toDxf(parseSvgPaths(SAMPLE), { scale: 0.5 });
  // (0,0) -> y = 160 * 0.5 = 80
  assert.match(dxf, /\n10\n0\n20\n80\n/);
});

test("toPdf writes a vector page with fills, curves, and page size", () => {
  const pdf = toPdf(parseSvgPaths(SAMPLE), { pageWidth: 150, pageHeight: 120 });
  assert.ok(pdf.startsWith("%PDF-1.4"));
  assert.ok(pdf.trimEnd().endsWith("%%EOF"));
  assert.match(pdf, /MediaBox \[0 0 150 120\]/);
  assert.match(pdf, /1 0 0 rg/); // red fill
  assert.match(pdf, / c\n/); // cubic operator survives (no flattening)
  assert.match(pdf, / f\n/); // nonzero fill keeps holes
  assert.match(pdf, /startxref/);
});

test("toPdf defaults page size to 72/96 of pixel dims", () => {
  const pdf = toPdf(parseSvgPaths(SAMPLE));
  assert.match(pdf, /MediaBox \[0 0 150 120\]/); // 200*0.75, 160*0.75
});
