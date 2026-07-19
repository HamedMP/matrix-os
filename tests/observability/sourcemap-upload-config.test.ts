import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// PostHog exceptions from the shell arrive minified unless production
// source maps are uploaded at build time. withPostHogConfig must only wrap
// the Next.js config when both POSTHOG_API_KEY and POSTHOG_PROJECT_ID are
// present so builds without credentials stay byte-identical to today.
describe("shell source-map upload config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("exports the plain config object when PostHog build env is absent", async () => {
    vi.stubEnv("POSTHOG_API_KEY", "");
    vi.stubEnv("POSTHOG_PROJECT_ID", "");
    vi.resetModules();

    const mod = await import("../../shell/next.config.ts");
    expect(typeof mod.default).toBe("object");
    expect(typeof (mod.default as { rewrites?: unknown }).rewrites).toBe("function");
  });

  it("exports the plain config when only one of the two env vars is set", async () => {
    vi.stubEnv("POSTHOG_API_KEY", "phx_test_personal_key");
    vi.stubEnv("POSTHOG_PROJECT_ID", "");
    vi.resetModules();

    const mod = await import("../../shell/next.config.ts");
    expect(typeof mod.default).toBe("object");
  });

  it("wraps the config with withPostHogConfig when both env vars are set", async () => {
    vi.stubEnv("POSTHOG_API_KEY", "phx_test_personal_key");
    vi.stubEnv("POSTHOG_PROJECT_ID", "12345");
    vi.resetModules();

    const mod = await import("../../shell/next.config.ts");
    // withPostHogConfig returns a Next.js config *function*, not the plain object.
    expect(typeof mod.default).toBe("function");
  });

  it("passes personalApiKey, projectId, host, and sourcemaps options", () => {
    const source = readFileSync(join(process.cwd(), "shell/next.config.ts"), "utf8");
    expect(source).toContain("@posthog/nextjs-config");
    expect(source).toMatch(/personalApiKey/);
    expect(source).toMatch(/projectId/);
    expect(source).toMatch(/POSTHOG_HOST/);
    expect(source).toMatch(/eu\.posthog\.com/);
    expect(source).toMatch(/sourcemaps:\s*\{\s*enabled:\s*true/);
  });
});

describe("runtime-safe sourcemap plugin loading", () => {
  // @posthog/nextjs-config is a devDependency. `next start` evaluates
  // next.config at runtime, and pruned production images (platform Cloud Run)
  // have no dev deps -- a top-level import crashes the auth shell and the
  // container never listens on its port. The plugin must load lazily behind
  // the credential gate.
  const configs = ["shell/next.config.ts"];

  it.each(configs)("%s does not import @posthog/nextjs-config at top level", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    expect(source).not.toMatch(/^import\s+[^;]*@posthog\/nextjs-config/m);
    expect(source).toMatch(/createRequire/);
    expect(source).toMatch(/require\(['"]@posthog\/nextjs-config['"]\)/);
  });
});

describe("host bundle build wiring", () => {
  const workflow = readFileSync(
    join(process.cwd(), ".github/workflows/host-bundle-release.yml"),
    "utf8",
  );

  it("passes optional PostHog source-map credentials to the build job", () => {
    expect(workflow).toMatch(/POSTHOG_API_KEY:\s*\$\{\{\s*secrets\.POSTHOG_API_KEY\s*\|\|\s*''\s*\}\}/);
    expect(workflow).toMatch(/POSTHOG_PROJECT_ID:\s*\$\{\{\s*vars\.POSTHOG_PROJECT_ID\s*\|\|\s*''\s*\}\}/);
  });

  it("declares the shell dev dependency on @posthog/nextjs-config", () => {
    const shellPkg = JSON.parse(readFileSync(join(process.cwd(), "shell/package.json"), "utf8"));
    expect(shellPkg.devDependencies["@posthog/nextjs-config"]).toBeDefined();
  });
});
