import { describe, expect, it } from "vitest";
import { prepareBridgeFetchRequest } from "../../shell/src/components/app-viewer-bridge-request";

describe("gallery requests through the shared app viewer", () => {
  it("preserves an install POST while authorizing its actual method", () => {
    const request = prepareBridgeFetchRequest("app-gallery", {
      url: "/api/app-gallery/folio/install",
      init: { method: "post", body: "{}", headers: { "Content-Type": "application/json" } },
    });
    expect(request.url).toBe("/api/app-gallery/folio/install");
    expect(request.init.method).toBe("POST");
    expect(request.init.body).toBe("{}");
  });
  it("blocks a service execution POST even when inventory GET is allowed", () => {
    expect(() => prepareBridgeFetchRequest("app-gallery", {
      url: "/api/bridge/service", init: { method: "POST", body: "{}" },
    })).toThrow("Blocked bridge fetch URL");
    expect(prepareBridgeFetchRequest("app-gallery", { url: "/api/bridge/service" }).init.method).toBe("GET");
  });
  it("blocks unsupported and malformed methods before dispatch", () => {
    for (const method of ["DELETE", 7, null, {}]) {
      expect(() => prepareBridgeFetchRequest("app-gallery", {
        url: "/api/app-gallery", init: { method },
      })).toThrow();
    }
  });
});
