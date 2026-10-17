import { expect, test } from "@playwright/test";

const SIZE = [120, 80];

/** Red block on white with small notches bitten out of its top edge. */
async function loadNotchedBlock(page) {
  const base64 = await page.evaluate(async ([width, height]) => {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#d02020";
    ctx.fillRect(20, 30, 80, 40);
    ctx.fillStyle = "#ffffff";
    for (let k = 0; k < 6; k++) ctx.fillRect(24 + k * 12, 30, 4, 3);
    const bytes = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, SIZE);
  await page.locator("#file-input").setInputFiles({
    name: "notched.png",
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64"),
  });
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
}

async function traced(page, action) {
  await page.evaluate(() => (document.getElementById("status").textContent = ""));
  await action();
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
}

/** Alpha of the rendered result at source coordinates. */
async function alphaAt(page, [x, y]) {
  return page.evaluate(
    async ([px, py, width, height]) => {
      const view = /** @type {HTMLImageElement} */ (document.getElementById("result-view"));
      await view.decode();
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(view, 0, 0, width, height);
      return ctx.getImageData(px, py, 1, 1).data[3];
    },
    [x, y, ...SIZE],
  );
}

test("edge smooth fills small notches in a cutout edge", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await loadNotchedBlock(page);
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details")) details.open = true;
  });
  await traced(page, () => page.locator("#transparent").selectOption("edges"));
  await expect(page.locator("#edge-smooth")).toBeVisible();
  // Inside a notch: background, so transparent once removed.
  expect(await alphaAt(page, [26, 31])).toBe(0);
  await traced(page, async () => {
    await page.locator("#edge-smooth").fill("6");
    await page.locator("#edge-smooth").dispatchEvent("input");
  });
  await expect(page.locator("#edge-smooth-out")).toHaveText("6");
  expect(await alphaAt(page, [26, 31])).toBe(255);
  // The block's straight bottom edge stays where it was.
  expect(await alphaAt(page, [60, 68])).toBe(255);
  expect(await alphaAt(page, [60, 72])).toBe(0);
});
