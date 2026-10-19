// On touch screens any box wider than its scroll container lets the whole
// panel or dialog drag sideways. A grid column sized to a select's text or
// a fixed minimum did that on iPad and iPhone; check every panel state and
// dialog at tablet and phone widths.
import { devices, expect, test } from "@playwright/test";

// Rows of tabs and tools that scroll sideways on purpose.
const INTENDED = [".sheet-tabs", ".header-canvas-tools"];

function overflowing(intended) {
  const found = [];
  const candidates = [document.scrollingElement, ...document.querySelectorAll("*")];
  for (const el of candidates) {
    if (!el || intended.some((selector) => el.matches(selector))) continue;
    const style = getComputedStyle(el);
    const scrolls = el === document.scrollingElement || /auto|scroll/.test(style.overflowX);
    if (!scrolls || el.clientWidth === 0) continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      found.push(`${el.tagName.toLowerCase()}#${el.id}.${[...el.classList].join(".")}`);
    }
  }
  return found;
}

// iOS zooms the page when a focused field's text is under 16px.
function smallFields() {
  return [...document.querySelectorAll('input[type="text"], input[type="number"], select')]
    .filter((el) => el.getClientRects().length)
    .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
    .map((el) => el.id || el.className);
}

const DEVICES = {
  "iPad portrait": devices["iPad Pro 11"],
  "iPad landscape": devices["iPad Pro 11 landscape"],
  iPhone: devices["iPhone 13"],
  "small phone": { ...devices["iPhone SE"], viewport: { width: 320, height: 568 } },
};

for (const [name, device] of Object.entries(DEVICES)) {
  test(`${name}: no panel or dialog scrolls sideways`, async ({ browser }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({ ...device });
    const page = await context.newPage();
    await page.goto("/");
    await page.locator("#try-sample").click();
    await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });

    // Every section open and every conditional field shown, with the
    // longest select options chosen.
    await page.evaluate(() => {
      for (const [id, value] of [
        ["color-source", "custom"],
        ["export-size", "physical"],
      ]) {
        const select = /** @type {HTMLSelectElement} */ (document.getElementById(id));
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      for (const details of document.querySelectorAll("aside details")) details.open = true;
      for (const el of document.querySelectorAll("aside [hidden]")) el.hidden = false;
    });
    expect(await page.evaluate(overflowing, INTENDED)).toEqual([]);
    expect(await page.evaluate(smallFields)).toEqual([]);

    for (const action of [
      "tracing-guide",
      "cleanup-guide",
      "export-guide",
      "about",
      "preferences",
      "manage-presets",
    ]) {
      await page.evaluate((a) => document.querySelector(`[data-action="${a}"]`).click(), action);
      await expect(page.locator("dialog[open]")).toBeVisible();
      expect(await page.evaluate(overflowing, INTENDED), action).toEqual([]);
      expect(await page.evaluate(smallFields), action).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(page.locator("dialog[open]")).toHaveCount(0);
    }
    await page.evaluate(() => document.getElementById("save-preset").click());
    await expect(page.locator("#save-preset-dialog")).toBeVisible();
    expect(await page.evaluate(overflowing, INTENDED)).toEqual([]);
    expect(await page.evaluate(smallFields)).toEqual([]);
    await context.close();
  });
}

test("double-tap does not zoom the interface", async ({ page }) => {
  await page.goto("/");
  // manipulation keeps pinch zoom and scrolling but drops double-tap zoom.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe(
    "manipulation",
  );
});
