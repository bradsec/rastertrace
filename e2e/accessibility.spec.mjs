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

test("cleanup tools fit a 360px screen", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.locator("#file-input").setInputFiles(path.resolve("android-chrome-192x192.png"));
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
  // The folded rail shows the tray toggle, undo and redo; the tray shows all.
  for (const id of ["#tool-tray-toggle", "#eraser-undo", "#eraser-redo"]) {
    await expect(page.locator(id)).toBeInViewport({ ratio: 1 });
  }
  await expect(page.locator("#magic-wand")).toBeHidden();
  await page.locator("#tool-tray-toggle").click();
  await expect(page.locator("#tool-tray-toggle")).toHaveAttribute("aria-expanded", "true");
  for (const id of ["#eraser-tool", "#blob-fill-tool", "#polygon-lasso", "#magic-wand"]) {
    await expect(page.locator(id)).toBeInViewport({ ratio: 1 });
  }
  await page.locator("#magic-wand").click();
  await expect(page.locator("#tool-tray-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#magic-wand")).toBeVisible();
  await expect(page.locator("#eraser-tool")).toBeHidden();
  await expect(page.locator("#wand-tolerance")).toBeInViewport({ ratio: 1 });
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
  // The swatch is the backdrop color itself, so the pressed state shows as
  // a ring and border rather than a fill change.
  const readStyle = () =>
    button.evaluate((el) => {
      const style = getComputedStyle(el);
      return { boxShadow: style.boxShadow, borderColor: style.borderColor };
    });
  const before = await readStyle();
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await readStyle()).borderColor).not.toBe(before.borderColor);
  await expect.poll(async () => (await readStyle()).boxShadow).not.toBe(before.boxShadow);
});

test("backdrop toggles show one background at a time", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator("#file-input").setInputFiles(path.resolve("android-chrome-192x192.png"));
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
  const preview = page.locator("#preview");
  const background = () => preview.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.locator("#white-screen").click();
  await expect.poll(background).toBe("rgb(255, 255, 255)");
  await page.locator("#black-screen").click();
  await expect.poll(background).toBe("rgb(0, 0, 0)");
  await expect(page.locator("#white-screen")).toHaveAttribute("aria-pressed", "false");
  await page.locator("#green-screen").click();
  await expect.poll(background).toBe("rgb(0, 177, 64)");
  await expect(page.locator("#black-screen")).toHaveAttribute("aria-pressed", "false");
  await page.locator("#green-screen").click();
  await expect(preview).toHaveClass(/checkerboard/);
  await expect(preview).not.toHaveClass(/green-screen|white-screen|black-screen/);
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
