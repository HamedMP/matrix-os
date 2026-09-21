import { defineConfig, devices } from "@playwright/test";

const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const port = Number.parseInt(process.env.PLAYWRIGHT_PORT ?? "3000", 10);
const useDevServer = process.env.PLAYWRIGHT_DEV_SERVER === "1";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /(screenshots|terminal-sizing|getting-started|shared-chat)\.spec\.ts/,
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: `http://localhost:${port}`,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
    launchOptions: {
      ...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: useDevServer
      ? `pnpm dev --webpack -H 127.0.0.1 -p ${port}`
      : `pnpm start -p ${port}`,
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      E2E_TEST_BYPASS: "1",
      NEXT_PUBLIC_E2E_TEST_BYPASS: "1",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_Y2ktc2FmZS5leGFtcGxlLmNvbSQ=",
      NODE_ENV: "test",
    },
  },
});
