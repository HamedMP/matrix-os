import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { delegatedIntegrationHeaders } from "../../packages/gateway/src/integrations/delegated-identity.js";

describe("delegated integration identity", () => {
  it("signs the authenticated actor with the per-machine platform token", () => {
    const headers = delegatedIntegrationHeaders("user_collaborator", "machine-token");
    expect(headers).toEqual({
      "x-platform-user-id": "user_collaborator",
      "x-platform-verified": createHmac("sha256", "machine-token")
        .update("user_collaborator").digest("hex"),
    });
  });

  it("rejects an invalid actor id", () => {
    expect(() => delegatedIntegrationHeaders("user/other", "machine-token")).toThrow();
  });
});
