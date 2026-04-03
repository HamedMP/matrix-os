import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClerkAuth, type ClerkAuth } from "../../packages/platform/src/clerk-auth.js";

describe("ClerkAuth.verify (session routing)", () => {
  let auth: ClerkAuth;

  it("returns authenticated with userId on valid token", async () => {
    auth = createClerkAuth({
      verifyToken: vi.fn().mockResolvedValue({ sub: "user_abc123" }),
    });
    const result = await auth.verify("tok_valid");
    expect(result.authenticated).toBe(true);
    expect(result.userId).toBe("user_abc123");
  });

  it("returns not authenticated on invalid token", async () => {
    auth = createClerkAuth({
      verifyToken: vi.fn().mockRejectedValue(new Error("expired")),
    });
    const result = await auth.verify("tok_expired");
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("returns not authenticated when verifyToken throws non-Error", async () => {
    auth = createClerkAuth({
      verifyToken: vi.fn().mockRejectedValue("string error"),
    });
    const result = await auth.verify("tok_bad");
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe("Token verification failed");
  });
});

describe("Session routing integration (app.matrix-os.com)", () => {
  it("verify extracts userId without matching against expected", async () => {
    const auth = createClerkAuth({
      verifyToken: vi.fn().mockResolvedValue({ sub: "user_xyz" }),
    });

    // verify does NOT check ownership -- just extracts userId
    const result = await auth.verify("tok_session");
    expect(result.authenticated).toBe(true);
    expect(result.userId).toBe("user_xyz");

    // verifyAndMatchOwner would fail with wrong userId
    const matchResult = await auth.verifyAndMatchOwner("tok_session", "user_wrong");
    expect(matchResult.authenticated).toBe(false);
  });
});
