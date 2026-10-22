import { expect, test } from "@playwright/test";
import path from "node:path";

// Cleanup edits are painted into the image before tracing, so every
// profile and setting applies to them like the rest of the artwork.

async function traced(page, action) {
  await page.evaluate(() => (document.getElementById("status").textContent = ""));
  await action();
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
  await expect(page.locator("#tracing-veil")).toBeHidden();
}

async function resultSvg(page) {
  return page.evaluate(async () => {
    const view = /** @type {HTMLImageElement} */ (document.getElementById("result-view"));
    return (await fetch(view.src)).text();
  });
}

async function dragResult(page, [x1, y1], [x2, y2]) {
  const box = await page.locator("#result-view").boundingBox();
  await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * x2, box.y + box.height * y2, { steps: 6 });
  await page.mouse.up();
}

const fills = (svg) =>
  new Set([...svg.matchAll(/fill="(#[0-9a-f]{6})"/gi)].map((m) => m[1].toLowerCase()));

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await traced(page, () =>
    page.locator("#file-input").setInputFiles(path.resolve("android-chrome-512x512.png")),
  );
});

async function paintGreen(page) {
  await page.locator("#blob-fill-tool").click();
  await page.locator("#blob-fill-hex").fill("#00ff00");
  await page.locator("#blob-fill-hex").press("Enter");
  await page.locator("#eraser-size").fill("60");
  await traced(page, () => dragResult(page, [0.15, 0.5], [0.85, 0.5]));
}

test("a fill is traced with its exact color, not drawn on top", async ({ page }) => {
  await paintGreen(page);
  const svg = await resultSvg(page);
  expect(svg).not.toContain("<mask");
  expect(svg).not.toMatch(/stroke="#00ff00"/i);
  expect(fills(svg)).toContain("#00ff00");
});

test("a profile chosen after a fill applies to it", async ({ page }) => {
  await paintGreen(page);
  await traced(page, () => page.locator("#export-profile").selectOption("monoBlack"));
  const svg = await resultSvg(page);
  expect(svg).not.toContain("<mask");
  expect([...fills(svg)]).toEqual(["#000000"]);
});

test("undo takes a fill back out of the trace", async ({ page }) => {
  await paintGreen(page);
  await traced(page, () => page.locator("#eraser-undo").click());
  expect(fills(await resultSvg(page))).not.toContain("#00ff00");
  await traced(page, () => page.locator("#eraser-redo").click());
  expect(fills(await resultSvg(page))).toContain("#00ff00");
});

test("an erase leaves a hole in the trace and keeps PDF and DXF export", async ({ page }) => {
  await page.locator("#eraser-tool").click();
  await page.locator("#eraser-size").fill("80");
  await traced(page, () => dragResult(page, [0.2, 0.5], [0.8, 0.5]));
  const svg = await resultSvg(page);
  expect(svg).toContain('id="rastertrace-baked-erasure-guard"');
  await expect(page.locator("#download-pdf")).toBeEnabled();
  await expect(page.locator("#download-dxf")).toBeEnabled();
});
