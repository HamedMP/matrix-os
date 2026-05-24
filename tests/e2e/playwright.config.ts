import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /onboarding-(activation|visual)\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: "http://localhost:3000",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "test -d ../../shell/.next || { echo 'Missing shell/.next build. Run `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_bWF0cml4b3MudGVzdCQ= pnpm --dir shell build` before onboarding E2E.' >&2; exit 1; }; pnpm --dir ../../shell start",
    port: 3000,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      E2E_TEST_BYPASS: "1",
      NODE_ENV: "test",
    },
  },
});
