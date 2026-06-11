import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import nextConfig from "../../shell/next.config";

const posthogMock = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("posthog-js", () => ({
  default: posthogMock,
}));

type RewriteRule = { source: string; destination: string };

async function getRewrites(): Promise<RewriteRule[]> {
  const rewrites = await nextConfig.rewrites?.();
  expect(Array.isArray(rewrites)).toBe(true);
  return rewrites as RewriteRule[];
}

describe("shell PostHog same-origin proxy", () => {
  it("rewrites /relay asset and ingest paths to PostHog EU", async () => {
    const rewrites = await getRewrites();
    const staticRule = rewrites.find((rule) => rule.source === "/relay/static/:path*");
    const arrayRule = rewrites.find((rule) => rule.source === "/relay/array/:path*");
    const ingestRule = rewrites.find((rule) => rule.source === "/relay/:path*");

    expect(staticRule?.destination).toBe("https://eu-assets.i.posthog.com/static/:path*");
    expect(arrayRule?.destination).toBe("https://eu-assets.i.posthog.com/array/:path*");
    expect(ingestRule?.destination).toBe("https://eu.i.posthog.com/:path*");
  });

  it("orders asset rewrites before the ingest catch-all", async () => {
    const rewrites = await getRewrites();
    const sources = rewrites.map((rule) => rule.source);
    const staticIndex = sources.indexOf("/relay/static/:path*");
    const arrayIndex = sources.indexOf("/relay/array/:path*");
    const ingestIndex = sources.indexOf("/relay/:path*");

    expect(staticIndex).toBeGreaterThanOrEqual(0);
    expect(arrayIndex).toBeGreaterThanOrEqual(0);
    expect(ingestIndex).toBeGreaterThan(staticIndex);
    expect(ingestIndex).toBeGreaterThan(arrayIndex);
  });

  it("does not use blocklisted proxy paths (/ingest, /ingress, /hog)", async () => {
    const rewrites = await getRewrites();
    const blocked = rewrites.filter((rule) =>
      /^\/(ingest|ingress|hog)\//.test(rule.source) || /^\/(ingest|ingress|hog)$/.test(rule.source),
    );
    expect(blocked).toEqual([]);
  });

  it("initializes posthog-js with a relative api_host", async () => {
    const { initializeShellPostHog } = await import("../../shell/src/lib/posthog-client");

    initializeShellPostHog("US", { token: "phc_test", apiHost: "/relay", uiHost: "https://eu.posthog.com" });

    expect(posthogMock.init).toHaveBeenCalledTimes(1);
    const [token, options] = posthogMock.init.mock.calls[0] as [string, Record<string, unknown>];
    expect(token).toBe("phc_test");
    expect(options.api_host).toBe("/relay");
    expect(options.ui_host).toBe("https://eu.posthog.com");
  });

  it("only resets identity for provably identified sessions", async () => {
    const { initializeShellPostHog, resetPostHogIdentity } = await import(
      "../../shell/src/lib/posthog-client"
    );
    const config = { token: "phc_test", apiHost: "/relay", uiHost: "https://eu.posthog.com" };
    initializeShellPostHog("US", config);
    const mock = posthogMock as typeof posthogMock & { _isIdentified?: () => boolean };

    // Identity check unavailable: never reset (would rotate anonymous ids).
    delete mock._isIdentified;
    resetPostHogIdentity(config);
    expect(posthogMock.reset).not.toHaveBeenCalled();

    // Anonymous session: no reset.
    mock._isIdentified = () => false;
    resetPostHogIdentity(config);
    expect(posthogMock.reset).not.toHaveBeenCalled();

    // Identified session: reset.
    mock._isIdentified = () => true;
    resetPostHogIdentity(config);
    expect(posthogMock.reset).toHaveBeenCalledTimes(1);
  });

  it("defaults the shell api host to the /relay same-origin proxy", () => {
    // Source-level invariant: the env read must fall back to "/relay" so host
    // bundles built without NEXT_PUBLIC_POSTHOG_API_HOST stay un-blockable.
    const source = readPostHogClientSource();
    expect(source).toMatch(/NEXT_PUBLIC_POSTHOG_API_HOST\s*\?\?\s*"\/relay"/);
    expect(source).toMatch(/allowRelativeApiHost:\s*true/);
  });
});

function readPostHogClientSource(): string {
  return readFileSync(join(process.cwd(), "shell/src/lib/posthog-client.ts"), "utf8");
}
