import { expect, test } from "@playwright/test";
import path from "node:path";

async function loadImage(page) {
  await page.locator("#file-input").setInputFiles(path.resolve("android-chrome-192x192.png"));
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
  await expect(page.locator("#tracing-veil")).toBeHidden();
}

/** Phones fold the tool rail to the chosen tool; open the tray when needed. */
async function chooseTool(page, id) {
  const tool = page.locator(id);
  if (!(await tool.isVisible())) await page.locator("#tool-tray-toggle").click();
  await tool.click();
}

/** Each image's clip-path inset as [top, right, bottom, left]; sides are percents. */
async function clipEdges(page) {
  return page.evaluate(() => {
    const inset = (id) =>
      getComputedStyle(document.getElementById(id))
        .clipPath.match(/-?[\d.]+(%|px)?/g)
        .map(parseFloat);
    return { source: inset("source-view"), result: inset("result-view") };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await loadImage(page);
});

test("Compare stacks source left of result at the divider", async ({ page }) => {
  await page.locator("#show-compare").click();
  await expect(page.locator("#show-compare")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#show-result")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#source-view")).toBeVisible();
  await expect(page.locator("#result-view")).toBeVisible();

  const source = await page.locator("#source-view").boundingBox();
  const result = await page.locator("#result-view").boundingBox();
  expect(source).toEqual(result);

  const divider = page.getByRole("slider", { name: "Compare divider" });
  await expect(divider).toBeVisible();
  await expect(divider).toHaveAttribute("aria-valuenow", "50");
  const handle = await page.locator("#compare-handle").boundingBox();
  expect(handle.width).toBeGreaterThanOrEqual(44);
  expect(handle.height).toBeGreaterThanOrEqual(44);

  // inset(top right bottom left): the source keeps the left side, the result the right.
  const { source: s, result: r } = await clipEdges(page);
  expect(100 - s[1]).toBeCloseTo(r[3], 1);
  expect(r[3]).toBeGreaterThan(0);
  expect(r[3]).toBeLessThan(100);

  await page.locator("#show-result").click();
  await expect(page.locator("#source-view")).toBeHidden();
  await expect(divider).toBeHidden();
});

test("arrow keys move the divider and the position survives a reload", async ({ page }) => {
  await page.locator("#show-compare").click();
  const divider = page.getByRole("slider", { name: "Compare divider" });
  await divider.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", "49");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", "59");
  await page.keyboard.press("Home");
  await expect(divider).toHaveAttribute("aria-valuenow", "0");
  await page.keyboard.press("End");
  await expect(divider).toHaveAttribute("aria-valuenow", "100");
  await page.keyboard.press("PageDown");
  await expect(divider).toHaveAttribute("aria-valuenow", "90");
  // The preview's own arrow-key pan must not run.
  await expect(page.locator("#zoom-reset")).toHaveText("Fit");

  await page.reload();
  await loadImage(page);
  await page.locator("#show-compare").click();
  await expect(divider).toHaveAttribute("aria-valuenow", "90");
});

test("dragging the handle moves the divider without panning", async ({ page }) => {
  await page.locator("#show-compare").click();
  const preview = await page.locator("#preview").boundingBox();
  const handle = await page.locator("#compare-handle").boundingBox();
  const startX = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  const targetX = preview.x + preview.width * 0.25;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(targetX, y, { steps: 5 });
  await page.mouse.up();

  const divider = page.getByRole("slider", { name: "Compare divider" });
  await expect(divider).toHaveAttribute("aria-valuenow", "25");
  await expect(page.locator("#zoom-reset")).toHaveText("Fit");
});

test("the divider follows zoom: clip edges stay under the screen line", async ({ page }) => {
  await page.locator("#show-compare").click();
  await page.locator("#zoom-in").click();
  const preview = await page.locator("#preview").boundingBox();
  const image = await page.locator("#result-view").boundingBox();
  const { result: r } = await clipEdges(page);
  const screenX = image.x + (image.width * r[3]) / 100;
  expect(screenX).toBeCloseTo(preview.x + preview.width / 2, 0);
});

test("a cleanup tool switches Compare back to Result", async ({ page }) => {
  await page.locator("#show-compare").click();
  await chooseTool(page, "#eraser-tool");
  await expect(page.locator("#show-result")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#source-view")).toBeHidden();
  await expect(page.locator("#compare-divider")).toBeHidden();
  const clip = await page.locator("#result-view").evaluate((el) => getComputedStyle(el).clipPath);
  expect(clip).toBe("none");
});

test("phones keep one-finger page scroll outside the handle", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#show-compare").click();
  const touchAction = (selector) =>
    page.locator(selector).evaluate((el) => getComputedStyle(el).touchAction);
  expect(await touchAction("#preview")).toBe("pan-y");
  expect(await touchAction("#compare-handle")).toBe("none");
  const handle = await page.locator("#compare-handle").boundingBox();
  await expect(page.locator("#compare-handle")).toBeInViewport();
  expect(handle.width).toBeGreaterThanOrEqual(44);
});

test("the preview labels which image it shows", async ({ page }) => {
  const sourceLabel = page.locator("#view-label-source");
  const resultLabel = page.locator("#view-label-result");
  await expect(sourceLabel).toBeHidden();
  await expect(resultLabel).toBeHidden();

  await page.locator("#show-source").click();
  await expect(sourceLabel).toBeVisible();
  await expect(sourceLabel).toHaveText("Source (original)");
  await expect(resultLabel).toBeHidden();

  await page.locator("#show-compare").click();
  await expect(sourceLabel).toHaveText("Source", { useInnerText: true });
  await expect(resultLabel).toBeVisible();
  const handle = await page.locator("#compare-handle").boundingBox();
  const source = await sourceLabel.boundingBox();
  const result = await resultLabel.boundingBox();
  expect(source.x + source.width).toBeLessThan(handle.x + handle.width / 2);
  expect(result.x).toBeGreaterThan(handle.x + handle.width / 2);

  await page.locator("#show-result").click();
  await expect(sourceLabel).toBeHidden();
  await expect(resultLabel).toBeHidden();
});

test("changing a setting on Source shows the result once it traces", async ({ page }) => {
  await page.locator("#show-source").click();
  await page.locator("#simplify").fill("5");
  await expect(page.locator("#show-result")).toHaveAttribute("aria-pressed", "true", {
    timeout: 60_000,
  });
  await expect(page.locator("#source-view")).toBeHidden();
});

test("Compare stays put when a setting changes", async ({ page }) => {
  await page.locator("#show-compare").click();
  await page.locator("#simplify").fill("5");
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
  await expect(page.locator("#tracing-veil")).toBeHidden();
  await expect(page.locator("#show-compare")).toHaveAttribute("aria-pressed", "true");
});

test("editing a palette color on Source shows the result", async ({ page }) => {
  // The left panel's fold state is chosen at load from the window width.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.reload();
  await loadImage(page);
  await page.locator("#show-source").click();
  await page.locator("#palette-grid .swatch").first().click();
  await page.locator("#palette-hex").fill("#336699");
  await expect(page.locator("#show-result")).toHaveAttribute("aria-pressed", "true");
});
