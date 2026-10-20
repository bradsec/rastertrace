import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHexColor, quantize, srgbToOklab, toHexColor } from "../js/preprocess.js";

test("quantize preserves eight flat colors despite rare edge blends", () => {
  const runs = [
    ["#9AD0EC", 41212],
    ["#FFCF3F", 7336],
    ["#FFFFFF", 9200],
    ["#5B7A99", 18286],
    ["#6BBF59", 15273],
    ["#4C9A3F", 14453],
    ["#DC5540", 9398],
    ["#8C2F2B", 7722],
    ["#97D0F1", 3],
  ];
  const width = runs.reduce((total, [, count]) => total + count, 0);
  const data = new Uint8ClampedArray(width * 4);
  let offset = 0;
  for (const [hex, count] of runs) {
    const rgba = [...parseHexColor(hex), 255];
    for (let i = 0; i < count; i++, offset += 4) data.set(rgba, offset);
  }
  const img = { width, height: 1, data };
  const repeat = { ...img, data: new Uint8ClampedArray(data) };
  quantize(img, 8);
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const hex = toHexColor(data.subarray(i, i + 3));
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  assert.equal(counts.size, 8);
  const palette = [...counts.keys()].map((hex) => srgbToOklab(parseHexColor(hex)));
  for (const [hex] of runs.slice(0, 8)) {
    const lab = srgbToOklab(parseHexColor(hex));
    const distance = Math.min(...palette.map((p) => Math.hypot(...p.map((v, c) => v - lab[c]))));
    assert.ok(distance < 0.01, `${hex} missing from palette: Oklab distance ${distance}`);
  }
  for (const [hex, count] of counts) assert.ok(count >= 10, `${hex} covers only ${count} pixels`);
  quantize(repeat, 8);
  assert.deepEqual(repeat.data, data);
});

test("quantize keeps a small solid accent over anti-alias blends in flat art", () => {
  // Navy and cream with a 2% ramp of blends between them (each blend
  // rare) and a 0.5% red accent: the three most common colors cover
  // 98%, so each keeps a palette slot and the blends map to them.
  const runs = [
    ["#F2E8CF", 6000],
    ["#1D3557", 3550],
    ["#E53946", 50],
  ];
  const width = 10_000;
  const data = new Uint8ClampedArray(width * 4);
  let offset = 0;
  for (const [hex, count] of runs) {
    const rgba = [...parseHexColor(hex), 255];
    for (let i = 0; i < count; i++, offset += 4) data.set(rgba, offset);
  }
  const [r0, g0, b0] = parseHexColor("#F2E8CF");
  const [r1, g1, b1] = parseHexColor("#1D3557");
  for (let i = 0; i < 400; i++, offset += 4) {
    const t = (i + 0.5) / 400;
    data.set([r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t, 255], offset);
  }
  quantize({ width, height: 1, data }, 3);
  const output = new Set();
  for (let i = 0; i < data.length; i += 4) output.add(toHexColor(data.subarray(i, i + 3)));
  const palette = [...output].map((hex) => srgbToOklab(parseHexColor(hex)));
  for (const [hex] of runs) {
    const lab = srgbToOklab(parseHexColor(hex));
    const distance = Math.min(...palette.map((p) => Math.hypot(...p.map((v, c) => v - lab[c]))));
    assert.ok(distance < 0.01, `${hex} missing from palette: Oklab distance ${distance}`);
  }
});

test("quantize gives a near-duplicate blend no slot of its own", () => {
  // Resampling leaves a common blend one step off cream; it outnumbers
  // the green accent but must not take the accent's slot.
  const runs = [
    ["#F4EFE6", 6000],
    ["#13294B", 3500],
    ["#F0EBE2", 400],
    ["#06D6A0", 100],
  ];
  const width = runs.reduce((total, [, count]) => total + count, 0);
  const data = new Uint8ClampedArray(width * 4);
  let offset = 0;
  for (const [hex, count] of runs) {
    const rgba = [...parseHexColor(hex), 255];
    for (let i = 0; i < count; i++, offset += 4) data.set(rgba, offset);
  }
  quantize({ width, height: 1, data }, 3);
  const output = new Set();
  for (let i = 0; i < data.length; i += 4) output.add(toHexColor(data.subarray(i, i + 3)));
  assert.deepEqual([...output].sort(), ["#06D6A0", "#13294B", "#F4EFE6"]);
});

test("quantize skips flat colors the tracer would merge into a kept one", () => {
  // The chip sample's colors, most common first. #1B2430 is within Merge
  // 67 of #0B1F1A, so with 4 slots it gives way to the green accent,
  // matching distinctColorCount, instead of taking a slot the tracer
  // would merge away.
  const runs = [
    ["#0B1F1A", 7300],
    ["#2A3644", 1260],
    ["#1B2430", 800],
    ["#C9D1D9", 200],
    ["#2FD39A", 170],
  ];
  const width = runs.reduce((total, [, count]) => total + count, 0);
  const data = new Uint8ClampedArray(width * 4);
  let offset = 0;
  for (const [hex, count] of runs) {
    const rgba = [...parseHexColor(hex), 255];
    for (let i = 0; i < count; i++, offset += 4) data.set(rgba, offset);
  }
  quantize({ width, height: 1, data }, 4, { layerDiff: 67 });
  const output = new Set();
  for (let i = 0; i < data.length; i += 4) output.add(toHexColor(data.subarray(i, i + 3)));
  assert.deepEqual([...output].sort(), ["#0B1F1A", "#2A3644", "#2FD39A", "#C9D1D9"]);
});
