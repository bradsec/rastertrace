import { expect, test } from "@playwright/test";

const SIZE = [160, 80];

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
