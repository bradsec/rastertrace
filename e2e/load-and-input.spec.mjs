import { expect, test } from "@playwright/test";
import path from "node:path";

const IMAGE = path.resolve("android-chrome-192x192.png");
const NOT_AN_IMAGE = {
  name: "broken.png",
  mimeType: "image/png",
  buffer: Buffer.from("not an image"),
};

async function traced(page, action) {
  await page.evaluate(() => (document.getElementById("status").textContent = ""));
  await action();
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
}

async function eraseStroke(page) {
  await page.locator("#eraser-tool").click();
  const box = await page.locator("#result-view").boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("#eraser-undo")).toBeEnabled();
}

/** Phones fold the tool rail to the chosen tool; open the tray when needed. */
async function chooseTool(page, id) {
  const tool = page.locator(id);
  if (!(await tool.isVisible())) await page.locator("#tool-tray-toggle").click();
  await tool.click();
}

const transform = (page) => page.locator("#pan-stage").evaluate((el) => el.style.transform);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("sample image loads and traces", async ({ page }) => {
  await page.goto("/");
  await page.locator("#try-sample").click();
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
});

test("View image actions require a loaded sample while panel actions follow folding", async ({
  page,
}) => {
  const menu = page.locator(".app-menu").filter({ has: page.getByText("View", { exact: true }) });
  const imageActions = [
    "show-result",
    "show-source",
    "show-compare",
    "rotate-left",
    "rotate-right",
    "invert-image",
    "zoom-fit",
    "zoom-actual",
    "zoom-in",
    "zoom-out",
  ];
  await page.setViewportSize({ width: 1440, height: 900 });
  // Folded panels would otherwise enable their items: with no image there
  // are no panels to show.
  await page.evaluate(() =>
    localStorage.setItem("rastertrace:folded", JSON.stringify({ left: true, right: true })),
  );
  await page.reload();
  const left = menu.locator('[data-action="toggle-left-panel"]');
  const right = menu.locator('[data-action="toggle-right-panel"]');
  const both = menu.locator('[data-action="toggle-panels"]');

  await menu.locator("summary").click();
  for (const action of imageActions) {
    await expect(menu.locator(`[data-action="${action}"]`)).toBeDisabled();
  }
  await expect(left).toBeDisabled();
  await expect(right).toBeDisabled();
  await expect(both).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.evaluate(() => localStorage.removeItem("rastertrace:folded"));
  await page.reload();
  await menu.locator("summary").click();
  await expect(both).toBeDisabled();
  await page.keyboard.press("Escape");
  const initialTransform = await transform(page);
  for (const key of ["Control+0", "Control+1", "Meta+0", "Meta+1", "+", "-"]) {
    await page.keyboard.press(key);
  }
  expect(await transform(page)).toBe(initialTransform);
  await expect(page.locator("#empty-state")).toBeVisible();

  await traced(page, () => page.locator("#try-sample").click());
  await menu.locator("summary").click();
  for (const action of imageActions) {
    await expect(menu.locator(`[data-action="${action}"]`)).toBeEnabled();
  }
  await expect(left).toBeDisabled();
  await expect(right).toBeDisabled();
  await expect(both).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.locator("#fold-left").click();
  await menu.locator("summary").click();
  await expect(left).toBeEnabled();
  await expect(right).toBeDisabled();
  await left.click();
  await expect(left).toBeDisabled();
  await expect(page.locator("#fold-left")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Control+\\");
  await expect(left).toBeEnabled();
  await expect(right).toBeEnabled();
  await expect(both).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(left).toBeDisabled();
  await expect(right).toBeDisabled();
  await expect(both).toBeEnabled();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(left).toBeEnabled();
  await expect(right).toBeEnabled();
});

test("each sample click loads a different sample image", async ({ page }) => {
  const samples = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/assets/samples/")) samples.push(pathname);
  });
  await page.goto("/");
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => (document.getElementById("status").textContent = ""));
    if (i === 0) {
      await page.locator("#try-sample").click();
    } else {
      // After the first image the empty-state button is gone; File offers it.
      await page.locator(".app-menu summary", { hasText: "File" }).click();
      await page.locator('[data-action="open-sample"]').click();
    }
    await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
  }
  expect(samples).toHaveLength(3);
  expect(samples[1]).not.toBe(samples[0]);
  expect(samples[2]).not.toBe(samples[1]);
});

test.describe("opening files", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a file that fails to open keeps the current trace", async ({ page }) => {
    await traced(page, () => page.locator("#file-input").setInputFiles(IMAGE));
    const paths = await page.locator("#stat-paths").textContent();
    await page.locator("#file-input").setInputFiles(NOT_AN_IMAGE);
    await expect(page.locator("#error")).toBeVisible();
    await expect(page.locator("#stat-paths")).toHaveText(paths);
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#zoom-reset")).toBeInViewport({ ratio: 1 });
    await page.locator("#error-dismiss").click();
    await expect(page.locator("#error")).toBeHidden();
  });

  test("a file that fails to open from the empty state stays on it", async ({ page }) => {
    await page.locator("#file-input").setInputFiles(NOT_AN_IMAGE);
    await expect(page.locator("#error")).toBeVisible();
    await expect(page.locator("#empty-state")).toBeVisible();
  });

  test("replacing an image with cleanup asks first", async ({ page }) => {
    await traced(page, () => page.locator("#file-input").setInputFiles(IMAGE));
    await eraseStroke(page);
    let asked = 0;
    page.once("dialog", (dialog) => {
      asked++;
      dialog.dismiss();
    });
    await page.locator("#file-input").setInputFiles(IMAGE);
    await expect.poll(() => asked).toBe(1);
    await expect(page.locator("#eraser-undo")).toBeEnabled();
    page.once("dialog", (dialog) => dialog.accept());
    await traced(page, () => page.locator("#file-input").setInputFiles(IMAGE));
    await expect(page.locator("#eraser-undo")).toBeDisabled();
  });
});

test.describe("preview navigation", () => {
  test("arrow keys pan the preview", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await traced(page, () => page.locator("#file-input").setInputFiles(IMAGE));
    await page.locator("#preview").focus();
    await page.keyboard.press("+");
    const zoomed = await transform(page);
    await page.keyboard.press("ArrowRight");
    const step = await transform(page);
    expect(step).not.toBe(zoomed);
    await page.keyboard.press("Shift+ArrowDown");
    expect(await transform(page)).not.toBe(step);
  });

  test("one finger scrolls the page past a fitted phone preview", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await traced(page, () => page.locator("#file-input").setInputFiles(IMAGE));
    const touchAction = () =>
      page.locator("#preview").evaluate((el) => getComputedStyle(el).touchAction);
    expect(await touchAction()).toBe("pan-y");
    await chooseTool(page, "#eraser-tool");
    expect(await touchAction()).toBe("none");
    await page.locator("#eraser-tool").click();
    await page.locator("#zoom-in").click();
    expect(await touchAction()).toBe("none");
  });
});

test.describe("touch devices", () => {
  test.use({ hasTouch: true, viewport: { width: 1180, height: 820 } });

  test("controls meet 44px touch targets", async ({ page }) => {
    await traced(page, () => page.locator("#file-input").setInputFiles(IMAGE));
    const small = await page.evaluate(() => {
      const selector =
        ".header-tool, .header-action, .app-menu summary, .panel > summary, .advanced > summary, .button, .toggle, select";
      return [...document.querySelectorAll(selector)]
        .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")
        .map((el) => ({
          el: el.id || el.className || el.tagName,
          h: el.getBoundingClientRect().height,
        }))
        .filter(({ h }) => h < 43.5);
    });
    expect(small).toEqual([]);
  });

  test("text inputs use 16px text so iOS does not zoom on focus", async ({ page }) => {
    await traced(page, () => page.locator("#file-input").setInputFiles(IMAGE));
    await page.evaluate(() => {
      for (const details of document.querySelectorAll("details.panel")) details.open = true;
    });
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('input[type="text"], input[type="number"], select')]
        .filter((el) => el.getClientRects().length)
        .map((el) => ({ id: el.id, size: parseFloat(getComputedStyle(el).fontSize) }))
        .filter(({ size }) => size < 16),
    );
    expect(small).toEqual([]);
  });

  test("empty state invites a tap instead of a drop", async ({ page }) => {
    await expect(page.locator(".tap-copy")).toBeVisible();
    await expect(page.locator(".drop-copy")).toBeHidden();
    const chooser = page.waitForEvent("filechooser");
    await page.locator(".dropzone-hint").click();
    await chooser;
  });
});

test.describe("desktop editor habits", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  const resultSvg = (page) =>
    page
      .locator("#result-view")
      .evaluate(async (img) => (await fetch(/** @type {HTMLImageElement} */ (img).src)).text());

  test("the SVG names one group per color in Mosaic layering", async ({ page }) => {
    await traced(page, () => page.locator("#file-input").setInputFiles(IMAGE));
    const stacked = [...(await resultSvg(page)).matchAll(/\sid="(color-[^"]*)"/g)].map((m) => m[1]);
    expect(stacked.length).toBeGreaterThan(0);
    expect(new Set(stacked).size).toBe(stacked.length);

    await traced(page, () => page.locator("#hierarchical").selectOption("cutout"));
    const mosaic = [...(await resultSvg(page)).matchAll(/\sid="(color-[^"]*)"/g)].map((m) => m[1]);
    expect(mosaic.length).toBeGreaterThan(0);
    for (const id of mosaic) expect(id).toMatch(/^color-[0-9a-f]{6}$/);
    expect(new Set(mosaic).size).toBe(mosaic.length);
  });

  test("Ctrl+0 fits the preview", async ({ page }) => {
    await traced(page, () => page.locator("#file-input").setInputFiles(IMAGE));
    await page.locator("#zoom-in").click();
    expect(await transform(page)).not.toContain("scale(1)");
    await page.keyboard.press("Control+0");
    // Fit is the only state labelled "Fit"; transform strings differ by engine.
    await expect(page.locator("#zoom-reset")).toHaveText("Fit");
  });

  test("holding Space pans over an active eraser without erasing", async ({ page }) => {
    await traced(page, () => page.locator("#file-input").setInputFiles(IMAGE));
    await page.locator("#eraser-tool").click();
    const box = await page.locator("#result-view").boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect(page.locator(".tool-rail")).toHaveCSS("opacity", "1");
    await expect(page.locator("#eraser-size")).toBeVisible();
    await page.keyboard.down("Space");
    await expect(page.locator("#preview")).toHaveClass(/space-pan/);
    await expect(page.locator("#preview")).toHaveCSS("cursor", "grab");
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5 + 60, box.y + box.height * 0.5 + 40, {
      steps: 4,
    });
    await page.mouse.up();
    await page.keyboard.up("Space");
    // Focus stayed on the eraser button: Space must not have toggled it off.
    await expect(page.locator("#preview")).toHaveClass(/erasing/);
    await expect(page.locator("#preview")).not.toHaveClass(/space-pan/);
    await expect(page.locator("#eraser-undo")).toBeDisabled();
    expect(await transform(page)).toContain("translate(60px, 40px)");
  });

  test("the Move tool and H put the active cleanup tool away", async ({ page }) => {
    await traced(page, () => page.locator("#file-input").setInputFiles(IMAGE));
    const move = page.locator("#move-tool");
    await expect(move).toHaveAttribute("aria-pressed", "true");
    await page.locator("#eraser-tool").click();
    await expect(move).toHaveAttribute("aria-pressed", "false");
    await move.click();
    await expect(page.locator("#eraser-tool")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#preview")).not.toHaveClass(/erasing/);
    await expect(move).toHaveAttribute("aria-pressed", "true");
    // Rotate steps aside only for a real tool's options.
    await expect(page.locator(".rotate-group")).toBeVisible();
    await page.locator("#magic-wand").click();
    await page.locator("#preview").focus();
    await page.keyboard.press("h");
    await expect(page.locator("#magic-wand")).toHaveAttribute("aria-pressed", "false");
    await expect(move).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("side panels", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("each panel folds to a rail and remembers it across reloads", async ({ page }) => {
    await traced(page, () => page.locator("#file-input").setInputFiles(IMAGE));
    const preview = page.locator(".preview-pane");
    const wide = (await preview.boundingBox()).width;

    await page.locator("#fold-left").click();
    await expect(page.locator("#fold-left")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#fold-left")).toHaveAccessibleName(
      "Show profile, colors and palette",
    );
    await expect(page.locator("#export-profile")).toBeHidden();
    expect((await preview.boundingBox()).width).toBeGreaterThan(wide + 150);

    await page.reload();
    await traced(page, () => page.locator("#file-input").setInputFiles(IMAGE));
    await expect(page.locator("#export-profile")).toBeHidden();
    await expect(page.locator("#speckle")).toBeVisible();
    await page.locator("#fold-left").click();
    await expect(page.locator("#export-profile")).toBeVisible();
  });

  test("Ctrl+backslash hides both panels, then shows both", async ({ page }) => {
    await traced(page, () => page.locator("#file-input").setInputFiles(IMAGE));
    await page.keyboard.press("Control+\\");
    await expect(page.locator("#export-profile")).toBeHidden();
    await expect(page.locator("#colors")).toBeHidden();
    await expect(page.locator("#fold-right")).toBeVisible();
    await page.keyboard.press("Control+\\");
    await expect(page.locator("#export-profile")).toBeVisible();
    await expect(page.locator("#colors")).toBeVisible();
  });

  test("narrow desktops start with the profiles folded", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.reload();
    await traced(page, () => page.locator("#file-input").setInputFiles(IMAGE));
    await expect(page.locator("#export-profile")).toBeHidden();
    await expect(page.locator("#speckle")).toBeVisible();
  });
});

test.describe("tool rail", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("each tool shows its own options in the preview strip", async ({ page }) => {
    await traced(page, () => page.locator("#file-input").setInputFiles(IMAGE));
    await expect(page.locator("#tool-tray-toggle")).toBeHidden();
    await expect(page.locator("#rotate-left")).toBeVisible();
    for (const id of ["#eraser-size", "#blob-fill-color", "#sel-mode-new", "#wand-tolerance"]) {
      await expect(page.locator(id)).toBeHidden();
    }

    await page.locator("#magic-wand").click();
    await expect(page.locator("#wand-tolerance")).toBeVisible();
    await expect(page.locator("#sel-mode-add")).toBeVisible();
    await expect(page.locator("#eraser-size")).toBeHidden();
    // Rotate and invert step aside while a tool works on the result.
    await expect(page.locator("#rotate-left")).toBeHidden();
    await expect(page.locator("#show-result")).toBeVisible();

    await page.locator("#blob-fill-tool").click();
    await expect(page.locator("#eraser-size")).toBeVisible();
    await expect(page.locator("#blob-fill-hex")).toBeVisible();
    await expect(page.locator("#wand-tolerance")).toBeHidden();

    await page.keyboard.press("Escape");
    await expect(page.locator("#blob-fill-tool")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#rotate-left")).toBeVisible();
  });
});
