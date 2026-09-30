import { defineConfig, devices } from "@playwright/test";

const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const port = Number.parseInt(process.env.PLAYWRIGHT_PORT ?? "3000", 10);
const useDevServer = process.env.PLAYWRIGHT_DEV_SERVER === "1";
// The account-only collaboration frame renders only when the shell process is
// the platform surface, so it gets its own server instead of switching the
// customer-computer shell the other specs exercise.
const platformFramePort = port + 1;
const serverCommand = (serverPort: number) => useDevServer
  ? `pnpm dev --webpack -H 127.0.0.1 -p ${serverPort}`
  : `pnpm start -p ${serverPort}`;
const serverEnv = {
  E2E_TEST_BYPASS: "1",
  NEXT_PUBLIC_E2E_TEST_BYPASS: "1",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_Y2ktc2FmZS5leGFtcGxlLmNvbSQ=",
  NODE_ENV: "test",
};

export default defineConfig({
  testDir: "./e2e",
  testMatch: /(screenshots|terminal-sizing|getting-started|shared-chat|collaboration-frame)\.spec\.ts/,
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
  projects: [
    {
      name: "shell",
      testIgnore: /collaboration-frame\.spec\.ts/,
    },
    {
      name: "platform-frame",
      testMatch: /collaboration-frame\.spec\.ts/,
      use: { baseURL: `http://localhost:${platformFramePort}` },
    },
  ],
  webServer: [
    {
      command: serverCommand(port),
      port,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: serverEnv,
    },
    {
      command: serverCommand(platformFramePort),
      port: platformFramePort,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { ...serverEnv, MATRIX_SHELL_SURFACE: "platform" },
    },
  ],
});
