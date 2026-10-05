import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
import type { ElectronApplication } from "playwright";

const root = resolve(__dirname, "../..");
const require = createRequire(resolve(root, "packages/mcp-browser/package.json"));
const { _electron } = require("playwright") as typeof import("playwright");

it.skipIf(process.env.MATRIX_PROVIDER_AUTH_ELECTRON !== "1")(
  "routes exact connection options through the shared Settings UI in Electron",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "matrix-provider-auth-e2e-"));
    let electron: ElectronApplication | undefined;
    try {
      const common = { absWorkingDir: root, bundle: true, logLevel: "silent" as const };
      await build({ ...common, entryPoints: ["desktop/src/preload/index.ts"], platform: "node", format: "cjs", external: ["electron"], outfile: join(dir, "preload.cjs") });
      await build({ ...common, entryPoints: ["tests/e2e/fixtures/provider-authorization-main.ts"], platform: "node", format: "cjs", external: ["electron"], outfile: join(dir, "main.cjs") });
      await build({ ...common, entryPoints: ["tests/e2e/fixtures/provider-authorization-shell.tsx"], platform: "browser", format: "iife", jsx: "automatic", outfile: join(dir, "shell.js"), define: { "process.env.NODE_ENV": '"test"' } });
      electron = await _electron.launch({
        executablePath: createRequire(resolve(root, "desktop/package.json"))("electron"),
        args: [join(dir, "main.cjs")],
        env: { ...process.env, PROVIDER_AUTH_FIXTURE_DATA: join(dir, "profile") },
      });
      const page = await electron.firstWindow();
      const evidence = () => page.evaluate(async () => (await fetch("/evidence")).json());
      const anthropic = page.getByRole("button", { name: /Anthropic API key/ });
      await anthropic.waitFor();
      expect(await page.getByRole("button", { name: /OpenRouter API key/ }).isDisabled()).toBe(true);
      expect(await page.getByText("Advanced configuration", { exact: true }).count()).toBe(0);
      await anthropic.click();
      await page.getByLabel("Paste your Anthropic API key").fill("synthetic-only-key");
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await page.getByText("Connected on this computer", { exact: true }).waitFor();
      expect(await page.getByLabel("Paste your Anthropic API key").count()).toBe(0);
      await page.getByRole("button", { name: "Change account", exact: true }).click();
      await page.getByRole("button", { name: /Claude account · Sign in in Terminal/ }).click();
      await page.getByRole("button", { name: "Continue in Terminal", exact: true }).waitFor();
      await expect.poll(() => page.getByRole("status").filter({ hasText: "Terminal opened: tws_fixture:tt_fixture" }).count()).toBe(1);
      await expect.poll(evidence).toMatchObject({
        requests: [
          { method: "GET", path: "/api/ai/provider-settings/workflows/v2/capabilities" },
          { method: "POST", path: "/api/ai/provider-settings/workflows/v2/keys", harnessInstanceId: "claude", optionId: "anthropic_api_key", keyLength: 18 },
          { method: "POST", path: "/api/ai/provider-settings/workflows/v2/start", harnessInstanceId: "claude", optionId: "anthropic_terminal" },
        ],
      });
      expect((await evidence()).requests.every((row: { path: string }) => row.path.includes("/v2/"))).toBe(true);
      expect(await page.evaluate(() => typeof (window as unknown as { operator?: unknown }).operator)).toBe("object");
    } finally {
      await electron?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000,
);
