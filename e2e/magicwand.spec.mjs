import { expect, test } from "@playwright/test";

const SIZE = [160, 80];

// The marching ants repaint the selection overlay every frame. In CI's
// software-rendered WebKit on 2 vCPUs that starves the wand worker, and a
// slider rebuild took 4 to 5 s instead of 0.5 s, past the 5 s expect
// timeout. Reduced motion stops the ants; the outline geometry is unchanged.
test.use({ contextOptions: { reducedMotion: "reduce" } });

/** Two separate red blocks on a light background. */
async function loadTwoBlocks(page) {
  const base64 = await page.evaluate(async ([width, height]) => {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f3ead8";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#d02020";
    ctx.fillRect(10, 20, 40, 40);
    ctx.fillRect(110, 20, 40, 40);
    const bytes = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, SIZE);
  await page.locator("#file-input").setInputFiles({
    name: "blocks.png",
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64"),
  });
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
}

/** Render the current result and read the pixel at source coordinates. */
async function resultPixel(page, [x, y]) {
  return page.evaluate(
    async ([px, py, width, height]) => {
      const view = /** @type {HTMLImageElement} */ (document.getElementById("result-view"));
      await view.decode();
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(view, 0, 0, width, height);
      return [...ctx.getImageData(px, py, 1, 1).data];
    },
    [x, y, ...SIZE],
  );
}

async function clickResult(page, [x, y]) {
  const box = await page.locator("#result-view").boundingBox();
  await page.mouse.click(box.x + (box.width * x) / SIZE[0], box.y + (box.height * y) / SIZE[1]);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("wand outline follows a fractional SVG edge at high zoom", async ({ page }) => {
  await loadTwoBlocks(page);
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find((entry) => entry.name.includes("/js/context.js")).name;
    const { state } = await import(url);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 20 10" preserveAspectRatio="none"><rect width="20" height="10" fill="#f3ead8"/><path d="M4.35 2H15.65V8H4.35Z" fill="#d02020"/></svg>';
    state.svg = svg;
    state.processedRaster = { width: 20, height: 10, data: new Uint8ClampedArray(20 * 10 * 4) };
    const view = /** @type {HTMLImageElement} */ (document.getElementById("result-view"));
    view.src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    await view.decode();
  });
  await page.locator("#magic-wand").click();
  for (const selector of ["#wand-tolerance", "#wand-expand", "#wand-smooth"]) {
    await page.locator(selector).fill("0");
    await page.locator(selector).dispatchEvent("input");
  }
  await clickResult(page, [80, 40]);
  await expect(page.locator("#selection-overlay")).toBeVisible();
  const edges = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find((entry) => entry.name.includes("/js/context.js")).name;
    const { state } = await import(url);
    const points = state.selection.parts[0].shape.loops.flat();
    return [
      Math.min(...points.map((point) => point.x * 20)),
      Math.max(...points.map((point) => point.x * 20)),
    ];
  });
  expect(edges[0]).toBeCloseTo(4.35, 1);
  expect(edges[1]).toBeCloseTo(15.65, 1);
});

/** The whole rendered result as RGBA at source size. */
async function resultPixels(page) {
  return page.evaluate(async ([width, height]) => {
    const view = /** @type {HTMLImageElement} */ (document.getElementById("result-view"));
    await view.decode();
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(view, 0, 0, width, height);
    return [...ctx.getImageData(0, 0, width, height).data];
  }, SIZE);
}

test("the wand selects the shape as traced, not the raster under it", async ({ page }) => {
  // A gradient traces to a few flat bands, but at 256 colors the raster
  // skips quantizing and keeps every shade of it.
  const base64 = await page.evaluate(async ([width, height]) => {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f3ead8";
    ctx.fillRect(0, 0, width, height);
    const gradient = ctx.createLinearGradient(10, 0, 150, 0);
    gradient.addColorStop(0, "#b02828");
    gradient.addColorStop(1, "#bc3434");
    ctx.fillStyle = gradient;
    ctx.fillRect(10, 20, 140, 40);
    const bytes = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, SIZE);
  await page.locator("#file-input").setInputFiles({
    name: "gradient.png",
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64"),
  });
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
  const firstTrace = await page.locator("#result-view").getAttribute("src");
  await page.locator("#auto-detect").uncheck();
  await page.locator("#colors").fill("256");
  await page.locator("#colors").dispatchEvent("change");
  await expect(page.locator("#result-view")).not.toHaveAttribute("src", firstTrace ?? "", {
    timeout: 60_000,
  });
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });

  // The band under the click, as displayed: same color, 4-connected.
  const [width, height] = SIZE;
  const before = await resultPixels(page);
  const seed = 40 * width + 40;
  const color = (i) => before.slice(i * 4, i * 4 + 4).join();
  const band = new Set([seed]);
  for (const stack = [seed]; stack.length;) {
    const i = /** @type {number} */ (stack.pop());
    const x = i % width;
    for (const n of [x > 0 && i - 1, x < width - 1 && i + 1, i - width, i + width]) {
      if (n !== false && n >= 0 && n < width * height && !band.has(n) && color(n) === color(seed)) {
        band.add(n);
        stack.push(n);
      }
    }
  }
  expect(band.size).toBeGreaterThan(200);

  await page.locator("#magic-wand").click();
  await page.locator("#wand-tolerance").fill("0");
  await clickResult(page, [40, 40]);
  await page.locator("#selection-erase").click();
  await expect.poll(async () => (await resultPixels(page))[seed * 4 + 3]).toBe(0);
  const after = await resultPixels(page);
  // Skip three pixels either side of the band's edge: this render is
  // antialiased, so its edge rows blend into a color of their own.
  const near = (i, inBand) => {
    const x = i % width;
    const y = Math.floor(i / width);
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (band.has((y + dy) * width + x + dx) === inBand) return true;
      }
    }
    return false;
  };
  let missed = 0;
  let overreached = 0;
  for (let i = 0; i < width * height; i++) {
    const erased = after[i * 4 + 3] === 0 && before[i * 4 + 3] !== 0;
    if (band.has(i) && !near(i, false) && !erased) missed++;
    if (!band.has(i) && !near(i, true) && erased) overreached++;
  }
  expect({ missed, overreached }).toEqual({ missed: 0, overreached: 0 });
});

test("magic wand erases only the clicked connected area", async ({ page }) => {
  await loadTwoBlocks(page);
  await page.locator("#magic-wand").click();
  await expect(page.locator("#magic-wand")).toHaveAttribute("aria-pressed", "true");
  await clickResult(page, [30, 40]);
  await expect(page.locator("#selection-erase")).toBeVisible();
  await page.locator("#selection-erase").click();
  await expect(page.locator("#eraser-undo")).toBeEnabled();
  await expect.poll(async () => (await resultPixel(page, [30, 40]))[3]).toBe(0);
  const right = await resultPixel(page, [130, 40]);
  expect(right[3]).toBe(255);
  expect(right[0]).toBeGreaterThan(180);
  // Stacked layering: the background under the erased block is cut too.
  expect((await resultPixel(page, [5, 5]))[3]).toBe(255);
});

test("selection overlay follows the image through zoom and window resize", async ({ page }) => {
  await loadTwoBlocks(page);
  await page.locator("#magic-wand").click();
  await clickResult(page, [30, 40]);
  await expect(page.locator("#selection-overlay")).toBeVisible();

  const alignment = () =>
    page.evaluate(() => {
      const image = document.getElementById("result-view").getBoundingClientRect();
      const overlay = document.getElementById("selection-overlay").getBoundingClientRect();
      return Math.max(
        Math.abs(image.left - overlay.left),
        Math.abs(image.top - overlay.top),
        Math.abs(image.right - overlay.right),
        Math.abs(image.bottom - overlay.bottom),
      );
    });
  await expect.poll(alignment).toBeLessThan(1);
  for (let i = 0; i < 7; i++) await page.locator("#zoom-in").click();
  await expect.poll(alignment).toBeLessThan(1);
  await page.setViewportSize({ width: 1040, height: 720 });
  await expect.poll(alignment).toBeLessThan(1);
  for (let i = 0; i < 5; i++) await page.locator("#zoom-out").click();
  await expect.poll(alignment).toBeLessThan(1);
});

test("a small marquee deletion stays transparent after retracing", async ({ page }) => {
  await loadTwoBlocks(page);
  await page.locator("#smooth-outlines").fill("4");
  await page.locator("#smooth-outlines").dispatchEvent("change");
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
  await page.locator("#marquee-rect").click();
  const box = await page.locator("#result-view").boundingBox();
  const point = (x, y) => ({
    x: box.x + (box.width * x) / SIZE[0],
    y: box.y + (box.height * y) / SIZE[1],
  });
  const start = point(20, 30);
  const end = point(23, 33);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y);
  await page.mouse.up();
  await expect(page.locator("#selection-erase")).toBeVisible();
  await page.evaluate(() => (document.getElementById("status").textContent = ""));
  await page.locator("#selection-erase").click();
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
  await expect(page.locator("#tracing-veil")).toBeHidden({ timeout: 60_000 });
  expect((await resultPixel(page, [21, 31]))[3]).toBe(0);

  await page.locator("#blob-fill-tool").click();
  await page.locator("#blob-fill-hex").fill("#00ff00");
  await page.locator("#blob-fill-hex").dispatchEvent("change");
  await page.locator("#eraser-size").fill("240");
  await page.evaluate(() => (document.getElementById("status").textContent = ""));
  const fillBox = await page.locator("#result-view").boundingBox();
  await page.mouse.click(
    fillBox.x + (fillBox.width * 21.5) / SIZE[0],
    fillBox.y + (fillBox.height * 31.5) / SIZE[1],
  );
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
  const svg = await page
    .locator("#result-view")
    .evaluate(async (image) => (await fetch(image.src)).text());
  expect(svg).toMatch(/#00ff00/i);
  const filled = await resultPixel(page, [21, 31]);
  expect(filled[3]).toBe(255);
  expect(filled[1]).toBeGreaterThan(180);
});

test("shift-click adds a second area and fill paints both", async ({ page }) => {
  await loadTwoBlocks(page);
  await page.keyboard.press("w");
  await clickResult(page, [30, 40]);
  await page.keyboard.down("Shift");
  await clickResult(page, [130, 40]);
  await page.keyboard.up("Shift");
  await page.locator("#blob-fill-hex").fill("#00ff00");
  await page.locator("#blob-fill-hex").dispatchEvent("change");
  await page.locator("#selection-fill").click();
  await expect.poll(async () => (await resultPixel(page, [30, 40]))[1]).toBeGreaterThan(200);
  expect((await resultPixel(page, [130, 40]))[1]).toBeGreaterThan(200);
});

test("magic wand on empty canvas keeps the tool armed", async ({ page }) => {
  await loadTwoBlocks(page);
  await page.locator("#magic-wand").click();
  const box = await page.locator("#preview").boundingBox();
  await page.mouse.click(box.x + 4, box.y + 4);
  await expect(page.locator("#selection-actions")).toBeHidden();
  await expect(page.locator("#magic-wand")).toHaveAttribute("aria-pressed", "true");
});

test("expand slider grows the selection past the block edge", async ({ page }) => {
  await loadTwoBlocks(page);
  await page.locator("#magic-wand").click();
  await expect(page.locator("#wand-expand")).toBeVisible();
  await clickResult(page, [30, 40]);
  await page.locator("#wand-expand").fill("8");
  await page.locator("#wand-expand").dispatchEvent("input");
  await expect(page.locator("#wand-expand-out")).toHaveText("8 px");
  await page.locator("#selection-erase").click();
  // The block ends at x=50; 8 raster px at 2x upscale reach 4 source px out.
  await expect.poll(async () => (await resultPixel(page, [52, 40]))[3]).toBe(0);
  expect((await resultPixel(page, [56, 40]))[3]).toBe(255);
});

test("delete erases the wand selection after a slider was used", async ({ page }) => {
  await loadTwoBlocks(page);
  await page.locator("#magic-wand").click();
  await page.locator("#wand-tolerance").click();
  await clickResult(page, [30, 40]);
  await expect(page.locator("#selection-erase")).toBeVisible();
  await page.locator("#wand-expand").focus();
  await page.keyboard.press("Delete");
  await expect(page.locator("#eraser-undo")).toBeEnabled();
  await expect.poll(async () => (await resultPixel(page, [30, 40]))[3]).toBe(0);
});

test("smooth slider reshapes the current selection outline", async ({ page }) => {
  await loadTwoBlocks(page);
  await page.locator("#magic-wand").click();
  await page.locator("#wand-smooth").fill("0");
  await page.locator("#wand-smooth").dispatchEvent("input");
  await clickResult(page, [30, 40]);
  const outline = () =>
    page.locator("#selection-overlay path.selection-ants-light").getAttribute("d");
  const sharp = await outline();
  await page.locator("#wand-smooth").fill("8");
  await page.locator("#wand-smooth").dispatchEvent("input");
  await expect(page.locator("#wand-smooth-out")).toHaveText("8");
  await expect.poll(outline).not.toBe(sharp);
  await expect(page.locator("#selection-erase")).toBeVisible();
});
