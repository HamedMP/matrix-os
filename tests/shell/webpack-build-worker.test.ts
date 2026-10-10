import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { NextConfig } from "next";
import { afterEach, describe, expect, it, vi } from "vitest";

const shell = resolve(import.meta.dirname, "../../shell");
const requireShell = createRequire(resolve(shell, "package.json"));
const { default: loadConfig } = requireShell("next/dist/server/config.js") as typeof import("next/dist/server/config.js");
const { PHASE_PRODUCTION_BUILD } = requireShell("next/constants.js") as typeof import("next/constants.js");
type ConfigExport = NextConfig | ((phase: string, context: { defaultConfig: NextConfig }) => NextConfig | Promise<NextConfig>);
async function resolveProductionConfig(config: ConfigExport): Promise<NextConfig> {
  return typeof config === "function"
    ? await config(PHASE_PRODUCTION_BUILD, { defaultConfig: {} })
    : config;
}

describe("production Webpack worker boundaries", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([false, true])("retains worker parallelism and source aliases with PostHog release wrapper=%s", async (release) => {
    vi.stubEnv("POSTHOG_API_KEY", release ? "test-personal-key" : "");
    vi.stubEnv("POSTHOG_PROJECT_ID", release ? "test-project-id" : "");
    vi.stubEnv("GATEWAY_URL", "http://localhost:4000");
    vi.resetModules();
    const { default: exported } = await import("../../shell/next.config.ts");
    const userConfig = await resolveProductionConfig(exported);
    // Next caches config per directory/phase. Separate owned directories keep
    // the two actual production-loader cases independent.
    const fixture = mkdtempSync(resolve(tmpdir(), "matrix-next-workers-"));
    try {
      const config = await loadConfig(PHASE_PRODUCTION_BUILD, fixture, { customConfig: userConfig, silent: true });
      expect(config.experimental?.webpackBuildWorker).toBe(true);
      expect(config.experimental?.parallelServerCompiles).toBe(true);
      expect(config.experimental?.parallelServerBuildTraces).toBe(true);
      expect(config.reactCompiler).toBe(true);
      const configureWebpack = config.webpack;
      if (!configureWebpack) throw new Error("Source extension aliases require the Webpack hook");
      const input = { resolve: { extensionAlias: { ".mjs": [".mjs"] } }, plugins: [] } as Parameters<NonNullable<NextConfig["webpack"]>>[0];
      const output = configureWebpack(input, { isServer: false } as Parameters<typeof configureWebpack>[1]);
      expect(output.resolve.extensionAlias).toMatchObject({
        ".js": [".ts", ".tsx", ".js"], ".jsx": [".tsx", ".jsx"], ".mjs": [".mjs"],
      });
      const rewrites = await config.rewrites?.();
      expect(rewrites).toContainEqual({ source: "/health", destination: "http://localhost:4000/health" });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
