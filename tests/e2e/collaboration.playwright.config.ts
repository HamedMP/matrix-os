import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./collaboration",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./fixtures/collaboration-global-setup.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: {
    screenshot: "only-on-failure",
    // Direct API probes carry bearer tokens. Playwright network traces would retain them.
    trace: "off",
    ...devices["Desktop Chrome"],
  },
  projects: [
    { name: "phone", use: { viewport: { width: 390, height: 844 } } },
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
  ],
});
