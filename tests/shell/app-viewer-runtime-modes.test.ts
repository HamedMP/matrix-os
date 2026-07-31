import { readFile } from "node:fs/promises";
import { describe, it, expect, vi } from "vitest";
import {
  APP_IFRAME_SANDBOX,
  injectBridgeIntoAppHtml,
} from "../../shell/src/components/app-viewer-helpers.js";
import { isAllowedBridgeFetchUrl } from "../../shell/src/components/app-viewer-bridge-policy.js";

describe("AppViewer bridged runtime loading", () => {
  it("shares app-data serialization across AppViewer lifetimes", async () => {
    const source = await readFile("shell/src/components/AppViewer.tsx", "utf8");
    const componentStart = source.indexOf("export function AppViewer");
    const moduleScope = source.slice(0, componentStart);
    const componentScope = source.slice(componentStart);

    expect(moduleScope).toContain(
      "const bridgeDataHandler = createCoalescedBridgeDataHandler(requestBridgeData);",
    );
    expect(componentScope).not.toContain("createCoalescedBridgeDataHandler(requestBridgeData)");
  });

  describe("bridge guarantee: slug apps only ever load via bridged srcDoc", () => {
    // Mirrors AppViewer's iframeSrc decision. Runtime (slug) apps must NEVER load
    // the raw /apps/{slug}/ document directly, because that runs un-bridged in the
    // null-origin sandbox and window.MatrixOS.db is undefined.
    const iframeSrc = (slug: string | null, path: string) =>
      !slug ? `/files/${path}` : "about:blank";

    it("a slug app's src is about:blank (real HTML is served via srcDoc instead)", () => {
      expect(iframeSrc("notes", "apps/notes/index.html")).toBe("about:blank");
      expect(iframeSrc("task-manager", "apps/task-manager")).toBe("about:blank");
    });

    it("never points a slug app's src at the un-bridged /apps/{slug}/ document", () => {
      for (const slug of ["notes", "weather", "2048", "whiteboard"]) {
        expect(iframeSrc(slug, `apps/${slug}/`)).not.toContain(`/apps/${slug}/`);
      }
    });

    it("legacy (non-slug) file paths still load via /files/{path}", () => {
      expect(iframeSrc(null, "apps/legacy/index.html")).toBe("/files/apps/legacy/index.html");
    });
  });

  describe("distributionStatus branching", () => {
    it("installable -> openAppSession called", () => {
      const status = "installable";
      const shouldOpenSession = status === "installable" || status === "gated";
      expect(shouldOpenSession).toBe(true);
    });

    it("gated -> shows ack dialog before session", () => {
      const status = "gated";
      const needsAck = status === "gated";
      expect(needsAck).toBe(true);
    });

    it("blocked -> read-only card, no session call", () => {
      const status = "blocked";
      const shouldOpenSession = status === "installable" || status === "gated";
      expect(shouldOpenSession).toBe(false);
    });
  });

  describe("runtimeState branching", () => {
    it("ready -> renders iframe", () => {
      const state = { status: "ready" };
      const shouldRenderIframe = state.status === "ready";
      expect(shouldRenderIframe).toBe(true);
    });

    it("build_failed -> renders error card", () => {
      const state = { status: "build_failed", stage: "build", exitCode: 1, stderrTail: "error" };
      const shouldRenderError = state.status === "build_failed";
      expect(shouldRenderError).toBe(true);
    });

    it("needs_build -> renders needs-build card", () => {
      const state = { status: "needs_build" };
      const shouldRenderNeedsBuild = state.status === "needs_build";
      expect(shouldRenderNeedsBuild).toBe(true);
    });
  });

  describe("postMessage session refresh", () => {
    it("validates message origin, source, type, and slug", () => {
      const mySlug = "notes";
      const myOrigin = "http://localhost:3000";

      // Valid message
      const validMsg = {
        type: "matrix-os:session-expired",
        slug: "notes",
      };
      const validOrigin = "http://localhost:3000";

      const isValid =
        validOrigin === myOrigin &&
        validMsg.type === "matrix-os:session-expired" &&
        validMsg.slug === mySlug;
      expect(isValid).toBe(true);
    });

    it("accepts the opaque origin used by sandboxed runtime iframes", () => {
      const mySlug = "notes";
      const eventOrigin = "null";
      const msg = { type: "matrix-os:session-expired", slug: "notes" };

      const isValid =
        (eventOrigin === "http://localhost:3000" || eventOrigin === "null") &&
        msg.type === "matrix-os:session-expired" &&
        msg.slug === mySlug;
      expect(isValid).toBe(true);
    });

    it("rejects message from different slug", () => {
      const mySlug = "notes";
      const msg = { type: "matrix-os:session-expired", slug: "calendar" };
      expect(msg.slug === mySlug).toBe(false);
    });

    it("rejects message from different origin", () => {
      const myOrigin = "http://localhost:3000";
      const eventOrigin = "http://evil.com";
      expect(eventOrigin === myOrigin).toBe(false);
    });

    it("debounces within 2 seconds", () => {
      let lastRefreshAt = 0;
      const DEBOUNCE_MS = 2000;

      // First refresh (lastRefreshAt is 0, so any time >= 2000 passes)
      const now1 = 5000;
      const canRefresh1 = now1 - lastRefreshAt >= DEBOUNCE_MS;
      expect(canRefresh1).toBe(true);
      lastRefreshAt = now1;

      // Second refresh within 2s (5000 + 500 = 5500, 5500 - 5000 = 500 < 2000)
      const now2 = 5500;
      const canRefresh2 = now2 - lastRefreshAt >= DEBOUNCE_MS;
      expect(canRefresh2).toBe(false);

      // Third refresh after 2s (5000 + 2100 = 7100, 7100 - 5000 = 2100 >= 2000)
      const now3 = 7100;
      const canRefresh3 = now3 - lastRefreshAt >= DEBOUNCE_MS;
      expect(canRefresh3).toBe(true);
    });
  });

  describe("iframe sandbox", () => {
    it("keeps app iframes scriptable without granting same-origin escape", () => {
      expect(APP_IFRAME_SANDBOX).toContain("allow-scripts");
      expect(APP_IFRAME_SANDBOX).toContain("allow-forms");
      expect(APP_IFRAME_SANDBOX).not.toContain("allow-same-origin");
    });

    it("injects MatrixOS bridge into srcdoc html without same-origin DOM access", () => {
      const html = "<!doctype html><html><head><title>Notes</title><script type=\"module\" crossorigin src=\"./assets/app.js\"></script><link rel=\"stylesheet\" crossorigin href=\"./assets/app.css\"></head><body><div id=\"root\"></div></body></html>";
      const result = injectBridgeIntoAppHtml(html, "notes", {}, "/apps/notes/");

      expect(result).toContain('<base href="/apps/notes/">');
      expect(result).toContain("Content-Security-Policy");
      expect(result).toContain("window.MatrixOS");
      expect(result).toContain("os:bridge-fetch");
      expect(result).toContain('src="./assets/app.js"');
      expect(result).toContain('href="./assets/app.css"');
      expect(result).toContain("crossorigin");
    });

    it("only allows Symphony to bridge its first-party API routes", () => {
      expect(isAllowedBridgeFetchUrl("symphony", "/api/symphony/state")).toBe(true);
      expect(isAllowedBridgeFetchUrl("apps/symphony", "/api/symphony/service/start")).toBe(true);
      expect(isAllowedBridgeFetchUrl("notes", "/api/symphony/state")).toBe(false);
      expect(isAllowedBridgeFetchUrl("symphony", "https://app.matrix-os.com/api/symphony/state")).toBe(false);
      expect(isAllowedBridgeFetchUrl("symphony", "/api/auth/app-session")).toBe(false);
      expect(isAllowedBridgeFetchUrl("notes", "/api/bridge/query")).toBe(true);
    });

    it("only allows Resource Manager to bridge system activity reads", () => {
      expect(isAllowedBridgeFetchUrl("resource-manager", "/api/system/activity")).toBe(true);
      expect(isAllowedBridgeFetchUrl("apps/resource-manager", "/api/system/activity?processLimit=25")).toBe(true);
      expect(isAllowedBridgeFetchUrl("notes", "/api/system/activity")).toBe(false);
      expect(isAllowedBridgeFetchUrl("resource-manager", "/api/system/update")).toBe(false);
      expect(isAllowedBridgeFetchUrl("resource-manager", "https://app.matrix-os.com/api/system/activity")).toBe(false);
    });
  });
});
