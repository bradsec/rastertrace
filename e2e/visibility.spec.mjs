// Behavior tests pass even when a control is styled out of sight (a
// stray selector once set the cleanup toolbar to opacity 0). Check that
// the controls people reach for are actually visible, at each project's
// own viewport (desktop Chrome and iPad).
import { expect, test } from "@playwright/test";
import path from "node:path";

const visible = async (locator) => {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  // toBeVisible ignores opacity; a control faded to 0 is still hidden.
  expect(
    await locator.evaluate((el) => {
      for (let node = el; node; node = node.parentElement) {
        if (getComputedStyle(node).opacity === "0") return false;
      }
      return true;
    }),
  ).toBe(true);
};

test("key controls are visible once an image is loaded", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator("#file-input").setInputFiles(path.resolve("android-chrome-192x192.png"));
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });

  for (const id of [
    "eraser-tool",
    "blob-fill-tool",
    "marquee-rect",
    "marquee-ellipse",
    "polygon-lasso",
    "magic-wand",
  ]) {
    await visible(page.locator(`#${id}`));
  }
  // Size and color controls show while a brush tool needs them.
  await page.locator("#eraser-tool").click();
  await visible(page.locator("#eraser-size"));
  await page.locator("#blob-fill-tool").click();
  await visible(page.locator("#blob-fill-hex"));
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    for (const details of document.querySelectorAll("aside details")) details.open = true;
  });
  for (const id of [
    "export-profile",
    "save-preset",
    "preset",
    "color-source",
    "colors",
    "simplify",
    "palette-pick",
    "hierarchical",
  ]) {
    await visible(page.locator(`#${id}`));
  }
});
