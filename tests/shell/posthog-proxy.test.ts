// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../shell/next.config";

const posthogMock = vi.hoisted(() => ({
  conversations: {
    isAvailable: vi.fn(() => true),
    show: vi.fn(),
  },
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  setPersonProperties: vi.fn(),
  reset: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("posthog-js", () => ({
  default: posthogMock,
}));
vi.mock("posthog-js/dist/conversations", () => ({}));

type RewriteRule = { source: string; destination: string };

async function getRewrites(): Promise<RewriteRule[]> {
  const rewrites = await nextConfig.rewrites?.();
  expect(Array.isArray(rewrites)).toBe(true);
  return rewrites as RewriteRule[];
}

describe("shell PostHog same-origin proxy", () => {
  afterEach(() => {
    document.getElementById("ph-conversations-widget-container")?.remove();
    document.getElementById("unrelated-close")?.remove();
    posthogMock.conversations.show.mockReset();
    vi.unstubAllGlobals();
  });

  it("rewrites the same-origin health probe to the gateway", async () => {
    const rewrites = await getRewrites();
    const healthRule = rewrites.find((rule) => rule.source === "/health");

    expect(healthRule?.destination).toBe("http://localhost:4000/health");
  });

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

    initializeShellPostHog({ token: "phc_test", apiHost: "/relay", uiHost: "https://eu.posthog.com" });

    expect(posthogMock.init).toHaveBeenCalledTimes(1);
    const [token, options] = posthogMock.init.mock.calls[0] as [string, Record<string, unknown>];
    expect(token).toBe("phc_test");
    expect(options.api_host).toBe("/relay");
    expect(options.ui_host).toBe("https://eu.posthog.com");
    expect(options).not.toHaveProperty("cookieless_mode");
  });

  it("only resets identity for provably identified sessions", async () => {
    const { initializeShellPostHog, resetPostHogIdentity } = await import(
      "../../shell/src/lib/posthog-client"
    );
    const config = { token: "phc_test", apiHost: "/relay", uiHost: "https://eu.posthog.com" };
    initializeShellPostHog(config);
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

  it("opens PostHog Conversations from the shell navbar", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        version: "v2026.08.31-installed",
        runningVersion: "v2026.09.02-running",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const unrelatedClose = document.createElement("button");
    unrelatedClose.id = "unrelated-close";
    unrelatedClose.setAttribute("aria-label", "Close");
    document.body.appendChild(unrelatedClose);
    const launcherClick = vi.fn(() => {
      const close = document.createElement("button");
      close.setAttribute("aria-label", "Close");
      document.getElementById("ph-conversations-widget-container")?.replaceChildren(close);
    });
    posthogMock.conversations.show.mockImplementation(() => {
      const container = document.createElement("div");
      container.id = "ph-conversations-widget-container";
      const launcher = document.createElement("button");
      launcher.setAttribute("aria-label", "Open chat");
      launcher.addEventListener("click", launcherClick);
      container.appendChild(launcher);
      document.body.appendChild(container);
    });
    const { openShellSupport } = await import("../../shell/src/lib/posthog-client");
    const opened = await openShellSupport({
      token: "phc_test",
      apiHost: "/relay",
      uiHost: "https://eu.posthog.com",
    });

    expect(opened).toBe(true);
    expect(posthogMock.conversations.show).toHaveBeenCalledOnce();
    expect(launcherClick).toHaveBeenCalledOnce();
    expect(
      document.querySelector('#ph-conversations-widget-container button[aria-label="Close"]'),
    ).not.toBeNull();
    expect(posthogMock.capture).toHaveBeenCalledWith("shell_support_chat_opened", {
      matrix_client: "web",
      matrix_bundle_version: "v2026.09.02-running",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/system\/info$/),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(posthogMock.register).toHaveBeenCalledWith({
      matrix_client: "web",
      matrix_bundle_version: "v2026.09.02-running",
    });
    expect(posthogMock.setPersonProperties).toHaveBeenCalledWith({
      matrix_client: "web",
      matrix_bundle_version: "v2026.09.02-running",
    });
  });

  it("opens support without version properties when runtime metadata is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    posthogMock.conversations.show.mockImplementation(() => {
      const container = document.createElement("div");
      container.id = "ph-conversations-widget-container";
      const close = document.createElement("button");
      close.setAttribute("aria-label", "Close");
      container.appendChild(close);
      document.body.appendChild(container);
    });
    const { openShellSupport } = await import("../../shell/src/lib/posthog-client");

    await expect(openShellSupport({
      token: "phc_test",
      apiHost: "/relay",
      uiHost: "https://eu.posthog.com",
    })).resolves.toBe(true);

    expect(posthogMock.register).toHaveBeenCalledWith({ matrix_client: "web" });
    expect(posthogMock.unregister).toHaveBeenCalledWith("matrix_bundle_version");
    expect(posthogMock.unregister).toHaveBeenCalledWith("matrix_desktop_version");
    expect(posthogMock.capture).toHaveBeenCalledWith("shell_support_chat_opened", {
      matrix_client: "web",
    });
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
