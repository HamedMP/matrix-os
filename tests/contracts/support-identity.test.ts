import { describe, expect, it } from "vitest";
import { SupportIdentityResponseSchema } from "@matrix-os/contracts";

describe("Support identity contract", () => {
  it("accepts only a bounded Clerk distinct ID and SHA-256 HMAC", () => {
    expect(SupportIdentityResponseSchema.safeParse({
      status: "verified",
      distinctId: "user_2abcDEF",
      identityHash: "ab".repeat(32),
    }).success).toBe(true);

    expect(SupportIdentityResponseSchema.safeParse({
      status: "verified",
      distinctId: "customer@example.com",
      identityHash: "ab".repeat(32),
    }).success).toBe(false);
    expect(SupportIdentityResponseSchema.safeParse({
      status: "verified",
      distinctId: "user_2abcDEF",
      identityHash: "not-a-signature",
    }).success).toBe(false);
  });

  it("keeps degraded responses generic and rejects extra diagnostic fields", () => {
    expect(SupportIdentityResponseSchema.safeParse({ status: "unavailable" }).success).toBe(true);
    expect(SupportIdentityResponseSchema.safeParse({
      status: "unavailable",
      error: "POSTHOG_CONVERSATIONS_IDENTITY_SECRET missing",
    }).success).toBe(false);
  });
});
