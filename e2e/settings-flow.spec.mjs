import { expect, test } from "@playwright/test";

const CREAM = "#f3ead8";

/**
 * Draw a test image in the page and return it as a PNG file payload.
 * `shapes` are [fillStyle, x, y, width, height] rectangles over a `bg`
 * fill; "noise" fills the canvas with random pixels instead (photo-like).
 */
async function makePng(page, name, width, height, bg, shapes = []) {
  const base64 = await page.evaluate(
    async (spec) => {
      const canvas = new OffscreenCanvas(spec.width, spec.height);
      const ctx = canvas.getContext("2d");
      if (spec.bg === "noise") {
        const img = ctx.createImageData(spec.width, spec.height);
        for (let i = 0; i < img.data.length; i += 4) {
          img.data[i] = Math.random() * 256;
          img.data[i + 1] = Math.random() * 256;
          img.data[i + 2] = Math.random() * 256;
          img.data[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
      } else {
        ctx.fillStyle = spec.bg;
        ctx.fillRect(0, 0, spec.width, spec.height);
      }
      for (const [fill, x, y, w, h] of spec.shapes) {
        ctx.fillStyle = fill;
        ctx.fillRect(x, y, w, h);
      }
      const bytes = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    },
    { width, height, bg, shapes },
  );
  return { name, mimeType: "image/png", buffer: Buffer.from(base64, "base64") };
}

/** Run `action` and wait for the trace it starts to finish. */
async function traced(page, action) {
  await page.evaluate(() => (document.getElementById("status").textContent = ""));
  await action();
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
}

async function openPanels(page) {
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details")) details.open = true;
  });
}

/** Alpha of the rendered result at source-pixel coordinates. */
async function resultAlpha(page, points) {
  return page.evaluate(async (coords) => {
    const view = /** @type {HTMLImageElement} */ (document.getElementById("result-view"));
    const img = new Image();
    img.src = view.src;
    await img.decode();
    const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return coords.map(([x, y]) => ctx.getImageData(x, y, 1, 1).data[3]);
  }, points);
}

async function setRange(page, selector, value) {
  await traced(page, async () => {
    await page.locator(selector).fill(String(value));
    await page.locator(selector).dispatchEvent("input");
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("enclosed background removal honors the minimum and maximum sizes", async ({ page }) => {
  // Dark frames on cream: a 14 px hole and an 80x100 px hole.
  const file = await makePng(page, "holes.png", 300, 200, CREAM, [
    ["#3c281e", 20, 60, 30, 30],
    [CREAM, 28, 68, 14, 14],
    ["#3c281e", 90, 40, 100, 120],
    [CREAM, 100, 50, 80, 100],
  ]);
  const small = [34, 74];
  const large = [140, 100];
  const outside = [5, 5];

  await traced(page, () => page.locator("#file-input").setInputFiles(file));
  await openPanels(page);
  await traced(page, () => page.locator("#transparent").selectOption("edges"));
  expect(await resultAlpha(page, [outside, small, large])).toEqual([0, 255, 255]);

  await traced(page, () => page.locator("#enclosed").check());
  await expect(page.locator("#enclosed-size-out")).toHaveText("16 px");
  await expect(page.locator("#enclosed-max-size-out")).toHaveText("No limit");
  // Default minimum (16 px across) keeps the 14 px hole.
  expect(await resultAlpha(page, [small, large])).toEqual([255, 0]);

  await setRange(page, "#enclosed-size", 4);
  expect(await resultAlpha(page, [small, large])).toEqual([0, 0]);

  // A 40 px maximum protects the large hole (about 89 px across).
  await setRange(page, "#enclosed-max-size", 40);
  await expect(page.locator("#enclosed-max-size-out")).toHaveText("40 px");
  expect(await resultAlpha(page, [small, large])).toEqual([0, 255]);
});

test("auto-detect sets colors per image; manual changes carry over", async ({ page }) => {
  const flat = await makePng(page, "flat.png", 120, 120, CREAM, [["#3c281e", 30, 30, 60, 60]]);
  const photo = await makePng(page, "photo.png", 120, 120, "noise");
  const colors = page.locator("#colors");
  const autoDetect = page.locator("#auto-detect");

  await traced(page, () => page.locator("#file-input").setInputFiles(flat));
  await openPanels(page);
  await expect(autoDetect).toBeChecked();
  await expect(colors).toHaveValue("2");

  // A photo after flat art gets the defaults, not the leftover palette.
  await traced(page, () => page.locator("#file-input").setInputFiles(photo));
  await expect(colors).toHaveValue("256");

  await setRange(page, "#colors", 8);
  await expect(autoDetect).not.toBeChecked();
  await traced(page, () => page.locator("#file-input").setInputFiles(flat));
  await expect(colors).toHaveValue("8");

  // Ticking auto-detect again applies it to the current image.
  await traced(page, () => autoDetect.check());
  await expect(colors).toHaveValue("2");

  await page.reload();
  await openPanels(page);
  await expect(autoDetect).toBeChecked();
  await expect(colors).toHaveValue("2");
});

test("replacing an inverted image restores the knockout color", async ({ page }) => {
  const flat = await makePng(page, "flat.png", 120, 120, CREAM, [["#3c281e", 30, 30, 60, 60]]);
  await traced(page, () => page.locator("#file-input").setInputFiles(flat));
  await openPanels(page);
  await traced(page, () => page.locator("#transparent").selectOption("custom"));
  await traced(page, () => page.locator("#knockout-color").fill(CREAM));

  await traced(page, () => page.evaluate(() => document.getElementById("invert-image").click()));
  await expect(page.locator("#knockout-color")).toHaveValue("#0c1527");

  await traced(page, () => page.locator("#file-input").setInputFiles(flat));
  await expect(page.locator("#knockout-color")).toHaveValue(CREAM);
});
