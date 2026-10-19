import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: ".playwright-artifacts",
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:8137",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    // A reload while the worker is still installing raced it in CI WebKit.
    // e2e/upgrade.spec.mjs and e2e/offline.spec.mjs test it, waiting for
    // it to be ready, and opt back in.
    serviceWorkers: "block",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Safari on iPad: WebKit with touch and an iPad viewport.
    { name: "ipad", use: { ...devices["iPad Pro 11"] } },
  ],
  webServer: {
    command: "npm run serve -- --bind 127.0.0.1",
    url: "http://127.0.0.1:8137",
    reuseExistingServer: true,
  },
});
