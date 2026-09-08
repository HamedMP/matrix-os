import { describe, expect, it } from "vitest";
import { X_SERVICE_REGISTRY } from "../../packages/gateway/src/integrations/registry-x.js";

describe("X integration registry extraction", () => {
  it("owns the complete X service definition outside the shared registry entrypoint", () => {
    expect(Object.keys(X_SERVICE_REGISTRY)).toEqual(["twitter"]);
    expect(X_SERVICE_REGISTRY.twitter).toMatchObject({
      id: "twitter",
      name: "X",
      connectorKind: "pipedream",
      pipedreamApp: "twitter",
      logoUrl: "/integration-logos/x.svg",
    });
    expect(Object.keys(X_SERVICE_REGISTRY.twitter!.actions)).toEqual([
      "get_authenticated_user",
      "get_user_by_username",
      "list_user_posts",
      "search_recent_posts",
      "create_post",
    ]);
  });
});
