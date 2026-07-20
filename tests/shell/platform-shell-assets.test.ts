import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPlatformShellAssetUpstreamPath,
  isPlatformShellAssetNamespacePath,
} from "../../packages/platform/src/request-routing";

describe("platform-owned shell assets", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("adds a dedicated asset prefix only to the platform auth-shell build", async () => {
    vi.stubEnv("MATRIX_PLATFORM_AUTH_SHELL", "1");
    vi.stubEnv("POSTHOG_API_KEY", "");
    vi.stubEnv("POSTHOG_PROJECT_ID", "");
    vi.resetModules();

    const platformConfig = (await import("../../shell/next.config.ts")).default;
    expect(typeof platformConfig).toBe("object");
    expect((platformConfig as { assetPrefix?: string }).assetPrefix).toBe("/__platform-shell");
    expect((platformConfig as { env?: Record<string, string> }).env?.NEXT_PUBLIC_PLATFORM_SHELL_ASSET_PREFIX)
      .toBe("/__platform-shell");

    vi.stubEnv("MATRIX_PLATFORM_AUTH_SHELL", "");
    vi.resetModules();
    const customerConfig = (await import("../../shell/next.config.ts")).default;
    expect((customerConfig as { assetPrefix?: string }).assetPrefix).toBeUndefined();
    expect((customerConfig as { env?: Record<string, string> }).env?.NEXT_PUBLIC_PLATFORM_SHELL_ASSET_PREFIX)
      .toBe("");
  });

  it("marks only Dockerfile.platform as the platform auth-shell build", () => {
    const platformDockerfile = readFileSync(join(process.cwd(), "Dockerfile.platform"), "utf8");
    const customerDockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");

    expect(platformDockerfile).toContain("ENV MATRIX_PLATFORM_AUTH_SHELL=1");
    expect(customerDockerfile).not.toContain("MATRIX_PLATFORM_AUTH_SHELL");
  });

  it("allows only static chunks and exact runtime images inside the public namespace", () => {
    expect(isPlatformShellAssetNamespacePath("/__platform-shell/_next/static/chunks/app.js"))
      .toBe(true);
    expect(isPlatformShellAssetNamespacePath("/__platform-shellish/_next/static/chunks/app.js"))
      .toBe(false);
    expect(getPlatformShellAssetUpstreamPath("/__platform-shell/_next/static/chunks/app.js"))
      .toBe("/_next/static/chunks/app.js");
    expect(getPlatformShellAssetUpstreamPath("/__platform-shell/matrix-logo.svg"))
      .toBe("/matrix-logo.svg");

    for (const rejectedPath of [
      "/__platform-shell/api/auth/computers",
      "/__platform-shell/_next/image",
      "/__platform-shell/_next/static/../../api/auth/computers",
      "/__platform-shell/_next/static/%2e%2e/%2e%2e/api/auth/computers",
      "/__platform-shell/_next/static/%2F..%2F../api/auth/computers",
      "/__platform-shell/_next/static/chunks\\..\\..\\api\\auth.js",
    ]) {
      expect(getPlatformShellAssetUpstreamPath(rejectedPath), rejectedPath).toBeNull();
    }
  });

  it("prefixes runtime public assets only when the platform build injects a prefix", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_SHELL_ASSET_PREFIX", "/__platform-shell");
    vi.resetModules();
    const { platformShellAssetPath } = await import("../../shell/src/lib/platform-shell-assets");
    expect(platformShellAssetPath("/runtime-shell-backdrop.webp")).toBe(
      "/__platform-shell/runtime-shell-backdrop.webp",
    );

    vi.stubEnv("NEXT_PUBLIC_PLATFORM_SHELL_ASSET_PREFIX", "");
    vi.resetModules();
    const customerAssets = await import("../../shell/src/lib/platform-shell-assets");
    expect(customerAssets.platformShellAssetPath("/runtime-shell-backdrop.webp"))
      .toBe("/runtime-shell-backdrop.webp");
  });

  it("keeps manifest, icon, and social metadata on the same platform revision", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_SHELL_ASSET_PREFIX", "/__platform-shell");
    vi.resetModules();

    const { buildShellMetadata } = await import("../../shell/src/lib/shell-metadata");
    const metadata = await buildShellMetadata(undefined);
    expect(metadata.manifest).toBe("/__platform-shell/manifest.json");
    expect(metadata.openGraph && "images" in metadata.openGraph ? metadata.openGraph.images : null)
      .toEqual([{
        url: "/__platform-shell/og.png",
        width: 1469,
        height: 1526,
        alt: "Matrix OS",
      }]);

    const layout = readFileSync(join(process.cwd(), "shell/src/app/layout.tsx"), "utf8");
    expect(layout).toContain('platformShellAssetPath("/icon-192.png")');
    expect(layout).toContain('platformShellAssetPath("/icon-512.png")');

    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "shell/public/manifest.json"), "utf8"),
    ) as { icons: Array<{ src: string }>; shortcuts: Array<{ icons: Array<{ src: string }> }> };
    for (const icon of [
      ...manifest.icons,
      ...manifest.shortcuts.flatMap((shortcut) => shortcut.icons),
    ]) {
      expect(icon.src).not.toMatch(/^\//);
    }
  });

  it("keeps platform shell assets out of release-agnostic service-worker caches", () => {
    const platformWorker = readFileSync(
      join(process.cwd(), "packages/platform/src/app-domain-service-worker.ts"),
      "utf8",
    );
    expect(platformWorker).toContain('const VERSION = "app-v2"');
    expect(platformWorker).toContain(
      'p === "/__platform-shell" || p.startsWith("/__platform-shell/")',
    );
  });
});
