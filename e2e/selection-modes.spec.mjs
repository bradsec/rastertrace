import { expect, test } from "@playwright/test";

const SIZE = [160, 80];

/** Solid red image, so every pixel is part of the traced result. */
async function loadRed(page) {
  const base64 = await page.evaluate(async ([width, height]) => {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#d02020";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#2040c0";
    ctx.fillRect(110, 20, 40, 40);
    const bytes = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, SIZE);
  await page.locator("#file-input").setInputFiles({
    name: "red.png",
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64"),
  });
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
}

/** Rendered result pixel [r, g, b, a] at source coordinates. */
async function pixel(page, [x, y]) {
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

async function point(page, [x, y]) {
  const box = await page.locator("#result-view").boundingBox();
  return [box.x + (box.width * x) / SIZE[0], box.y + (box.height * y) / SIZE[1]];
}

/** Drag a marquee between two source points, holding `modifier` at the press. */
async function drag(page, from, to, modifier) {
  const [x1, y1] = await point(page, from);
  const [x2, y2] = await point(page, to);
  await page.mouse.move(x1, y1);
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.down();
  if (modifier) await page.keyboard.up(modifier);
  await page.mouse.move(x2, y2, { steps: 4 });
  await page.mouse.up();
}

const alpha = async (page, at) => (await pixel(page, at))[3];

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await loadRed(page);
  await page.locator("#marquee-rect").click();
});

test("shift adds a second marquee and erase removes both", async ({ page }) => {
  await drag(page, [5, 5], [25, 25]);
  await drag(page, [40, 40], [60, 60], "Shift");
  await page.locator("#selection-erase").click();
  await expect.poll(() => alpha(page, [15, 15])).toBe(0);
  expect(await alpha(page, [50, 50])).toBe(0);
  expect(await alpha(page, [32, 32])).toBe(255);
});

test("alt subtracts from the selection, leaving a ring", async ({ page }) => {
  await drag(page, [5, 5], [65, 65]);
  await drag(page, [25, 25], [45, 45], "Alt");
  await page.locator("#selection-erase").click();
  await expect.poll(() => alpha(page, [10, 10])).toBe(0);
  expect(await alpha(page, [35, 35])).toBe(255);
});

test("a plain drag starts a new selection", async ({ page }) => {
  await drag(page, [5, 5], [25, 25]);
  await drag(page, [40, 40], [60, 60]);
  await page.locator("#selection-erase").click();
  await expect.poll(() => alpha(page, [50, 50])).toBe(0);
  expect(await alpha(page, [15, 15])).toBe(255);
});

test("toolbar mode buttons add and subtract without modifier keys", async ({ page }) => {
  await expect(page.locator("#sel-mode-new")).toHaveAttribute("aria-pressed", "true");
  await drag(page, [5, 5], [65, 65]);
  await page.locator("#sel-mode-subtract").click();
  await expect(page.locator("#sel-mode-subtract")).toHaveAttribute("aria-pressed", "true");
  await drag(page, [25, 25], [45, 45]);
  await page.locator("#sel-mode-add").click();
  await drag(page, [80, 5], [100, 25]);
  await page.locator("#selection-erase").click();
  await expect.poll(() => alpha(page, [10, 10])).toBe(0);
  expect(await alpha(page, [35, 35])).toBe(255);
  expect(await alpha(page, [90, 15])).toBe(0);
});

test("fill skips the subtracted part", async ({ page }) => {
  await drag(page, [5, 5], [65, 65]);
  await drag(page, [25, 25], [45, 45], "Alt");
  await page.locator("#blob-fill-hex").fill("#00ff00");
  await page.locator("#blob-fill-hex").dispatchEvent("change");
  await page.locator("#selection-fill").click();
  await expect.poll(async () => (await pixel(page, [10, 10]))[1]).toBeGreaterThan(200);
  const inner = await pixel(page, [35, 35]);
  expect(inner[0]).toBeGreaterThan(180);
  expect(inner[1]).toBeLessThan(80);
});

test("a wand area combines with a marquee from another tool", async ({ page }) => {
  await page.locator("#magic-wand").click();
  await page.mouse.click(...(await point(page, [130, 40])));
  await expect(page.locator("#selection-erase")).toBeVisible();
  // Switching tools keeps the wand selection; Alt subtracts the left half.
  await page.locator("#marquee-rect").click();
  await expect(page.locator("#selection-erase")).toBeVisible();
  await drag(page, [100, 10], [130, 70], "Alt");
  await page.locator("#selection-erase").click();
  await expect.poll(() => alpha(page, [140, 40])).toBe(0);
  expect(await alpha(page, [120, 40])).toBe(255);
  expect(await alpha(page, [60, 40])).toBe(255);
});

test("alt-click with the wand on an empty selection does nothing", async ({ page }) => {
  await page.locator("#magic-wand").click();
  await page.keyboard.down("Alt");
  await page.mouse.click(...(await point(page, [130, 40])));
  await page.keyboard.up("Alt");
  await expect(page.locator("#selection-actions")).toBeHidden();
  await expect(page.locator("#status")).toHaveText("Nothing selected to subtract from.");
});

test("the cursor shows add and subtract while the keys are held", async ({ page }) => {
  const preview = page.locator("#preview");
  await page.keyboard.down("Shift");
  await expect(preview).toHaveClass(/sel-add/);
  await page.keyboard.up("Shift");
  await expect(preview).not.toHaveClass(/sel-add/);
  await page.keyboard.down("Alt");
  await expect(preview).toHaveClass(/sel-subtract/);
  await page.keyboard.up("Alt");
  await page.locator("#sel-mode-add").click();
  await expect(preview).toHaveClass(/sel-add/);
});
