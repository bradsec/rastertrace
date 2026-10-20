import { expect, test } from "@playwright/test";
import path from "node:path";

const viewports = [
  { name: "wide-desktop", width: 1920, height: 1080 },
  { name: "crowded-desktop", width: 1760, height: 900 },
  { name: "desktop", width: 1536, height: 864 },
  { name: "laptop", width: 1366, height: 768 },
  { name: "small-laptop", width: 1024, height: 768 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile-landscape", width: 844, height: 390 },
  { name: "mobile", width: 390, height: 844 },
];

const overlaps = (a, b) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

for (const viewport of viewports) {
  test(`${viewport.name} keeps navigation and workspace within the viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");

    await expect(page.locator(".app-header")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );

    const menubar = await page.locator(".menubar").boundingBox();
    const actions = await page.locator(".topbar-actions").boundingBox();
    expect(menubar).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(overlaps(menubar, actions)).toBe(false);

    await page.locator("#file-input").setInputFiles(path.resolve("android-chrome-192x192.png"));
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
    await expect(page.locator("#tracing-veil")).toBeHidden();

    const workspace = await page.locator("#workspace").boundingBox();
    const preview = await page.locator(".preview-pane").boundingBox();
    const right = await page.locator(".controls-right").boundingBox();
    expect(workspace.width).toBeLessThanOrEqual(viewport.width);
    // The cleanup tools live on the preview's left edge, under its strip.
    const rail = await page.locator(".tool-rail").boundingBox();
    const strip = await page.locator(".canvas-strip").boundingBox();
    expect(rail.x).toBeGreaterThanOrEqual(preview.x);
    expect(rail.y).toBeGreaterThanOrEqual(strip.y + strip.height - 1);
    await expect(page.locator("#tool-tray-toggle")).toBeVisible({ visible: viewport.width <= 680 });

    if (viewport.width <= 680) {
      // Phones: section tabs under the preview, one section (Colors) below,
      // drawn from both columns: the colors panel and noise cleanup.
      const tabs = await page.locator(".sheet-tabs").boundingBox();
      await expect(page.locator("#colors")).toBeVisible();
      await expect(page.locator("#speckle")).toBeVisible();
      await expect(page.locator("#export-profile")).toBeHidden();
      await expect(page.locator('[data-sheet="palette"]')).toBeHidden();
      expect(preview.y).toBeLessThan(tabs.y);
      expect(tabs.y).toBeLessThan(right.y);
      expect(right.width).toBeLessThanOrEqual(viewport.width);
      return;
    }
    const left = await page.locator(".controls-left").boundingBox();
    if (viewport.width > 900) {
      expect(left.y).toBe(preview.y);
      expect(preview.y).toBe(right.y);
      expect(left.x + left.width).toBeLessThanOrEqual(preview.x + 1);
      expect(preview.x + preview.width).toBeLessThanOrEqual(right.x + 1);
    } else {
      expect(preview.y).toBeLessThan(left.y);
      expect(left.y).toBeLessThan(right.y);
      expect(left.width).toBeLessThanOrEqual(viewport.width);
      expect(right.width).toBeLessThanOrEqual(viewport.width);
    }
  });
}
