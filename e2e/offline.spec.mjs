// The service worker caches the page and every versioned asset as they
// load, so a second visit works offline.
import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "allow" });

test("the app caches itself and reloads offline", async ({ page, context }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  // The first load ran before the worker took control.
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  await page.locator("#try-sample").click();
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });

  const cached = () =>
    page.evaluate(async () => {
      const urls = [];
      for (const key of await caches.keys()) {
        for (const request of await (await caches.open(key)).keys()) urls.push(request.url);
      }
      return urls.map((url) => new URL(url).pathname);
    });
  // WebKit fetches a worker's main script past the service worker, so
  // only the page's own assets and the worker's imports are checked.
  await expect
    .poll(cached)
    .toEqual(expect.arrayContaining(["/", "/js/app.js", "/js/preprocess.js"]));
  expect((await cached()).some((p) => p.endsWith(".wasm"))).toBe(true);

  // Playwright's WebKit fails offline navigations with "internal error"
  // even with every asset cached, so only Chromium reloads.
  if (test.info().project.name !== "chromium") return;
  await context.setOffline(true);
  await page.reload();
  await page.locator("#try-sample").click();
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
  await context.setOffline(false);
});
