import { expect, test } from "@playwright/test";

// Blue over cream with a cream notch cut into the blue edge.
async function notchedPng(page) {
  const base64 = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(600, 450);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#1450b4";
    ctx.fillRect(0, 0, 600, 450);
    ctx.fillStyle = "#f0e4c8";
    ctx.fillRect(0, 240, 600, 210);
    ctx.fillRect(292, 216, 16, 24);
    const bytes = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  return { name: "notched.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64") };
}

async function traced(page, action) {
  await page.evaluate(() => (document.getElementById("status").textContent = ""));
  await action();
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
  await expect(page.locator("#tracing-veil")).toBeHidden();
}

/** Whether the traced result is blue at (x, y), as shares of the image. */
async function blueAt(page, x, y) {
  return page.evaluate(
    async ([nx, ny]) => {
      const view = /** @type {HTMLImageElement} */ (document.getElementById("result-view"));
      const image = new Image();
      image.src = view.src;
      await image.decode();
      const canvas = new OffscreenCanvas(600, 450);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0, 600, 450);
      const [r, , b] = ctx.getImageData(Math.round(nx * 600), Math.round(ny * 450), 1, 1).data;
      return b > 150 && r < 100;
    },
    [x, y],
  );
}

async function drag(page, [x1, y1], [x2, y2]) {
  const box = await page.locator("#result-view").boundingBox();
  await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * x2, box.y + box.height * y2, { steps: 8 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const file = await notchedPng(page);
  await traced(page, () => page.locator("#file-input").setInputFiles(file));
});

test("the smooth brush fills a notch in an edge", async ({ page }) => {
  // The notch's middle is cream before smoothing.
  expect(await blueAt(page, 0.5, 0.505)).toBe(false);
  await page.keyboard.press("s");
  await expect(page.locator("#smooth-tool")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#eraser-size")).toBeVisible();
  await page.locator("#eraser-size").fill("200");
  await traced(page, () => drag(page, [0.35, 0.53], [0.65, 0.53]));
  expect(await blueAt(page, 0.5, 0.505)).toBe(true);
  // The edge away from the notch stays put.
  expect(await blueAt(page, 0.15, 0.52)).toBe(true);
  expect(await blueAt(page, 0.15, 0.55)).toBe(false);
  await expect(page.locator("#smooth-overlay")).toBeHidden();

  await traced(page, () => page.locator("#eraser-undo").click());
  expect(await blueAt(page, 0.5, 0.505)).toBe(false);
});

test("a smooth stroke shows its outline until the trace lands", async ({ page }) => {
  await page.locator("#smooth-tool").click();
  await page.locator("#eraser-size").fill("200");
  // Hold the trace back so the pending outline can be seen.
  await page.evaluate(() => {
    const worker = Worker.prototype.postMessage;
    window.releaseTrace = () => (Worker.prototype.postMessage = worker);
    Worker.prototype.postMessage = function (message, transfer) {
      window.heldTrace = () => worker.call(this, message, transfer);
    };
  });
  await drag(page, [0.35, 0.53], [0.65, 0.53]);
  await expect(page.locator("#smooth-overlay path")).toHaveCount(1);
  await expect(page.locator("#smooth-overlay")).toBeVisible();
  await traced(page, () =>
    page.evaluate(() => {
      window.releaseTrace();
      window.heldTrace?.();
    }),
  );
  await expect(page.locator("#smooth-overlay")).toBeHidden();
});
