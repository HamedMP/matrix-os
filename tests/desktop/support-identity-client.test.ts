import { describe, expect, it, vi } from "vitest";
import { fetchDesktopSupportIdentity } from "@desktop/main/support/support-identity-client";

function auth(overrides: {
  token?: string | null;
  origin?: string;
  userId?: string;
  authGeneration?: number;
} = {}) {
  const userId = overrides.userId ?? "user_alice";
  const authGeneration = overrides.authGeneration ?? 1;
  return {
    getToken: vi.fn(() => overrides.token === undefined ? "encrypted-device-token" : overrides.token),
    getGatewayOrigin: vi.fn(() => overrides.origin ?? "https://app.matrix-os.com"),
    getStatus: vi.fn(() => ({
      signedIn: true as const,
      handle: "alice",
      userId,
      runtimeSlot: "primary",
      platformHost: overrides.origin ?? "https://app.matrix-os.com",
      authGeneration,
    })),
  };
}

describe("Desktop Support identity client", () => {
  it("uses the trusted credential and validates the signed identity response", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      status: "verified",
      distinctId: "user_alice",
      identityHash: "ab".repeat(32),
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(fetchDesktopSupportIdentity(auth(), { fetchFn })).resolves.toEqual({
      status: "verified",
      distinctId: "user_alice",
      identityHash: "ab".repeat(32),
    });
    expect(fetchFn).toHaveBeenCalledWith("https://app.matrix-os.com/api/support/identity", {
      method: "GET",
      headers: { authorization: "Bearer encrypted-device-token" },
      signal: expect.any(AbortSignal),
    });
  });

  it("does not call the server without an active credential", async () => {
    const fetchFn = vi.fn();

    await expect(fetchDesktopSupportIdentity(auth({ token: null }), { fetchFn })).resolves.toEqual({
      status: "unavailable",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects a stale or mismatched identity after an account change", async () => {
    const account = auth();
    const fetchFn = vi.fn(async () => {
      account.getStatus.mockReturnValue({
        signedIn: true,
        handle: "bob",
        userId: "user_bob",
        runtimeSlot: "primary",
        platformHost: "https://app.matrix-os.com",
        authGeneration: 2,
      });
      return new Response(JSON.stringify({
        status: "verified",
        distinctId: "user_alice",
        identityHash: "ab".repeat(32),
      }), { status: 200 });
    });

    await expect(fetchDesktopSupportIdentity(account, { fetchFn })).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("degrades without exposing malformed or oversized server responses", async () => {
    const malformedFetch = vi.fn(async () => new Response(JSON.stringify({
      status: "unavailable",
      error: "/home/matrix/posthog-secret",
    }), { status: 200 }));
    const oversizedFetch = vi.fn(async () => new Response("x".repeat(20_000), { status: 200 }));

    await expect(fetchDesktopSupportIdentity(auth(), { fetchFn: malformedFetch })).resolves.toEqual({
      status: "unavailable",
    });
    await expect(fetchDesktopSupportIdentity(auth(), { fetchFn: oversizedFetch })).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("aborts a stalled platform request and returns a generic degraded result", async () => {
    const fetchFn = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));

    await expect(fetchDesktopSupportIdentity(auth(), { fetchFn, timeoutMs: 5 })).resolves.toEqual({
      status: "unavailable",
    });
  });
});
