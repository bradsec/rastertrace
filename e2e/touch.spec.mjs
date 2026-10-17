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
    await page.locator("#marquee-rect").click();
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

  test("Fill commits the selection and Cancel discards it", async ({ page }) => {
    await page.locator("#marquee-ellipse").click();
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
    await page.locator("#polygon-lasso").click();
    await clickResult(page, [0.2, 0.2]);
    await clickResult(page, [0.7, 0.25]);
    await expect(page.locator("#selection-close")).toBeHidden();
    await clickResult(page, [0.5, 0.7]);
    await expect(page.locator("#selection-close")).toBeVisible();
    await expect(page.locator("#selection-erase")).toBeHidden();
    await page.locator("#selection-close").click();
    await expect(page.locator("#selection-erase")).toBeVisible();
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

  test("a second finger turns an eraser stroke into a pinch zoom", async ({ page }) => {
    await loadImage(page);
    await page.locator("#eraser-tool").click();
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

  test("status and zoom stay on screen while settings scroll", async ({ page }) => {
    await loadImage(page);
    await page.locator("#corner-threshold").scrollIntoViewIfNeeded();
    await expect(page.locator("#status")).toBeInViewport({ ratio: 1 });
    await expect(page.locator("#zoom-reset")).toBeInViewport({ ratio: 1 });
    const box = await page.locator("#zoom-reset").boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(32);
  });

  test("brush tools show size, color and restore options", async ({ page }) => {
    await loadImage(page);
    await expect(page.locator("#eraser-size")).toBeHidden();
    await page.locator("#eraser-tool").click();
    await expect(page.locator("#eraser-size")).toBeVisible();
    await expect(page.locator("#blob-fill-color")).toBeHidden();
    await page.locator("#blob-fill-tool").click();
    await expect(page.locator("#eraser-size")).toBeInViewport({ ratio: 1 });
    await expect(page.locator("#blob-fill-color")).toBeInViewport({ ratio: 1 });
    await dragResult(page, [0.3, 0.3], [0.6, 0.6]);
    await expect(page.locator("#eraser-clear")).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  });
});
