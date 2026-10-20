import { expect, test } from "@playwright/test";

// Low-resolution flat art enlarged with hard pixel steps, then blurred
// and saved as JPEG: soft, stair-stepped edges with compression smear.
async function blurredJpeg(page) {
  const base64 = await page.evaluate(async () => {
    const small = new OffscreenCanvas(64, 48);
    const ctx = small.getContext("2d");
    ctx.fillStyle = "#04045c";
    ctx.fillRect(0, 0, 64, 48);
    ctx.fillStyle = "#f6d27a";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(64, 0);
    ctx.lineTo(64, 14);
    ctx.lineTo(0, 36);
    ctx.fill();
    ctx.fillStyle = "#e9a46e";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(30, 0);
    ctx.lineTo(0, 12);
    ctx.fill();
    // Hard pixels: snap the canvas anti-aliasing back to the three fills.
    const pixels = ctx.getImageData(0, 0, 64, 48);
    const fills = [
      [4, 4, 92],
      [246, 210, 122],
      [233, 164, 110],
    ];
    for (let i = 0; i < pixels.data.length; i += 4) {
      const distance = (f) => f.reduce((sum, v, c) => sum + (v - pixels.data[i + c]) ** 2, 0);
      pixels.data.set(
        fills.reduce((a, b) => (distance(b) < distance(a) ? b : a)),
        i,
      );
    }
    ctx.putImageData(pixels, 0, 0);
    const large = new OffscreenCanvas(512, 384);
    const big = large.getContext("2d");
    big.imageSmoothingEnabled = false;
    big.drawImage(small, -4, -4, 520, 392);
    // Box blur in script: WebKit canvases ignore ctx.filter.
    const sharp = big.getImageData(0, 0, 512, 384);
    const soft = big.createImageData(512, 384);
    const radius = 4;
    for (let y = 0; y < 384; y++) {
      for (let x = 0; x < 512; x++) {
        const sum = [0, 0, 0];
        let count = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const sx = Math.min(511, Math.max(0, x + dx));
            const sy = Math.min(383, Math.max(0, y + dy));
            const i = (sy * 512 + sx) * 4;
            for (let c = 0; c < 3; c++) sum[c] += sharp.data[i + c];
            count += 1;
          }
        }
        soft.data.set([...sum.map((v) => Math.round(v / count)), 255], (y * 512 + x) * 4);
      }
    }
    big.putImageData(soft, 0, 0);
    const blob = await large.convertToBlob({ type: "image/jpeg", quality: 0.8 });
    let binary = "";
    for (const byte of new Uint8Array(await blob.arrayBuffer()))
      binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  return { name: "blurred.jpg", mimeType: "image/jpeg", buffer: Buffer.from(base64, "base64") };
}

async function traced(page, action) {
  await page.evaluate(() => (document.getElementById("status").textContent = ""));
  await action();
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
  await expect(page.locator("#tracing-veil")).toBeHidden();
}

/** Distinct fill colors of the current result. */
async function resultFills(page) {
  const svg = await page.evaluate(async () => {
    const view = /** @type {HTMLImageElement} */ (document.getElementById("result-view"));
    return (await fetch(view.src)).text();
  });
  return new Set([...svg.matchAll(/fill="(#[0-9a-f]{6})"/gi)].map((m) => m[1].toLowerCase()));
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("a blurred JPEG traces with only its own colors", async ({ page }) => {
  const file = await blurredJpeg(page);
  await traced(page, () => page.locator("#file-input").setInputFiles(file));
  expect([...(await resultFills(page))]).toHaveLength(3);
});
