import { describe, it, expect } from "vitest";
import { isAllowedBridgeFetchUrl } from "../../shell/src/components/app-viewer-bridge-policy";
describe("gallery bridge permission", () => {
  it("grants only exact catalog GET and safe install POST to gallery", () => {
    expect(
      isAllowedBridgeFetchUrl("app-gallery", "/api/app-gallery", "GET"),
    ).toBe(true);
    expect(
      isAllowedBridgeFetchUrl(
        "apps/app-gallery",
        "/api/app-gallery/folio/install",
        "POST",
      ),
    ).toBe(true);
    expect(
      isAllowedBridgeFetchUrl("app-gallery", "/api/app-gallery", "POST"),
    ).toBe(false);
    expect(
      isAllowedBridgeFetchUrl(
        "app-gallery",
        "/api/app-gallery/folio/install",
        "GET",
      ),
    ).toBe(false);
    expect(isAllowedBridgeFetchUrl("folio", "/api/app-gallery", "GET")).toBe(
      false,
    );
  });
  it("rejects aliases, queries, traversal, external URLs and unrelated routes", () => {
    for (const url of [
      "/api/app-gallery?x=1",
      "/api/app-gallery#x",
      "/api/app-gallery/",
      "/api/../api/app-gallery",
      "https://bridge.invalid/api/app-gallery",
      "//bridge.invalid/api/app-gallery",
      "/api/app-gallery/%66olio/install",
      "/api/app-gallery/Folio/install",
      "/api/app-gallery/folio/install?x=1",
      "/api/app-gallery/folio/install/",
      "/api/apps/folio",
      "/api/system/activity",
    ])
      expect(isAllowedBridgeFetchUrl("app-gallery", url, "POST")).toBe(false);
  });
  it("retains inventory GET but blocks service execution for gallery", () => {
    expect(
      isAllowedBridgeFetchUrl("app-gallery", "/api/bridge/service", "GET"),
    ).toBe(true);
    expect(
      isAllowedBridgeFetchUrl("app-gallery", "/api/bridge/service", "POST"),
    ).toBe(false);
    expect(
      isAllowedBridgeFetchUrl("app-gallery", "/api/bridge/service?x=1", "GET"),
    ).toBe(false);
  });
});
