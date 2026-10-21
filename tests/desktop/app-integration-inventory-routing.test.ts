import { describe, expect, it, vi } from "vitest";
import { createNativeAppIntegrations, isAllowedNativeAppGatewayRequest, NativeAppGatewayRequestSchema } from "@desktop/shared/native-app-gateway";
import { isAllowedBridgeFetchUrl } from "../../shell/src/components/app-viewer-bridge-policy";
import { resolveBridgeFetchUrl } from "../../shell/src/components/app-viewer-bridge-request";

const inventory = [{ id: "connection-personal", service: "gmail", account_label: "Personal", account_email: "owner@example.com", status: "active", scopes: ["private-provider-detail"] }];

describe("first-party app connection inventory", () => {
  it("reads central owner connections, strips extra fields and retains exact account bindings", async () => {
    const invoke = vi.fn().mockResolvedValue(inventory);
    await expect(createNativeAppIntegrations(invoke)()).resolves.toEqual([{ id: "connection-personal", service: "gmail", account_label: "Personal", account_email: "owner@example.com", status: "active" }]);
    expect(invoke).toHaveBeenCalledWith({ url: "/api/integrations" });
  });
  it("keeps failed inventory unknown rather than reporting no connected accounts", async () => {
    for (const value of [{ error: "unavailable" }, { services: inventory }, null, [{ ...inventory[0], id: "../unsafe" }]]) {
      await expect(createNativeAppIntegrations(vi.fn().mockResolvedValue(value))()).rejects.toThrow();
    }
    await expect(createNativeAppIntegrations(vi.fn().mockResolvedValue([]))()).resolves.toEqual([]);
  });
  it("authorizes only the exact inventory GET for canonical starter identities in both clients", () => {
    expect(NativeAppGatewayRequestSchema.safeParse({ url: "/api/integrations" }).success).toBe(true);
    expect(isAllowedNativeAppGatewayRequest("subscriptions", "subscriptions", { url: "/api/integrations" })).toBe(true);
    for (const app of ["subscriptions", "app-gallery"]) {
      expect(isAllowedBridgeFetchUrl(app, "/api/integrations", "GET")).toBe(true);
      for (const url of ["/api/integrations/sync", "/api/integrations?owner=other", "/api/integrations/", "/api/../api/integrations"]) {
        expect(isAllowedBridgeFetchUrl(app, url, "GET")).toBe(false);
        expect(isAllowedNativeAppGatewayRequest(app, app, { url })).toBe(false);
      }
      expect(isAllowedBridgeFetchUrl(app, "/api/integrations", "POST")).toBe(false);
    }
    expect(isAllowedNativeAppGatewayRequest("custom/subscriptions", "subscriptions", { url: "/api/integrations" })).toBe(false);
    expect(isAllowedBridgeFetchUrl("owner-copy", "/api/integrations", "GET")).toBe(false);
  });
  it("routes account inventory to the platform while keeping app data on the selected preview computer", () => {
    const gateway = "https://app.matrix-os.com/vm/pr-2304/~runtime/pr-2304";
    expect(resolveBridgeFetchUrl(gateway, "/api/integrations")).toBe("https://app.matrix-os.com/api/integrations");
    expect(resolveBridgeFetchUrl(gateway, "/api/bridge/query")).toBe(`${gateway}/api/bridge/query`);
    expect(resolveBridgeFetchUrl("http://localhost:4000", "/api/integrations")).toBe("http://localhost:4000/api/integrations");
  });
});
