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
