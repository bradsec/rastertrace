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
    for (const details of document.querySelectorAll("aside details")) details.open = true;
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

test("auto-detect finds every color of a JPEG logo and traces them all", async ({ page }) => {
  // Compression spreads each flat color over many near shades; the small
  // red accent is what exact-color detection used to miss.
  const base64 = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(400, 300);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f2e8cf";
    ctx.fillRect(0, 0, 400, 300);
    ctx.fillStyle = "#1d3557";
    ctx.fillRect(40, 40, 200, 160);
    ctx.fillStyle = "#2a9d8f";
    ctx.beginPath();
    ctx.arc(300, 150, 70, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e63946";
    ctx.fillRect(60, 230, 30, 30);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.75 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  const file = { name: "logo.jpg", mimeType: "image/jpeg", buffer: Buffer.from(base64, "base64") };
  await traced(page, () => page.locator("#file-input").setInputFiles(file));
  await openPanels(page);
  await expect(page.locator("#colors")).toHaveValue("4");
  await expect(page.locator("#palette-grid .swatch")).toHaveCount(4);
});

test("auto-detect stays on while Merge recounts Max colors", async ({ page }) => {
  // Two browns 10 apart (sum of channel differences) on cream.
  const file = await makePng(page, "close.png", 160, 120, CREAM, [
    ["#3c281e", 20, 30, 50, 60],
    ["#46281e", 90, 30, 50, 60],
  ]);
  const colors = page.locator("#colors");
  const autoDetect = page.locator("#auto-detect");
  await traced(page, () => page.locator("#file-input").setInputFiles(file));
  await openPanels(page);
  await expect(colors).toHaveValue("3");
  await expect(page.locator("#layer-diff")).toHaveValue("5");

  await setRange(page, "#layer-diff", 20);
  await expect(autoDetect).toBeChecked();
  await expect(colors).toHaveValue("2");

  await setRange(page, "#layer-diff", 4);
  await expect(colors).toHaveValue("3");

  await setRange(page, "#speckle", 4);
  await expect(autoDetect).toBeChecked();
});

test("Balanced keeps auto-detect on and stays selected across images", async ({ page }) => {
  const three = await makePng(page, "three.png", 160, 120, CREAM, [
    ["#3c281e", 20, 30, 50, 60],
    ["#2a9d8f", 90, 30, 50, 60],
  ]);
  const two = await makePng(page, "two.png", 160, 120, CREAM, [["#3c281e", 40, 30, 80, 60]]);
  await traced(page, () => page.locator("#file-input").setInputFiles(three));
  await openPanels(page);
  await traced(page, () => page.locator("#export-profile").selectOption("balanced"));
  await expect(page.locator("#auto-detect")).toBeChecked();
  // Flat art keeps its own colors instead of the profile's 256.
  await expect(page.locator("#colors")).toHaveValue("3");

  await traced(page, () => page.locator("#file-input").setInputFiles(two));
  await expect(page.locator("#export-profile")).toHaveValue("balanced");
  await expect(page.locator("#colors")).toHaveValue("2");
});

test("the Profile section folds and names the current profile", async ({ page }) => {
  const file = await makePng(page, "mark.png", 160, 120, CREAM, [["#3c281e", 40, 30, 80, 60]]);
  await traced(page, () => page.locator("#file-input").setInputFiles(file));
  const summary = page.locator('details[data-panel-key="profile"] > summary');
  await expect(page.locator("#profile-summary")).toHaveText("Custom");
  await traced(page, () => page.locator("#export-profile").selectOption("vinyl"));
  await expect(page.locator("#profile-summary")).toHaveText("Vinyl & cutting (layers)");
  await expect(page.locator("#hierarchical")).toHaveValue("cutout");

  await summary.click();
  await expect(page.locator("#export-profile")).toBeHidden();
  await page.reload();
  await expect(page.locator("#export-profile")).toBeHidden();
  await expect(page.locator("#profile-summary")).toHaveText("Vinyl & cutting (layers)");
});

test("thin lines survive on a large image", async ({ page }) => {
  // 2400 px traces at 0.85x: a 2 px line is under 2 trace px wide, which
  // the tracer's own speck filter used to drop however long it was.
  const file = await makePng(page, "lines.png", 2400, 1800, "#ffffff", [
    ["#000000", 150, 150, 450, 450],
    ["#000000", 240, 1050, 1920, 2],
  ]);
  await traced(page, () => page.locator("#file-input").setInputFiles(file));
  const red = await page.evaluate(async () => {
    const view = /** @type {HTMLImageElement} */ (document.getElementById("result-view"));
    const img = new Image();
    img.src = view.src;
    await img.decode();
    const ctx = new OffscreenCanvas(2400, 1800).getContext("2d");
    ctx.drawImage(img, 0, 0, 2400, 1800);
    return ctx.getImageData(1200, 1051, 1, 1).data[0];
  });
  expect(red).toBeLessThan(128);
});

test("Pixel exact keeps lone pixels", async ({ page }) => {
  // 256 px wide: the old profile's auto upscale and speckle dropped them.
  const dots = [];
  for (let y = 4; y < 256; y += 16)
    for (let x = 4; x < 256; x += 16) dots.push(["#ff4060", x, y, 1, 1]);
  const file = await makePng(page, "dots.png", 256, 256, "#203040", dots);
  await traced(page, () => page.locator("#file-input").setInputFiles(file));
  await traced(page, () => page.locator("#export-profile").selectOption("pixelExact"));
  const svg = await page.evaluate(async () => {
    const view = /** @type {HTMLImageElement} */ (document.getElementById("result-view"));
    return (await fetch(view.src)).text();
  });
  expect((svg.match(/<path/g) || []).length).toBe(dots.length + 1);
});

test("white stencil ink exports one color and previews on black", async ({ page }) => {
  const file = await makePng(page, "mark.png", 160, 120, CREAM, [["#3c281e", 40, 30, 80, 60]]);
  await traced(page, () => page.locator("#file-input").setInputFiles(file));
  await traced(page, () => page.locator("#export-profile").selectOption("monoWhite"));
  await expect(page.locator("#black-screen")).toHaveAttribute("aria-pressed", "true");
  const svg = await page.evaluate(async () => {
    const view = /** @type {HTMLImageElement} */ (document.getElementById("result-view"));
    return (await fetch(view.src)).text();
  });
  expect(svg).not.toContain("<rect");
  const fills = new Set([...svg.matchAll(/fill="([^"]*)"/g)].map((m) => m[1].toLowerCase()));
  expect([...fills]).toEqual(["#ffffff"]);
});

test("reset settings re-detects colors for the current image", async ({ page }) => {
  const flat = await makePng(page, "flat.png", 120, 120, CREAM, [["#3c281e", 30, 30, 60, 60]]);
  const colors = page.locator("#colors");
  await traced(page, () => page.locator("#file-input").setInputFiles(flat));
  await openPanels(page);
  await setRange(page, "#colors", 8);
  await expect(page.locator("#auto-detect")).not.toBeChecked();

  await traced(page, () => page.locator("#reset-settings").click());
  await expect(page.locator("#auto-detect")).toBeChecked();
  await expect(colors).toHaveValue("2");
});

test("reset settings keeps the preferred measurement unit", async ({ page }) => {
  const flat = await makePng(page, "flat.png", 120, 120, CREAM, [["#3c281e", 30, 30, 60, 60]]);
  await traced(page, () => page.locator("#file-input").setInputFiles(flat));
  await openPanels(page);
  await page.locator("#export-size").selectOption("physical");
  await page.locator("#physical-unit").selectOption("in");
  await page.locator("#reset-settings").click();
  await expect(page.locator("#status")).toContainText("Settings reset");
  await expect(page.locator("#physical-unit")).toHaveValue("in");
});

test("a change made just before reload is kept", async ({ page }) => {
  const flat = await makePng(page, "flat.png", 120, 120, CREAM, [["#3c281e", 30, 30, 60, 60]]);
  await traced(page, () => page.locator("#file-input").setInputFiles(flat));
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("aside details")) details.open = true;
  });
  await page.locator("#straighten").fill("3");
  // No wait for the save debounce: leaving the page must flush it.
  await page.reload();
  await expect(page.locator("#straighten")).toHaveValue("3");
});

test("controls the trace ignores are disabled", async ({ page }) => {
  const flat = await makePng(page, "flat.png", 120, 120, CREAM, [["#3c281e", 30, 30, 60, 60]]);
  await traced(page, () => page.locator("#file-input").setInputFiles(flat));
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("aside details")) details.open = true;
  });
  const curves = ["#simplify", "#corner-threshold", "#length-threshold", "#splice-threshold"];
  for (const id of [...curves, "#colors", "#layer-diff", "#grayscale"]) {
    await expect(page.locator(id)).toBeEnabled();
  }
  await traced(page, () => page.locator('input[name="mode"][value="polygon"]').check());
  for (const id of curves) await expect(page.locator(id)).toBeDisabled();
  await traced(page, () => page.locator("#stencil").check());
  for (const id of ["#colors", "#layer-diff", "#grayscale"]) {
    await expect(page.locator(id)).toBeDisabled();
  }
  await page.locator("#reset-settings").click();
  for (const id of [...curves, "#colors", "#layer-diff", "#grayscale"]) {
    await expect(page.locator(id)).toBeEnabled();
  }
});

test("Simplify sets the curve settings and shows Custom after hand edits", async ({ page }) => {
  const flat = await makePng(page, "flat.png", 120, 120, CREAM, [["#3c281e", 30, 30, 60, 60]]);
  await traced(page, () => page.locator("#file-input").setInputFiles(flat));
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("aside details")) details.open = true;
  });
  const out = page.locator("#simplify-out");
  await expect(out).toHaveText("3");

  await setRange(page, "#simplify", 6);
  await expect(page.locator("#length-threshold")).toHaveValue("10");
  await expect(page.locator("#splice-threshold")).toHaveValue("90");
  await expect(out).toHaveText("6");

  await setRange(page, "#splice-threshold", 85);
  await expect(out).toHaveText("Custom");
  await expect(page.locator("#length-threshold")).toHaveValue("10");

  // Profiles set the curve settings, and Simplify follows them.
  await traced(page, () => page.locator("#export-profile").selectOption("detail"));
  await expect(out).toHaveText("2");

  await page.reload();
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("aside details")) details.open = true;
  });
  await expect(out).toHaveText("2");
  await expect(page.locator("#simplify")).toHaveValue("2");
});

test("folded settings sections show their current value", async ({ page }) => {
  const flat = await makePng(page, "flat.png", 120, 120, CREAM, [["#3c281e", 30, 30, 60, 60]]);
  await traced(page, () => page.locator("#file-input").setInputFiles(flat));
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("aside details")) details.open = true;
  });
  await setRange(page, "#colors", 12);
  await traced(page, () => page.locator('input[name="mode"][value="polygon"]').check());
  await page.locator("#export-size").selectOption("physical");
  await page.locator("#physical-width").fill("250");
  await page.locator("#physical-width").dispatchEvent("input");
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("aside details")) details.open = false;
  });
  await expect(page.locator("#colors-summary")).toHaveText("12 colors");
  await expect(page.locator("#tracing-summary")).toHaveText("Polygon");
  await expect(page.locator("#export-summary")).toContainText("250");
  await expect(page.locator("#colors-summary")).toBeVisible();
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

test.describe("saved presets", () => {
  const openSettingsPanels = (page) =>
    page.evaluate(() => {
      for (const details of document.querySelectorAll("aside details")) details.open = true;
    });

  async function savePreset(page, name) {
    await page.locator("#save-preset").click();
    await page.locator("#preset-name").fill(name);
    await page.locator("#save-preset-dialog button[value='save']").click();
    await expect(page.locator("#status")).toContainText(`Profile "${name}" saved.`);
  }

  test("a saved preset restores its settings and survives a reload", async ({ page }) => {
    const flat = await makePng(page, "flat.png", 120, 120, CREAM, [["#3c281e", 30, 30, 60, 60]]);
    await traced(page, () => page.locator("#file-input").setInputFiles(flat));
    await openSettingsPanels(page);
    // Each change retraces; let it land so its status does not replace
    // the saved message.
    await traced(page, () => page.locator("#export-profile").selectOption("print"));
    await traced(page, () => page.locator("#straighten").fill("3"));
    await page.locator("#export-size").selectOption("physical");
    await page.locator("#physical-width").fill("250");
    await savePreset(page, "Client logo");
    await expect(page.locator("#export-profile")).toHaveValue("user:Client logo");

    await page.locator("#reset-settings").click();
    await expect(page.locator("#straighten")).not.toHaveValue("3");
    await page.locator("#export-profile").selectOption("user:Client logo");
    await expect(page.locator("#straighten")).toHaveValue("3");
    await expect(page.locator("#physical-width")).toHaveValue("250");
    await expect(page.locator("#auto-detect")).not.toBeChecked();

    // Settings save on a short debounce; reload only once it has landed.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("rastertrace-settings")))
      .toContain('"profile":"user:Client logo"');
    await page.reload();
    await expect(page.locator("#export-profile")).toHaveValue("user:Client logo");
    await expect(page.locator('#export-profile optgroup[label="My profiles"] option')).toHaveText([
      "Client logo",
    ]);
  });

  test("presets export, delete, and import again", async ({ page }) => {
    const flat = await makePng(page, "flat.png", 120, 120, CREAM, [["#3c281e", 30, 30, 60, 60]]);
    await traced(page, () => page.locator("#file-input").setInputFiles(flat));
    await savePreset(page, "Laser job");
    page.on("dialog", (dialog) => dialog.accept());

    await page.locator('[data-action="manage-presets"]').evaluate((el) => el.click());
    await expect(page.locator("#preset-list li")).toHaveCount(1);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#preset-export").click(),
    ]);
    const file = await download.path();

    await page.getByRole("button", { name: "Delete profile Laser job" }).click();
    await expect(page.locator("#preset-list li")).toHaveCount(0);
    await expect(page.locator("#preset-empty")).toBeVisible();
    await expect(page.locator("#export-profile")).toHaveValue("");

    await page.locator("#preset-import-input").setInputFiles(file);
    await expect(page.locator("#preset-message")).toHaveText("Imported 1 profile.");
    await expect(page.locator("#preset-list li")).toHaveText(["Laser jobDelete"]);

    await page.locator("#preset-import-input").setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from("{not json"),
    });
    await expect(page.locator("#preset-message")).toHaveText(
      "No rastertrace profiles found in that file.",
    );
  });
});

test("a color preset sets Colors only", async ({ page }) => {
  const flat = await makePng(page, "flat.png", 120, 120, CREAM, [["#3c281e", 30, 30, 60, 60]]);
  await traced(page, () => page.locator("#file-input").setInputFiles(flat));
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("aside details")) details.open = true;
  });
  await page.locator("#speckle").fill("20");
  await page.locator("#layer-diff").fill("50");
  await page.locator("#preset").selectOption("4");
  await expect(page.locator("#colors")).toHaveValue("4");
  await expect(page.locator("#speckle")).toHaveValue("20");
  await expect(page.locator("#layer-diff")).toHaveValue("50");
  // The preset names a color count, so it follows the Colors slider only.
  await page.locator("#speckle").fill("10");
  await expect(page.locator("#preset")).toHaveValue("4");
  await page.locator("#colors").fill("5");
  await expect(page.locator("#preset")).toHaveValue("");
});

test("My colors traces with only the swatches given", async ({ page }) => {
  const art = await makePng(page, "art.png", 120, 120, "#f8f8f8", [
    ["#c03020", 10, 10, 40, 40],
    ["#2040b0", 60, 60, 50, 50],
  ]);
  await traced(page, () => page.locator("#file-input").setInputFiles(art));
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("aside details")) details.open = true;
  });
  await page.locator("#color-source").selectOption("custom");
  await expect(page.locator("#swatch-empty")).toBeVisible();
  await expect(page.locator("#colors")).toBeEnabled();

  await traced(page, async () => {
    await page.locator("#swatch-input").fill("#ff0000, #0000ff #ffffff");
    await page.locator("#swatch-input").press("Enter");
  });
  await expect(page.locator("#swatch-list [data-swatch]")).toHaveCount(3);
  await expect(page.locator("#colors")).toBeDisabled();
  await expect(page.locator("#preset")).toBeDisabled();
  const svg = await page
    .locator("#result-view")
    .evaluate(async (img) => (await fetch(/** @type {HTMLImageElement} */ (img).src)).text());
  const fills = new Set(
    [...svg.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase()),
  );
  expect([...fills].sort()).toEqual(["#0000FF", "#FF0000", "#FFFFFF"]);

  await traced(page, () => page.getByRole("button", { name: "Remove #FFFFFF" }).click());
  await expect(page.locator("#swatch-list [data-swatch]")).toHaveCount(2);

  await traced(page, () =>
    page.locator("#swatch-file").setInputFiles({
      name: "brand.gpl",
      mimeType: "text/plain",
      buffer: Buffer.from("GIMP Palette\nName: Brand\n#\n255 255 255 Paper\n200 40 30 Red\n"),
    }),
  );
  await expect(page.locator("#swatch-note")).toHaveText("Imported 2 colors from brand.gpl.");
  await expect(page.locator("#swatch-list [data-swatch]")).toHaveCount(2);
});
