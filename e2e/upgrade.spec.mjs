// Returning visitors run the new release on top of the previous one's
// service worker cache, which serves ?v= assets cache-first. A module
// changed without a new ?v= stays stale there, and a fresh browser never
// sees it: 1.1.88 shipped a stale palette-ui.js that read an empty state.
// This test serves the previous release, lets its service worker cache
// it, switches the same origin to the working tree, and checks that the
// palette and cleanup tools still see the trace.
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

// One port per worker: the chromium and ipad projects run this in parallel.
let port;
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};
const repo = path.resolve(".");

/** Latest commit whose package.json version differs from the working tree's. */
function previousRelease() {
  if (process.env.UPGRADE_FROM) return process.env.UPGRADE_FROM;
  const current = JSON.parse(readFileSync("package.json", "utf8")).version;
  const commits = execFileSync("git", ["log", "--format=%H", "--", "package.json"], {
    encoding: "utf8",
  }).split("\n");
  for (const commit of commits.filter(Boolean)) {
    const file = execFileSync("git", ["show", `${commit}:package.json`], { encoding: "utf8" });
    if (JSON.parse(file).version !== current) return commit;
  }
  return null;
}

let dir;
let server;
let base;

test.beforeAll(async () => {
  port = 8140 + test.info().workerIndex;
  try {
    base = previousRelease();
  } catch {
    base = null; // no git history (shallow or exported tree)
  }
  test.skip(!base, "needs git history with a previous release");
  dir = mkdtempSync(path.join(tmpdir(), "rastertrace-upgrade-"));
  execFileSync("sh", ["-c", `mkdir old && git -C "${repo}" archive ${base} | tar -x -C old`], {
    cwd: dir,
  });
  symlinkSync(path.join(dir, "old"), path.join(dir, "live"));
  // Serving through a symlink lets the test swap releases on one origin,
  // which the service worker and its cache are tied to. no-cache keeps
  // the browser's HTTP cache out of it: only the service worker caches.
  const live = path.join(dir, "live");
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const file = path.join(
      live,
      decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname),
    );
    try {
      const body = readFileSync(file);
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
});

test.afterAll(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const versionAt = (tree) =>
  JSON.parse(readFileSync(path.join(tree, "package.json"), "utf8")).version;

function serve(tree) {
  rmSync(path.join(dir, "live"));
  symlinkSync(tree, path.join(dir, "live"));
}

async function traceSample(page) {
  await page.evaluate(() => (document.getElementById("status").textContent = ""));
  await page.locator("#try-sample").click();
  await expect(page.locator("#status")).toContainText(/Traced \d/, { timeout: 60_000 });
}

test("the working tree works on top of the previous release's cache", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  // The first load ran before the worker took control: reload so every
  // asset, the trace worker and wasm included, passes through its cache.
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  await expect(page.locator("#app-version")).toContainText(versionAt(path.join(dir, "old")));
  await traceSample(page);

  serve(repo);
  await page.reload();
  await expect(page.locator("#app-version")).toContainText(versionAt(repo));
  await traceSample(page);

  // Palette and cleanup modules must share the app's state: a stale copy
  // sees no trace, so the swatch grid stays empty and strokes do nothing.
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("aside details")) details.open = true;
  });
  await expect(page.locator("#palette-pick")).toBeEnabled();
  expect(await page.locator("#palette-grid [role=listitem]").count()).toBeGreaterThan(0);
  await page.locator("#eraser-tool").click();
  const box = await page.locator("#result-view").boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("#eraser-undo")).toBeEnabled();
  expect(errors).toEqual([]);
  await context.close();
});
