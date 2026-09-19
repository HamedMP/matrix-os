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

it.skipIf(process.env.MATRIX_APP_AI_ELECTRON !== "1")("runs legacy kernel tasks and new AI text calls through real Electron isolation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "matrix-app-ai-e2e-"));
  let electron: ElectronApplication | undefined;
  try {
    const common = { absWorkingDir: root, bundle: true, logLevel: "silent" as const };
    await build({ ...common, entryPoints: ["desktop/src/preload/index.ts"], platform: "node", format: "cjs", external: ["electron"], outfile: join(dir, "preload.cjs") });
    await build({ ...common, entryPoints: ["tests/e2e/fixtures/app-ai-main.ts"], platform: "node", format: "cjs", external: ["electron", "bufferutil", "utf-8-validate"], outfile: join(dir, "main.cjs") });
    await build({ ...common, entryPoints: ["tests/e2e/fixtures/app-ai-shell.ts"], platform: "browser", format: "iife", outfile: join(dir, "shell.js"),
      alias: { "@": resolve(root, "shell/src"), "@matrix-os/observability/client": resolve(root, "packages/observability/src/client.ts") },
      define: { "process.env.NODE_ENV": '"test"' }, loader: { ".svg": "dataurl", ".png": "dataurl" },
    });
    electron = await _electron.launch({ executablePath: createRequire(resolve(root, "desktop/package.json"))("electron"), args: [join(dir, "main.cjs")], env: { ...process.env, APP_AI_FIXTURE_DATA: join(dir, "profile") } });
    await expect.poll(() => electron!.windows().length).toBe(2);
    const page = electron.windows().find((page) => page.url().includes("/apps/"))!;
    const result = await page.evaluate(async () => {
      const bridge = (window as unknown as { MatrixOS: { generate(context: string): void; ai: { generate(input: { prompt: string }): Promise<{ text: string }> }; gatewayFetch?: unknown }; operator?: unknown });
      const legacy = bridge.MatrixOS.generate("Read my notes");
      const text = await bridge.MatrixOS.ai.generate({ prompt: "Summarize supplied text" });
      return { legacyIsVoid: legacy === undefined, text, privileged: typeof bridge.operator, gatewayFetch: typeof bridge.MatrixOS.gatewayFetch };
    });
    expect(result).toEqual({ legacyIsVoid: true, text: { text: "synthetic completion" }, privileged: "undefined", gatewayFetch: "undefined" });
    await expect.poll(async () => page.evaluate(async () => (await fetch("/evidence")).json())).toMatchObject({
      frames: [{ type: "message", text: "[App: owner/brain] Read my notes", requestId: expect.any(String) }],
      requests: [{ app: "owner/brain", prompt: "Summarize supplied text" }],
    });
  } finally {
    await electron?.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
