import { describe, expect, it } from "vitest";
import { AppStoreInstallJobSchema } from "../../packages/contracts/src/app-store-gateway";
import { isAllowedAppStoreGalleryRequest } from "../../packages/contracts/src/app-store-bridge-policy";

describe("local build progress", () => {
  const id = "6f84f223-bd35-4e4d-ad4a-2fb7bd9174fa";
  it("provides bounded status polling only to Gallery", () => {
    expect(AppStoreInstallJobSchema.parse({ id, status: "building" })).toEqual({ id, status: "building" });
    expect(AppStoreInstallJobSchema.safeParse({ id, status: "failed", error: "/home/user/private" }).success).toBe(false);
    expect(isAllowedAppStoreGalleryRequest(`/api/app-store/installs/${id}`, "GET")).toBe(true);
    expect(isAllowedAppStoreGalleryRequest(`/api/app-store/installs/${id}`, "POST")).toBe(false);
  });
  it("allows submission paging without widening other query keys", () => {
    expect(isAllowedAppStoreGalleryRequest("/api/app-store/submissions?cursor=next", "GET")).toBe(true);
    expect(isAllowedAppStoreGalleryRequest("/api/app-store/submissions?user=other", "GET")).toBe(false);
    expect(isAllowedAppStoreGalleryRequest("/api/app-store/submissions?cursor=a&cursor=b", "GET")).toBe(false);
  });
});
