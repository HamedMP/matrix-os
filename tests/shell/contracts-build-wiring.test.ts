import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextConfig } from "next";
import nextConfig from "../../shell/next.config";

type NextConfigExport = NextConfig | ((
  phase: string,
  context: { defaultConfig: NextConfig },
) => NextConfig | Promise<NextConfig>);

async function resolveNextConfig(config: NextConfigExport): Promise<NextConfig> {
  return typeof config === "function"
    ? await config("phase-production-build", { defaultConfig: nextConfig })
    : config;
}

function expectNodeNextSourceAliases(config: NextConfig): void {
  const configureWebpack = config.webpack;
  expect(configureWebpack).toBeTypeOf("function");
  if (!configureWebpack) throw new Error("webpack config hook is required");

  const webpackConfig = { resolve: { extensionAlias: {} } } as Parameters<typeof configureWebpack>[0];
  const context = {} as Parameters<typeof configureWebpack>[1];
  const configured = configureWebpack(webpackConfig, context);

  expect(configured.resolve?.extensionAlias?.[".js"]).toEqual([".ts", ".tsx", ".js"]);
  expect(configured.resolve?.extensionAlias?.[".jsx"]).toEqual([".tsx", ".jsx"]);
}

describe("shell contracts build wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("resolves NodeNext JavaScript specifiers to TypeScript sources", async () => {
    const config = await resolveNextConfig(nextConfig);
    expectNodeNextSourceAliases(config);
  });

  it("keeps contracts wiring when PostHog wraps the release config", async () => {
    vi.stubEnv("POSTHOG_API_KEY", "test-personal-key");
    vi.stubEnv("POSTHOG_PROJECT_ID", "test-project-id");
    vi.resetModules();

    const { default: wrappedConfig } = await import("../../shell/next.config");
    const config = await resolveNextConfig(wrappedConfig);

    expect(wrappedConfig).toBeTypeOf("function");
    expectNodeNextSourceAliases(config);
  });
});
