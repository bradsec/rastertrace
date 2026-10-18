import { expect, test } from "@playwright/test";

const CREAM = "#f3ead8";

/** Draw [fillStyle, x, y, w, h] rectangles over `bg` ("noise" for random pixels). */
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

async function traced(page, action) {
  await page.evaluate(() => (document.getElementById("status").textContent = ""));
  await action();
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
}

/** The SVG markup the result preview currently shows. */
async function resultSvg(page) {
  return page.evaluate(async () => {
    const view = /** @type {HTMLImageElement} */ (document.getElementById("result-view"));
    return (await fetch(view.src)).text();
  });
}

/** Click the result image at source-pixel coordinates of a `width` x `height` image. */
async function clickResult(page, [x, y], [width, height]) {
  const box = await page.locator("#result-view").boundingBox();
  await page.mouse.click(
    box.x + (box.width * (x + 0.5)) / width,
    box.y + (box.height * (y + 0.5)) / height,
  );
}

const SIZE = [120, 90];
const SHAPES = [
  ["#d02020", 10, 10, 40, 40],
  ["#2040c0", 70, 40, 40, 40],
];

async function loadShapes(page) {
  const file = await makePng(page, "shapes.png", ...SIZE, CREAM, SHAPES);
  await traced(page, () => page.locator("#file-input").setInputFiles(file));
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details")) details.open = true;
  });
}

/** Open the editor on the first swatch and return its original fill. */
async function editFirstSwatch(page, hex) {
  const swatch = page.locator("#palette-grid .swatch").first();
  const original = await swatch.getAttribute("data-fill");
  await swatch.click();
  await page.locator("#palette-hex").fill(hex);
  return original;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("grid lists traced colors", async ({ page }) => {
  await loadShapes(page);
  await expect(page.locator("#palette-grid .swatch")).toHaveCount(3);
  await expect(page.locator("#palette-hint")).toBeHidden();
});

test("hex edit recolors export and syncs RGB", async ({ page }) => {
  await loadShapes(page);
  const original = await editFirstSwatch(page, "#00FF00");
  await expect.poll(() => resultSvg(page)).toContain('fill="#00FF00"');
  expect((await resultSvg(page)).toUpperCase()).not.toContain(`"${original}"`);
  await expect(page.locator("#palette-r")).toHaveValue("0");
  await expect(page.locator("#palette-g")).toHaveValue("255");
  await expect(page.locator("#palette-edits li")).toHaveCount(1);
});

test("partial hex is ignored", async ({ page }) => {
  await loadShapes(page);
  await editFirstSwatch(page, "#00FF00");
  await expect.poll(() => resultSvg(page)).toContain('fill="#00FF00"');
  await page.locator("#palette-hex").fill("#12");
  await expect(page.locator("#palette-hex")).toHaveAttribute("aria-invalid", "true");
  expect(await resultSvg(page)).toContain('fill="#00FF00"');
});

test("invalid fields explain the expected format", async ({ page }) => {
  await loadShapes(page);
  await editFirstSwatch(page, "#12zz");
  const error = page.locator("#palette-error");
  await expect(error).toHaveText("Use six hex digits, like #336699.");
  await expect(page.locator("#palette-hex")).toHaveAccessibleDescription(
    "Use six hex digits, like #336699.",
  );
  await page.locator("#palette-hex").fill("#336699");
  await expect(error).toBeHidden();
  await page.locator("#palette-g").fill("300");
  await expect(error).toHaveText("Use a whole number from 0 to 255.");
  await page.locator("#palette-g").fill("30");
  await expect(error).toBeHidden();
});

test("reset color restores the original fill", async ({ page }) => {
  await loadShapes(page);
  const original = await editFirstSwatch(page, "#00FF00");
  await expect.poll(() => resultSvg(page)).toContain('fill="#00FF00"');
  await page.locator("#palette-reset").click();
  await expect.poll(async () => (await resultSvg(page)).toUpperCase()).toContain(`"${original}"`);
  await expect(page.locator("#palette-edits li")).toHaveCount(0);
});

test("pick opens editor for clicked color", async ({ page }) => {
  await loadShapes(page);
  await page.locator("#palette-pick").click();
  await clickResult(page, [90, 60], SIZE);
  await expect(page.locator("#palette-editor")).toBeVisible();
  const hex = (await page.locator("#palette-original-hex").textContent()).trim();
  const [r, , b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  expect(b).toBeGreaterThan(r);
  await expect(page.locator("#palette-pick")).toHaveAttribute("aria-pressed", "false");
});

test("pick on transparent area keeps pick mode", async ({ page }) => {
  await loadShapes(page);
  await traced(page, () => page.locator("#transparent").selectOption("edges"));
  await page.locator("#palette-pick").click();
  await clickResult(page, [3, 3], SIZE);
  await expect(page.locator("#palette-editor")).toBeHidden();
  await expect(page.locator("#palette-pick")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#status")).toContainText("transparent");
});

test("edits survive a palette-stable retrace and clear on new file", async ({ page }) => {
  await loadShapes(page);
  await editFirstSwatch(page, "#00FF00");
  await expect(page.locator("#palette-edits li")).toHaveCount(1);
  await traced(page, async () => {
    await page.locator("#speckle").fill("4");
    await page.locator("#speckle").dispatchEvent("input");
  });
  await expect(page.locator("#palette-edits li")).toHaveCount(1);
  expect(await resultSvg(page)).toContain('fill="#00FF00"');

  const other = await makePng(page, "other.png", ...SIZE, CREAM, SHAPES);
  page.once("dialog", (dialog) => dialog.accept());
  await traced(page, () => page.locator("#file-input").setInputFiles(other));
  await expect(page.locator("#palette-edits li")).toHaveCount(0);
});

test("grid shows palettes between 17 and 32 colors", async ({ page }) => {
  const shapes = Array.from({ length: 20 }, (_, i) => [
    `rgb(${(i % 5) * 60}, ${Math.floor(i / 5) * 80}, 128)`,
    (i % 5) * 40,
    Math.floor(i / 5) * 40,
    40,
    40,
  ]);
  const file = await makePng(page, "20-colors.png", 200, 160, "#000000", shapes);
  await traced(page, () => page.locator("#file-input").setInputFiles(file));
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details")) details.open = true;
  });
  await traced(page, async () => {
    await page.locator("#colors").fill("32");
    await page.locator("#colors").dispatchEvent("input");
  });
  const paletteSize = parseInt(await page.locator("#palette-summary").textContent(), 10);
  expect(paletteSize).toBeGreaterThan(16);
  expect(paletteSize).toBeLessThanOrEqual(32);
  await expect(page.locator("#palette-grid")).toBeVisible();
  await expect(page.locator("#palette-grid .swatch")).toHaveCount(paletteSize);
  await expect(page.locator("#palette-hint")).toBeHidden();
});

test("grid hidden above 32 colors", async ({ page }) => {
  const photo = await makePng(page, "photo.png", 200, 200, "noise");
  await traced(page, () => page.locator("#file-input").setInputFiles(photo));
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details")) details.open = true;
  });
  await traced(page, async () => {
    await page.locator("#speckle").fill("0");
    await page.locator("#speckle").dispatchEvent("input");
  });
  await traced(page, async () => {
    await page.locator("#colors").fill("128");
    await page.locator("#colors").dispatchEvent("input");
  });
  const paletteSize = parseInt(await page.locator("#palette-summary").textContent(), 10);
  expect(paletteSize).toBeGreaterThan(32);
  await expect(page.locator("#palette-grid")).toBeHidden();
  await expect(page.locator("#palette-hint")).toBeVisible();
});

test("reduced palette groups near-duplicate traced fills", async ({ page }) => {
  // Noise reduced to 8 colors traces into many regions whose averaged
  // fills differ slightly; each must follow its palette color.
  const photo = await makePng(page, "photo.png", 120, 120, "noise");
  await traced(page, () => page.locator("#file-input").setInputFiles(photo));
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details")) details.open = true;
  });
  await traced(page, async () => {
    await page.locator("#colors").fill("8");
    await page.locator("#colors").dispatchEvent("input");
  });
  await expect(page.locator("#palette-grid")).toBeVisible();
  const swatches = await page.locator("#palette-grid .swatch").count();
  expect(swatches).toBeGreaterThan(1);
  expect(swatches).toBeLessThanOrEqual(8);
  // The trace itself is snapped back to the reduced palette.
  const fills = new Set((await resultSvg(page)).match(/fill="#[0-9A-Fa-f]{6}"/g));
  expect(fills.size).toBeGreaterThan(1);
  expect(fills.size).toBeLessThanOrEqual(8);

  await editFirstSwatch(page, "#00FF00");
  await expect
    .poll(async () => (await resultSvg(page)).match(/fill="#00FF00"/g)?.length ?? 0)
    .toBeGreaterThan(1);
});

test("defringe keeps a reduced cutout to its color count", async ({ page }) => {
  // Thin red and blue stripes meet the cutout edge: averaging them for
  // the defringe paints purple bands the palette never had.
  const stripes = Array.from({ length: 16 }, (_, i) => [
    i % 2 ? "#2040c0" : "#d02020",
    20 + i * 5,
    20,
    5,
    50,
  ]);
  const file = await makePng(page, "stripes.png", 120, 90, CREAM, stripes);
  await traced(page, () => page.locator("#file-input").setInputFiles(file));
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details")) details.open = true;
  });
  await page.locator("#auto-detect").uncheck();
  await traced(page, async () => {
    await page.locator("#colors").fill("4");
    await page.locator("#colors").dispatchEvent("input");
  });
  await traced(page, () => page.locator("#transparent").selectOption("edges"));
  await traced(page, async () => {
    await page.locator("#defringe").fill("3");
    await page.locator("#defringe").dispatchEvent("input");
  });
  // The palette is read from the processed raster: count its colors.
  const rasterColors = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find((entry) => entry.name.includes("/js/context.js")).name;
    const { state } = await import(url);
    const { data } = state.processedRaster;
    const colors = new Set();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] >= 128) colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    }
    return colors.size;
  });
  expect(rasterColors).toBeLessThanOrEqual(4);
  expect(await page.locator("#palette-grid .swatch").count()).toBeLessThanOrEqual(4);
  const fills = new Set((await resultSvg(page)).match(/fill="#[0-9A-Fa-f]{6}"/g));
  expect(fills.size).toBeLessThanOrEqual(4);
});

test("RGB fields are wide enough to show their values", async ({ page }) => {
  await loadShapes(page);
  await page.locator("#palette-grid .swatch").first().click();
  for (const id of ["#palette-r", "#palette-g", "#palette-b"]) {
    expect((await page.locator(id).boundingBox()).width).toBeGreaterThanOrEqual(44);
  }
});

test("hide color toggles transparency and restores the original fill", async ({ page }) => {
  await loadShapes(page);
  const swatch = page.locator("#palette-grid .swatch").first();
  const original = await swatch.getAttribute("data-fill");
  await swatch.click();
  await page.locator("#palette-hide").click();
  await expect(page.locator("#palette-hide")).toHaveText("Show color");
  await expect.poll(() => resultSvg(page)).toContain('fill="none"');
  await expect(swatch).toHaveClass(/hidden-color/);
  await expect(swatch.locator(".swatch-hidden-badge .icon-visibility_off")).toBeVisible();
  await expect(page.locator("#palette-hidden-note")).toBeVisible();
  await expect(page.locator("#palette-hidden-note")).toHaveText("1 color hidden");
  await expect(page.locator("#palette-summary")).toContainText("1 hidden");
  await expect(page.locator("#palette-summary")).not.toContainText("edited");
  await expect(page.locator("#palette-original-hex").locator("..")).toHaveText(
    `Original ${original}, hidden`,
  );
  await expect(swatch).toHaveAttribute("aria-label", `Color ${original} hidden`);
  for (const id of ["color", "hex", "r", "g", "b"]) {
    await expect(page.locator(`#palette-${id}`)).toBeDisabled();
  }
  await expect(page.locator("#palette-edits")).toContainText(`${original} hidden`);
  await page.locator("#palette-hide").click();
  await expect(page.locator("#palette-hide")).toHaveText("Hide color");
  await expect
    .poll(async () => (await resultSvg(page)).toUpperCase())
    .toContain(`FILL="${original}"`);
  await expect(swatch).not.toHaveClass(/hidden-color/);
  await expect(page.locator("#palette-hidden-note")).toBeHidden();
  await expect(page.locator("#palette-edits li")).toHaveCount(0);
});

test("unhiding restores a custom color after closing the editor", async ({ page }) => {
  await loadShapes(page);
  await editFirstSwatch(page, "#00FF00");
  await page.locator("#palette-hide").click();
  await expect.poll(() => resultSvg(page)).toContain('fill="none"');
  await page.locator("#palette-close").click();
  await page.locator("#palette-grid .swatch").first().click();
  await expect(page.locator("#palette-hide")).toHaveText("Show color");
  await page.locator("#palette-hide").click();
  await expect(page.locator("#palette-hide")).toHaveText("Hide color");
  await expect.poll(() => resultSvg(page)).toContain('fill="#00FF00"');
  await expect(page.locator("#palette-hex")).toBeEnabled();
  await expect(page.locator("#palette-hex")).toHaveValue("#00FF00");
});

test("hidden colors offer cutout layering and survive its retrace", async ({ page }) => {
  await loadShapes(page);
  const note = page.locator("#palette-layering-note");
  await expect(note).toBeHidden();
  await page.locator("#palette-grid .swatch").first().click();
  await page.locator("#palette-hide").click();
  await expect(note).toBeVisible();
  await traced(page, () => page.locator("#palette-use-cutout").click());
  await expect(page.locator("#hierarchical")).toHaveValue("cutout");
  await expect(page.locator("#palette-hide")).toHaveText("Show color");
  await expect(note).toBeHidden();
  expect(await resultSvg(page)).toContain('fill="none"');
  await traced(page, () => page.locator("#hierarchical").selectOption("stacked"));
  await expect(note).toBeVisible();
  await page.locator("#palette-reset-all").click();
  await expect(note).toBeHidden();
});
