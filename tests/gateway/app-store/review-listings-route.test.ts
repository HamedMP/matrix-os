import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerAppStoreRoutes } from "../../../packages/gateway/src/app-store/routes.js";
import type { AppStorePlatformClient } from "../../../packages/gateway/src/app-store/platform-client.js";
import {
  isAllowedAppStoreGalleryRequest,
  isAllowedStoreReviewRequest,
  isCommunityBridgeRequestAllowed,
} from "../../../packages/contracts/src/app-store-bridge-policy";
function fixture() {
  const request = vi.fn(async () => ({ listings: [] }));
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContextReady" as never, true as never);
    c.set("platformUserId" as never, "owner" as never);
    await next();
  });
  registerAppStoreRoutes(app, {
    homePath: "/owner",
    ownerIds: ["owner"],
    platform: { request } as unknown as AppStorePlatformClient,
  });
  return { app, request };
}
describe("reviewer listing navigation gateway", () => {
  it("proxies a bounded catalog query through the platform reviewer route", async () => {
    const { app, request } = fixture();
    const result = await app.request(
      "/api/app-store/review/listings?q=notes&sort=new&limit=10&cursor=next",
    );
    expect(result.status).toBe(200);
    expect(request).toHaveBeenCalledWith(
      "review/listings",
      expect.any(Object),
      { query: { q: "notes", sort: "new", limit: 10, cursor: "next" } },
    );
  });
  it.each(["limit=1000", "owner=other", "cursor=a&cursor=b", "q="])(
    "rejects invalid query %s before forwarding",
    async (query) => {
      const { app, request } = fixture();
      expect(
        (await app.request(`/api/app-store/review/listings?${query}`)).status,
      ).toBe(400);
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("adds only the exact reviewer read to the Gallery bridge", () => {
    const url = "/api/app-store/review/listings?q=notes&sort=new&cursor=next";
    expect(isAllowedAppStoreGalleryRequest(url)).toBe(true);
    expect(isAllowedStoreReviewRequest(url)).toBe(true);
    expect(isCommunityBridgeRequestAllowed(url)).toBe(false);
    expect(isAllowedStoreReviewRequest(url, "POST")).toBe(false);
    expect(isAllowedStoreReviewRequest(`${url}&owner=other`)).toBe(false);
    expect(isAllowedStoreReviewRequest(`${url}&cursor=again`)).toBe(false);
  });
});
