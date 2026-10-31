import { describe, expect, it } from "vitest";
import {
  isAllowedAppStoreGalleryRequest,
  isAllowedStoreReviewRequest,
  isCommunityBridgeRequestAllowed,
} from "../../packages/contracts/src/app-store-bridge-policy";

const uuid = "4b0e3f4e-7d2c-4f8f-8a7b-2f6f0d3a1b9c";

describe("isAllowedAppStoreGalleryRequest", () => {
  it.each([
    ["GET", "/api/app-store/status"],
    ["GET", "/api/app-store/publishable-apps"],
    ["GET", "/api/app-store/drafts"],
    ["POST", "/api/app-store/drafts"],
    ["GET", `/api/app-store/drafts/${uuid}`],
    ["GET", `/api/app-store/drafts/${uuid}/diff?path=src%2FApp.tsx`],
    ["POST", `/api/app-store/drafts/${uuid}/revise`],
    ["POST", `/api/app-store/drafts/${uuid}/submit`],
    ["POST", `/api/app-store/drafts/${uuid}/listing`],
    ["POST", `/api/app-store/drafts/${uuid}/delete`],
    ["GET", "/api/app-store/submissions"],
    ["POST", `/api/app-store/submissions/${uuid}/withdraw`],
    ["GET", "/api/app-store/listings"],
    ["GET", "/api/app-store/listings?q=habit&category=lifestyle&sort=rating&cursor=abc&limit=24"],
    ["GET", "/api/app-store/listings/habit-garden"],
    ["GET", "/api/app-store/listings/habit-garden/icon"],
    ["POST", "/api/app-store/listings/habit-garden/install"],
    ["POST", "/api/app-store/listings/habit-garden/rating"],
  ])("allows %s %s", (method, url) => {
    expect(isAllowedAppStoreGalleryRequest(url, method)).toBe(true);
  });

  it.each([
    ["POST", "/api/app-store/status"],
    ["DELETE", `/api/app-store/drafts/${uuid}`],
    ["GET", `/api/app-store/drafts/not-a-uuid`],
    ["GET", `/api/app-store/drafts/${uuid}/diff`],
    ["GET", `/api/app-store/drafts/${uuid}/diff?path=a&path=b`],
    ["GET", `/api/app-store/drafts/${uuid}/diff?other=1`],
    ["GET", "/api/app-store/listings?admin=1"],
    ["GET", "/api/app-store/listings/Habit"],
    ["GET", "/api/app-store/listings/habit-garden/../review/queue"],
    ["GET", "/api/app-store/listings/habit%2Dgarden"],
    ["POST", "/api/app-store/review/queue"],
    ["GET", "https://evil.example/api/app-store/status"],
    ["GET", "/api/app-store/status#x"],
    ["PUT", "/api/app-store/listings/habit-garden/rating"],
  ])("refuses %s %s", (method, url) => {
    expect(isAllowedAppStoreGalleryRequest(url, method)).toBe(false);
  });
});

describe("reviewer routes", () => {
  it("are part of the Gallery capability", () => {
    expect(isAllowedAppStoreGalleryRequest("/api/app-store/review/queue", "GET")).toBe(true);
    expect(isAllowedAppStoreGalleryRequest(`/api/app-store/review/versions/${uuid}/decision`, "POST")).toBe(true);
  });

  it.each([
    ["GET", "/api/app-store/status", false],
    ["GET", "/api/app-store/review/queue", true],
    ["GET", "/api/app-store/review/queue?status=building&cursor=abc", true],
    ["GET", `/api/app-store/review/versions/${uuid}`, true],
    ["GET", `/api/app-store/review/versions/${uuid}/file?path=src%2FApp.tsx`, true],
    ["GET", `/api/app-store/review/versions/${uuid}/file?path=src%2FApp.tsx&previous=1`, true],
    ["POST", `/api/app-store/review/versions/${uuid}/decision`, true],
    ["POST", `/api/app-store/review/listings/${uuid}/action`, true],
    ["POST", "/api/app-store/review/queue", false],
    ["GET", "/api/app-store/listings", false],
    ["GET", `/api/app-store/review/versions/${uuid}/file`, false],
    ["GET", "/api/app-store/review/queue?status=published", true],
  ])("%s %s -> %s", (method, url, allowed) => {
    expect(isAllowedStoreReviewRequest(url, method)).toBe(allowed);
  });
});

describe("isCommunityBridgeRequestAllowed", () => {
  it.each([
    ["POST", "/api/bridge/query", true],
    ["POST", "/api/bridge/data", true],
    ["POST", "/api/bridge/capabilities", true],
    ["GET", "/api/bridge/service", true],
    ["POST", "/api/bridge/service", true],
    ["POST", "/api/bridge/ai", true],
    ["GET", "/api/bridge/ai/routes", true],
    ["GET", "/api/bridge/proxy?url=https://example.com", false],
    ["GET", "/api/bridge/query", false],
    ["POST", "/api/bridge/query/extra", false],
    ["GET", "/api/apps", false],
    ["GET", "/api/integrations", false],
    ["POST", "/api/app-store/listings/x/install", false],
    ["GET", "/api/system/activity", false],
  ])("%s %s -> %s", (method, url, allowed) => {
    expect(isCommunityBridgeRequestAllowed(url, method)).toBe(allowed);
  });
});
