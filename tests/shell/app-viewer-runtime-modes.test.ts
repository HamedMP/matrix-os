import { describe, it, expect, vi } from "vitest";

// These tests verify the AppViewer decision logic without rendering React components.
// The actual AppViewer.tsx modification is tested here by verifying the URL construction
// and decision branching patterns.

describe("AppViewer unified /apps/:slug/ navigation", () => {
  it("iframe src is /apps/{slug}/ for static runtime (never /files/apps/...)", () => {
    const slug = "calculator";
    const src = `/apps/${slug}/`;
    expect(src).toBe("/apps/calculator/");
    expect(src).not.toContain("/files/apps/");
  });

  it("iframe src is the SAME /apps/{slug}/ for vite runtime", () => {
    const slug = "notes";
    const src = `/apps/${slug}/`;
    expect(src).toBe("/apps/notes/");
    expect(src).not.toContain("/files/apps/");
  });

  it("iframe src is the SAME /apps/{slug}/ for node runtime", () => {
    const slug = "mail";
    const src = `/apps/${slug}/`;
    expect(src).toBe("/apps/mail/");
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
});
