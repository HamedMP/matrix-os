import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CLERK_SESSION_REVOKE_TIMEOUT_MS,
  createClerkAuth,
  createClerkSessionRevoker,
  type ClerkAuth,
} from "../../packages/platform/src/clerk-auth.js";

describe("T800: Clerk JWT verification on subdomain proxy", () => {
  let auth: ClerkAuth;

  beforeEach(() => {
    auth = createClerkAuth({
      verifyToken: vi.fn(),
    });
  });

  it("extracts session token from __session cookie", () => {
    const token = auth.extractToken(
      undefined,
      "__session=tok_test123; other=value"
    );
    expect(token).toBe("tok_test123");
  });

  it("extracts session token from Authorization header", () => {
    const token = auth.extractToken("Bearer tok_test123", undefined);
    expect(token).toBe("tok_test123");
  });

  it("prefers Authorization header over cookie", () => {
    const token = auth.extractToken(
      "Bearer from_header",
      "__session=from_cookie"
    );
    expect(token).toBe("from_header");
  });

  it("returns null when no token found", () => {
    const token = auth.extractToken(undefined, undefined);
    expect(token).toBeNull();
  });

  it("returns null for malformed Authorization header", () => {
    const token = auth.extractToken("Basic dXNlcjpwYXNz", undefined);
    expect(token).toBeNull();
  });

  it("verifyAndMatchOwner returns true when userId matches", async () => {
    const verifyFn = vi.fn().mockResolvedValue({ sub: "user_abc123" });
    auth = createClerkAuth({ verifyToken: verifyFn });

    const result = await auth.verifyAndMatchOwner("tok_test", "user_abc123");
    expect(result.authenticated).toBe(true);
    expect(result.userId).toBe("user_abc123");
  });

  it("verifyAndMatchOwner returns false when userId doesn't match", async () => {
    const verifyFn = vi.fn().mockResolvedValue({ sub: "user_other" });
    auth = createClerkAuth({ verifyToken: verifyFn });

    const result = await auth.verifyAndMatchOwner("tok_test", "user_abc123");
    expect(result.authenticated).toBe(false);
  });

  it("verifyAndMatchOwner returns false when token is invalid", async () => {
    const verifyFn = vi.fn().mockRejectedValue(new Error("invalid token"));
    auth = createClerkAuth({ verifyToken: verifyFn });

    const result = await auth.verifyAndMatchOwner("tok_test", "user_abc123");
    expect(result.authenticated).toBe(false);
  });

  it("/health is a public path", () => {
    expect(auth.isPublicPath("/health")).toBe(true);
  });

  it("other paths are not public", () => {
    expect(auth.isPublicPath("/api/message")).toBe(false);
    expect(auth.isPublicPath("/ws")).toBe(false);
  });

  it("extracts the Clerk session id from verified JWT claims", async () => {
    const verifyFn = vi.fn().mockResolvedValue({ sub: "user_abc123", sid: "sess_123" });
    auth = createClerkAuth({ verifyToken: verifyFn });

    const result = await auth.verify("tok_test");

    expect(result).toEqual({
      authenticated: true,
      userId: "user_abc123",
      sessionId: "sess_123",
    });
  });

  it("revokes Clerk sessions with a bounded direct Backend API fetch", async () => {
    const signal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const revokeSession = createClerkSessionRevoker({
      secretKey: "sk_test_matrix",
      fetchImpl: fetchMock,
    });

    await revokeSession("sess/with/slashes");

    expect(timeoutSpy).toHaveBeenCalledWith(CLERK_SESSION_REVOKE_TIMEOUT_MS);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clerk.com/v1/sessions/sess%2Fwith%2Fslashes/revoke",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer sk_test_matrix",
          Accept: "application/json",
        },
        signal,
      }),
    );
  });
});
