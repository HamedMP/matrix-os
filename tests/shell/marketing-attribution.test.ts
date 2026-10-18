// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureMarketingAttribution,
  getCheckoutAttribution,
  getMarketingAttributionProperties,
} from "../../shell/src/lib/marketing-attribution.js";

describe("marketing attribution", () => {
  beforeEach(() => {
    document.cookie = "matrix_marketing_consent_v1=" + encodeURIComponent(JSON.stringify({ version: 1, choice: "accepted", expiresAt: Date.now() + 60000 })) + "; path=/";
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    document.cookie = "matrix_marketing_consent_v1=; Max-Age=0; path=/";
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it.each([undefined, "rejected", "expired", "invalid"])("does not persist or forward attribution without valid acceptance: %s", choice => {
    const value = choice === "invalid" ? "%broken" : encodeURIComponent(JSON.stringify({ version: 1, choice: choice === "expired" ? "accepted" : choice, expiresAt: choice === "expired" ? Date.now() - 1 : Date.now() + 60000 }));
    document.cookie = `matrix_marketing_consent_v1=${value}; path=/`;
    window.history.replaceState({}, "", "/?rdt_cid=reddit-click&utm_source=reddit");
    expect(captureMarketingAttribution()).toEqual({});
    expect(getCheckoutAttribution()).toBeUndefined();
    expect(window.localStorage.getItem("matrix_marketing_attribution_v2")).toBeNull();
  });

  it("rejects oversized click IDs instead of manufacturing a truncated match key", () => {
    window.history.replaceState({}, "", "/?rdt_cid=" + "x".repeat(257));
    expect(captureMarketingAttribution()).not.toHaveProperty("rdt_cid");
  });

  it("does not reuse legacy unbounded campaign data", () => {
    window.localStorage.setItem("matrix_marketing_attribution_v1", JSON.stringify({ rdt_cid: "stale" }));
    expect(captureMarketingAttribution()).toEqual({});
  });

  it("removes legacy indefinite data even when storing a nonempty new campaign", () => {
    window.localStorage.setItem("matrix_marketing_attribution_v1", JSON.stringify({ rdt_cid: "old-click" }));
    window.history.replaceState({}, "", "/?rdt_cid=new-click");
    expect(captureMarketingAttribution().rdt_cid).toBe("new-click");
    expect(window.localStorage.getItem("matrix_marketing_attribution_v1")).toBeNull();
  });

  it("passes acceptance expiry to checkout without adding it to analytics properties", () => {
    window.history.replaceState({}, "", "/?rdt_cid=reddit-click");
    expect(getCheckoutAttribution()).toMatchObject({ marketing_consent: "accepted", consent_expires_at: expect.any(Number), rdt_cid: "reddit-click" });
    expect(getMarketingAttributionProperties()).not.toHaveProperty("marketing_consent");
  });

  it("expires stored click IDs and clears them when consent is revoked", () => {
    window.localStorage.setItem("matrix_marketing_attribution_v2", JSON.stringify({ capturedAt: Date.now() - 31 * 86400000, attribution: { rdt_cid: "stale" } }));
    expect(captureMarketingAttribution()).toEqual({});
    window.history.replaceState({}, "", "/?rdt_cid=fresh");
    expect(captureMarketingAttribution().rdt_cid).toBe("fresh");
    document.cookie = "matrix_marketing_consent_v1=" + encodeURIComponent(JSON.stringify({ version: 1, choice: "rejected", expiresAt: Date.now() + 60000 })) + "; path=/";
    expect(getCheckoutAttribution()).toBeUndefined();
    expect(window.localStorage.getItem("matrix_marketing_attribution_v2")).toBeNull();
  });

  it("does not extend the original campaign or consent retention on repeated capture", () => {
    const now = Date.now();
    const time = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      window.history.replaceState({}, "", "/?rdt_cid=reddit-click");
      captureMarketingAttribution();
      const first = window.localStorage.getItem("matrix_marketing_attribution_v2");
      time.mockReturnValue(now + 1000);
      captureMarketingAttribution();
      expect(window.localStorage.getItem("matrix_marketing_attribution_v2")).toBe(first);
    } finally { time.mockRestore(); }
  });

  it("honors a shared rejection over a local acceptance", () => {
    window.localStorage.setItem("matrix_marketing_consent_v1", JSON.stringify({ version: 1, choice: "accepted", expiresAt: Date.now() + 60000 }));
    document.cookie = "matrix_marketing_consent_v1=" + encodeURIComponent(JSON.stringify({ version: 1, choice: "rejected", expiresAt: Date.now() + 60000 })) + "; path=/";
    expect(getCheckoutAttribution()).toBeUndefined();
  });

  it("keeps consented URL attribution usable when campaign storage is blocked", () => {
    const blocked = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    try {
      window.history.replaceState({}, "", "/?rdt_cid=reddit-click");
      expect(getCheckoutAttribution()?.rdt_cid).toBe("reddit-click");
    } finally { blocked.mockRestore(); }
  });

  it("captures only bounded Reddit and UTM parameters", () => {
    window.history.replaceState(
      {},
      "",
      "/?rdt_cid=reddit-click&utm_source=reddit&utm_medium=cpc&utm_campaign=launch&utm_content=hero&utm_term=agents&email=nope",
    );

    expect(captureMarketingAttribution()).toEqual(expect.objectContaining({
      rdt_cid: "reddit-click",
      utm_source: "reddit",
      utm_medium: "cpc",
      utm_campaign: "launch",
      utm_content: "hero",
      utm_term: "agents",
    }));
    expect(getMarketingAttributionProperties()).not.toHaveProperty("email");
  });

  it("preserves attribution for checkout after the URL is cleaned", () => {
    window.history.replaceState({}, "", "/?rdt_cid=reddit-click&utm_source=reddit");
    captureMarketingAttribution();
    window.history.replaceState({}, "", "/onboarding");

    expect(getCheckoutAttribution()).toEqual(expect.objectContaining({
      rdt_cid: "reddit-click",
      utm_source: "reddit",
      landing_path: expect.stringContaining("rdt_cid=reddit-click"),
    }));
  });

  it("replaces a stored campaign atomically when a later campaign arrives", () => {
    window.history.replaceState({}, "", "/?rdt_cid=old-click&utm_source=reddit&utm_campaign=old");
    captureMarketingAttribution();
    window.history.replaceState({}, "", "/pricing?utm_source=google&utm_campaign=new");

    expect(captureMarketingAttribution()).toEqual({
      utm_source: "google",
      utm_campaign: "new",
      landing_path: "/pricing?utm_source=google&utm_campaign=new",
    });
    expect(getCheckoutAttribution()).not.toHaveProperty("rdt_cid");
  });
});
