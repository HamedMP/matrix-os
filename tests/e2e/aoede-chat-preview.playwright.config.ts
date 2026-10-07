import { defineConfig } from "@playwright/test";

// Use the matching test CLI: node node_modules/@playwright/test/cli.js test --config tests/e2e/aoede-chat-preview.playwright.config.ts
export default defineConfig({
  testDir: ".",
  testMatch: "aoede-chat-preview.spec.ts",
  workers: 1,
  outputDir: "../../node_modules/.cache/aoede-chat-preview",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:5207", headless: true, channel: "chrome" },
  webServer: {
    command: "pnpm exec vite --config tests/fixtures/aoede/ui-fixture/vite.config.ts --host 127.0.0.1 --port 5207 --strictPort",
    cwd: "../..",
    url: "http://127.0.0.1:5207",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
