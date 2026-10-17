import { expect, test } from "@playwright/test";
import path from "node:path";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("guide dialog opens at its heading and returns focus to the menu", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const help = page.locator("summary", { hasText: "Help" });
  await help.focus();
  await page.keyboard.press("Enter");
  await page.locator('[data-action="tracing-guide"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#tracing-guide-title")).toBeFocused();
  const scrollTop = await page.locator("#tracing-guide-dialog form").evaluate((f) => f.scrollTop);
  expect(scrollTop).toBe(0);
  await page.keyboard.press("Escape");
  await expect(help).toBeFocused();
});

test("cleanup toolbar fits a 360px screen", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const fits = await page
    .locator(".header-canvas-tools")
    .evaluate((bar) => bar.scrollWidth <= bar.clientWidth);
  expect(fits).toBe(true);
  await expect(page.locator("#polygon-lasso")).toBeInViewport({ ratio: 1 });
});

test("page heading stays in the accessibility tree on phones", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
});

test("green screen toggle looks different when on", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator("#file-input").setInputFiles(path.resolve("android-chrome-192x192.png"));
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
  const button = page.locator("#green-screen");
  const readStyle = () =>
    button.evaluate((el) => {
      const style = getComputedStyle(el);
      return { boxShadow: style.boxShadow, backgroundColor: style.backgroundColor };
    });
  const before = await readStyle();
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => (await readStyle()).backgroundColor)
    .not.toBe(before.backgroundColor);
  await expect.poll(async () => (await readStyle()).boxShadow).not.toBe(before.boxShadow);
});

test.describe("forced colors", () => {
  test.use({ colorScheme: "dark" });

  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("focus shows an outline", async ({ page }) => {
    await page.keyboard.press("Tab");
    const outline = await page.evaluate(
      () => getComputedStyle(document.activeElement).outlineStyle,
    );
    expect(outline).toBe("solid");
  });

  test("pressed toggle differs from unpressed", async ({ page }) => {
    const bg = (id) => page.locator(id).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await bg("#show-result")).not.toBe(await bg("#show-source"));
  });
});
