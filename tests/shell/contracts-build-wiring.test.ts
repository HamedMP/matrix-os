import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../shell/next.config";

type NextConfigValue = typeof nextConfig;
type NextConfigExport = NextConfigValue | ((
  phase: string,
  context: { defaultConfig: NextConfigValue },
) => NextConfigValue | Promise<NextConfigValue>);

async function resolveNextConfig(config: NextConfigExport): Promise<NextConfigValue> {
  return typeof config === "function"
    ? await config("phase-production-build", { defaultConfig: nextConfig })
    : config;
}

describe("shell contracts build wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("transpiles the contracts workspace package for production builds", async () => {
    const config = await resolveNextConfig(nextConfig);
    expect(config.transpilePackages).toContain("@matrix-os/contracts");
  });

  it("resolves NodeNext JavaScript specifiers to TypeScript sources", async () => {
    const config = await resolveNextConfig(nextConfig);
    const configureWebpack = config.webpack;
    expect(configureWebpack).toBeTypeOf("function");
    if (!configureWebpack) throw new Error("webpack config hook is required");

    const webpackConfig = { resolve: { extensionAlias: {} } } as Parameters<typeof configureWebpack>[0];
    const context = {} as Parameters<typeof configureWebpack>[1];
    const configured = configureWebpack(webpackConfig, context);

    expect(configured.resolve?.extensionAlias?.[".js"]).toEqual([".ts", ".tsx", ".js"]);
  });

  it("keeps contracts wiring when PostHog wraps the release config", async () => {
    vi.stubEnv("POSTHOG_API_KEY", "test-personal-key");
    vi.stubEnv("POSTHOG_PROJECT_ID", "test-project-id");
    vi.resetModules();

    const { default: wrappedConfig } = await import("../../shell/next.config");
    const config = await resolveNextConfig(wrappedConfig);

    expect(wrappedConfig).toBeTypeOf("function");
    expect(config.transpilePackages).toContain("@matrix-os/contracts");
    expect(config.webpack).toBeTypeOf("function");
  });
});
