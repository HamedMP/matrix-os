import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createGallerySyncRoutes } from "../../packages/gateway/src/app-gallery/sync-routes";
import { markAuthContextReady, setPlatformVerifiedPrincipal } from "../../packages/gateway/src/request-principal";
import { isAllowedBridgeFetchUrl } from "../../shell/src/components/app-viewer-bridge-policy";
import { NativeAppGatewayRequestSchema, isAllowedNativeAppGatewayRequest } from "../../desktop/src/shared/native-app-gateway";
import { parseGallerySyncSnapshot } from "../../packages/contracts/src/app-gallery-sync";
import { acceptedSync } from "../default-apps/gallery-sync-fixture";
import catalog from "../../home/system/app-gallery.json";

function setup(available = true) {
  const service = { status: vi.fn(async () => acceptedSync("people")), start: vi.fn(async () => acceptedSync("people")), pause: vi.fn(), retry: vi.fn() };
  const app = new Hono();
  app.use("*", async (c, next) => { markAuthContextReady(c); setPlatformVerifiedPrincipal(c, c.req.header("x-test-owner") ?? "owner"); await next(); });
  app.route("/api/app-gallery", createGallerySyncRoutes({ ownerIds: ["owner"], service: available ? service as never : null }));
  return { app, service };
}
describe("Gallery sync owner API and trusted hosts", () => {
  it("returns durable acceptance and isolates every operation to the runtime owner", async () => {
    const { app, service } = setup();
    const response = await app.request("/api/app-gallery/people/sync", { method: "POST", headers: { "content-type": "application/json" }, body: '{"selected":"input"}' });
    expect(response.status).toBe(202);
    expect(parseGallerySyncSnapshot(await response.json())?.status).toBe("queued");
    expect(service.start).toHaveBeenCalledWith("owner", "people", { selected: "input" });
    for (const headers of [{ "x-test-owner": "another" }, { origin: "null" }]) {
      for (const method of ["GET", "POST"]) {
        expect((await app.request("/api/app-gallery/people/sync", { method, headers, ...(method === "POST" ? { body: "{}" } : {}) })).status).toBe(403);
      }
    }
    expect(service.start).toHaveBeenCalledTimes(1);
  });
  it("fails truthfully for unavailable runtime dependencies, malformed controls, paths and oversize requests", async () => {
    expect((await setup(false).app.request("/api/app-gallery/people/sync")).status).toBe(503);
    const { app, service } = setup();
    for (const [path, body, status] of [["people/sync/pause", '{"app":"other"}', 400], ["people/sync", "not JSON", 400], ["People/sync", "{}", 400], ["people/sync", "x".repeat(16385), 413]] as const) {
      expect((await app.request(`/api/app-gallery/${path}`, { method: "POST", body })).status).toBe(status);
    }
    expect(service.start).not.toHaveBeenCalled(); expect(service.pause).not.toHaveBeenCalled();
  });
  it.each(catalog.apps.filter(a => a.services.length).map(a => a.id))("allows %s only its own exact sync routes in Web and Electron", id => {
    for (const [suffix, method] of [["", "GET"], ["", "POST"], ["/pause", "POST"], ["/retry", "POST"], ["/resume", "POST"]] as const) {
      const url = `/api/app-gallery/${id}/sync${suffix}`;
      const raw = { url, init: { method, ...(method === "POST" ? { body: "{}" } : {}) } };
      expect(isAllowedBridgeFetchUrl(id, url, method)).toBe(true);
      const request = NativeAppGatewayRequestSchema.parse(raw);
      expect(isAllowedNativeAppGatewayRequest(id, id, request)).toBe(true);
      expect(isAllowedNativeAppGatewayRequest("app-gallery", "app-gallery", request)).toBe(false);
      expect(isAllowedBridgeFetchUrl("app-gallery", url, method)).toBe(false);
      expect(isAllowedBridgeFetchUrl(`custom/${id}`, url, method)).toBe(false);
      expect(isAllowedNativeAppGatewayRequest(`custom/${id}`, id, request)).toBe(false);
      for (const extra of ["?x=1", "#fragment", "/", "/../sync"]) expect(isAllowedBridgeFetchUrl(id, `${url}${extra}`, method)).toBe(false);
    }
  });
  it("rejects invalid status replies instead of inventing progress", () => {
    expect(() => parseGallerySyncSnapshot({ error: "offline" })).toThrow();
    expect(() => parseGallerySyncSnapshot({ ...acceptedSync("people"), added: -1 })).toThrow();
    expect(() => parseGallerySyncSnapshot({ ...acceptedSync("people"), status: "approved" })).toThrow();
  });
});
