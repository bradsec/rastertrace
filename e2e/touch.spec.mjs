import { expect, test } from "@playwright/test";
import path from "node:path";

async function loadImage(page) {
  await page.locator("#file-input").setInputFiles(path.resolve("android-chrome-192x192.png"));
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
  await expect(page.locator("#tracing-veil")).toBeHidden();
}

/** Drag across the result between two normalized points. */
async function dragResult(page, [x1, y1], [x2, y2]) {
  const box = await page.locator("#result-view").boundingBox();
  await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * x2, box.y + box.height * y2, { steps: 4 });
  await page.mouse.up();
}

/** Phones fold the tool rail to the chosen tool; open the tray when needed. */
async function chooseTool(page, id) {
  const tool = page.locator(id);
  if (!(await tool.isVisible())) await page.locator("#tool-tray-toggle").click();
  await tool.click();
}

async function clickResult(page, [x, y]) {
  const box = await page.locator("#result-view").boundingBox();
  await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test.describe("selection actions", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loadImage(page);
  });

  test("a finished marquee offers Erase, Fill and Cancel", async ({ page }) => {
    const actions = page.locator("#selection-actions");
    await expect(actions).toBeHidden();
    await chooseTool(page, "#marquee-rect");
    await dragResult(page, [0.2, 0.2], [0.6, 0.6]);
    await expect(actions).toBeVisible();
    for (const id of ["#selection-erase", "#selection-fill", "#selection-cancel"]) {
      const box = await page.locator(id).boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      await expect(page.locator(id)).toBeInViewport({ ratio: 1 });
    }
    await page.locator("#selection-erase").click();
    await expect(actions).toBeHidden();
    await expect(page.locator("#eraser-undo")).toBeEnabled();
  });

  test("wand selection actions clear the status bar on a short phone", async ({ page }) => {
    // Safari's toolbars leave an iPhone about this tall, and the wand's
    // sliders push the preview pane under the sticky status bar.
    await page.setViewportSize({ width: 390, height: 664 });
    await chooseTool(page, "#magic-wand");
    await clickResult(page, [0.5, 0.5]);
    await expect(page.locator("#selection-actions")).toBeVisible();
    const bar = await page.locator(".statusbar").boundingBox();
    for (const id of ["#selection-erase", "#selection-fill", "#selection-cancel"]) {
      await expect(page.locator(id)).toBeInViewport({ ratio: 1 });
      const box = await page.locator(id).boundingBox();
      expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
    }
  });

  test("Fill commits the selection and Cancel discards it", async ({ page }) => {
    await chooseTool(page, "#marquee-ellipse");
    await dragResult(page, [0.2, 0.2], [0.6, 0.6]);
    await page.locator("#selection-cancel").click();
    await expect(page.locator("#selection-actions")).toBeHidden();
    await expect(page.locator("#selection-overlay")).toBeHidden();
    await expect(page.locator("#eraser-undo")).toBeDisabled();
    await dragResult(page, [0.2, 0.2], [0.6, 0.6]);
    await page.locator("#selection-fill").click();
    await expect(page.locator("#eraser-undo")).toBeEnabled();
  });

  test("an open lasso can be closed with a button", async ({ page }) => {
    await chooseTool(page, "#polygon-lasso");
    await clickResult(page, [0.2, 0.2]);
    await clickResult(page, [0.7, 0.25]);
    await expect(page.locator("#selection-close")).toBeHidden();
    await clickResult(page, [0.5, 0.7]);
    await expect(page.locator("#selection-close")).toBeVisible();
    await expect(page.locator("#selection-erase")).toBeHidden();
    await page.locator("#selection-close").click();
    await expect(page.locator("#selection-erase")).toBeVisible();
  });

  test("Backspace removes the last lasso point and keeps drawing", async ({ page }) => {
    await chooseTool(page, "#polygon-lasso");
    await clickResult(page, [0.2, 0.2]);
    await clickResult(page, [0.7, 0.25]);
    await clickResult(page, [0.5, 0.7]);
    await expect(page.locator("#selection-close")).toBeVisible();
    await page.keyboard.press("Backspace");
    await expect(page.locator("#status")).toContainText("Last polygon point removed");
    await expect(page.locator("#selection-close")).toBeHidden();
    await expect(page.locator("#selection-overlay")).toBeVisible();
    await expect(page.locator("#eraser-undo")).toBeDisabled();
    await clickResult(page, [0.4, 0.8]);
    await expect(page.locator("#selection-close")).toBeVisible();
  });
});

test.describe("touch gestures", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  /** Send raw touch points through CDP: [[x, y], ...] per step. */
  const sessions = new WeakMap();
  async function touch(page, type, points) {
    if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
    await sessions.get(page).send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map(([x, y], id) => ({ x, y, id })),
    });
  }

  test("a second finger turns an eraser stroke into a pinch zoom", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "multi-touch is driven through Chromium's CDP");
    await loadImage(page);
    await chooseTool(page, "#eraser-tool");
    const box = await page.locator("#result-view").boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await touch(page, "touchStart", [[cx - 20, cy]]);
    await touch(page, "touchMove", [[cx - 30, cy]]);
    await touch(page, "touchStart", [
      [cx - 30, cy],
      [cx + 20, cy],
    ]);
    await touch(page, "touchMove", [
      [cx - 60, cy],
      [cx + 60, cy],
    ]);
    await touch(page, "touchMove", [
      [cx - 90, cy],
      [cx + 90, cy],
    ]);
    await touch(page, "touchEnd", []);
    await expect(page.locator("#eraser-undo")).toBeDisabled();
    const transform = await page.locator("#pan-stage").evaluate((el) => el.style.transform);
    expect(transform).not.toContain("scale(1)");
    await expect(page.locator("#eraser-tool")).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("small screens", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("section tabs show one settings section at a time", async ({ page }) => {
    await loadImage(page);
    const tab = (name) => page.locator(`[data-sheet-tab="${name}"]`);
    await expect(tab("colors")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#colors")).toBeVisible();
    await expect(page.locator("#export-profile")).toBeHidden();

    await tab("presets").click();
    await expect(tab("presets")).toHaveAttribute("aria-pressed", "true");
    await expect(tab("colors")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#export-profile")).toBeVisible();
    await expect(page.locator("#colors")).toBeHidden();

    // A section folded on desktop still opens when its tab is chosen.
    await page.evaluate(() => (document.querySelector('[data-sheet="export"]').open = false));
    await tab("export").click();
    await expect(page.locator("#export-size")).toBeVisible();
  });

  test("restored settings offer Reset and Keep beside the preview", async ({ page }) => {
    await loadImage(page);
    await page.locator('[data-sheet-tab="tracing"]').click();
    await page.locator("#straighten").fill("3");
    await page.reload();
    await loadImage(page);
    const note = page.locator("#restored-note");
    await expect(note).toBeInViewport();
    await note.getByRole("button", { name: "Keep" }).click();
    await expect(note).toBeHidden();
    await expect(page.locator("#straighten")).toHaveValue("3");

    await page.reload();
    await loadImage(page);
    await note.getByRole("button", { name: "Reset to defaults" }).click();
    await expect(note).toBeHidden();
    await expect(page.locator("#status")).toContainText("Settings reset");
    await expect(page.locator("#straighten")).toHaveValue("1");
  });

  test("status and zoom stay on screen while settings scroll", async ({ page }) => {
    await loadImage(page);
    await page.locator('[data-sheet-tab="tracing"]').click();
    await page.locator("#corner-threshold").scrollIntoViewIfNeeded();
    await expect(page.locator("#status")).toBeInViewport({ ratio: 1 });
    await expect(page.locator("#zoom-reset")).toBeInViewport({ ratio: 1 });
    const box = await page.locator("#zoom-reset").boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(32);
  });

  test("brush tools show size, color and restore options", async ({ page }) => {
    await loadImage(page);
    await expect(page.locator("#eraser-size")).toBeHidden();
    await chooseTool(page, "#eraser-tool");
    await expect(page.locator("#eraser-size")).toBeVisible();
    await expect(page.locator("#blob-fill-color")).toBeHidden();
    await chooseTool(page, "#blob-fill-tool");
    await expect(page.locator("#eraser-size")).toBeInViewport({ ratio: 1 });
    await expect(page.locator("#blob-fill-color")).toBeInViewport({ ratio: 1 });
    await dragResult(page, [0.3, 0.3], [0.6, 0.6]);
    await expect(page.locator("#eraser-clear")).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  });
});

test("changing brush size previews the diameter on the result", async ({ page }) => {
  await loadImage(page);
  await chooseTool(page, "#blob-fill-tool");
  const cursor = page.locator("#eraser-cursor");
  await expect(cursor).toBeHidden();
  await page.locator("#eraser-size").fill("60");
  await expect(cursor).toBeVisible();
  // Drawn at the stroke's on-screen size: brush px scaled by the zoom.
  const expected = await page.evaluate(async () => {
    const img = /** @type {HTMLImageElement} */ (document.querySelector("#result-view"));
    const svg = await (await fetch(img.src)).text();
    const viewBoxWidth = Number(/viewBox="[\d.-]+ [\d.-]+ ([\d.]+)/.exec(svg)[1]);
    return (60 * img.getBoundingClientRect().width) / viewBoxWidth;
  });
  const box = await cursor.boundingBox();
  expect(Math.abs(box.width - expected)).toBeLessThan(3);
  await expect(cursor).toBeHidden({ timeout: 3000 });
});
