// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureMarketingAttribution,
  getCheckoutAttribution,
  getMarketingAttributionProperties,
} from "../../shell/src/lib/marketing-attribution.js";

describe("marketing attribution", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
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
});
