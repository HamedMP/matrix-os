import { describe, expect, it, vi } from "vitest";
import {
  enrollSyncDeviceAuth,
  refreshSyncDeviceAuth,
  revokeSyncDeviceAuth,
  SyncDeviceAuthError,
} from "../../src/auth/sync-device.js";

const AUTH = {
  accessToken: "access-old",
  refreshToken: `sdr_18e9ee9f-ec1f-45b7-b0c2-b51a47e6da8c.${"a".repeat(43)}`,
  expiresAt: 1_800_000_000_000,
  userId: "user_alice",
  handle: "alice",
  runtimeSlot: "primary",
};

describe("sync-device auth client", () => {
  it("enrolls with the Desktop bearer and verifies the selected identity", async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
      JSON.stringify(AUTH),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    await expect(enrollSyncDeviceAuth({
      platformUrl: "https://app.matrix-os.com",
      desktopAccessToken: "desktop-secret",
      deviceName: "Alice Mac",
      expected: {
        userId: AUTH.userId,
        handle: AUTH.handle,
        runtimeSlot: AUTH.runtimeSlot,
      },
      fetchFn,
    })).resolves.toEqual(AUTH);

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://app.matrix-os.com/api/auth/sync-device/enroll");
    expect(init?.headers).toMatchObject({ authorization: "Bearer desktop-secret" });
    expect(init?.body).not.toContain("desktop-secret");
  });

  it("rejects an enrollment credential for a different runtime", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      ...AUTH,
      runtimeSlot: "other",
    }), { status: 200 }));

    await expect(enrollSyncDeviceAuth({
      platformUrl: "https://app.matrix-os.com",
      desktopAccessToken: "desktop-secret",
      deviceName: "Alice Mac",
      expected: {
        userId: AUTH.userId,
        handle: AUTH.handle,
        runtimeSlot: AUTH.runtimeSlot,
      },
      fetchFn,
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rotates the credential over a bounded request and persists the complete response", async () => {
    const rotated = { ...AUTH, accessToken: "access-new", refreshToken: AUTH.refreshToken.replace(/a+$/, "b".repeat(43)) };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(rotated), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const save = vi.fn(async () => undefined);

    await expect(refreshSyncDeviceAuth({
      platformUrl: "https://app.matrix-os.com/",
      auth: AUTH,
      fetchFn,
      save,
    })).resolves.toEqual(rotated);

    expect(fetchFn).toHaveBeenCalledWith(
      "https://app.matrix-os.com/api/auth/sync-device/refresh",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
    expect(save).toHaveBeenCalledWith(rotated);
  });

  it("maps rejected and malformed refreshes to stable errors without persisting", async () => {
    const save = vi.fn(async () => undefined);
    await expect(refreshSyncDeviceAuth({
      platformUrl: "https://app.matrix-os.com",
      auth: AUTH,
      fetchFn: vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 })),
      save,
    })).rejects.toMatchObject({ code: "needs_sign_in" });
    await expect(refreshSyncDeviceAuth({
      platformUrl: "https://app.matrix-os.com",
      auth: AUTH,
      fetchFn: vi.fn(async () => new Response(JSON.stringify({ accessToken: "provider-secret" }), { status: 200 })),
      save,
    })).rejects.toBeInstanceOf(SyncDeviceAuthError);
    expect(save).not.toHaveBeenCalled();
  });

  it("revokes by refresh credential without putting it in the URL or authorization header", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await revokeSyncDeviceAuth({
      platformUrl: "https://app.matrix-os.com",
      auth: AUTH,
      fetchFn,
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).not.toContain(AUTH.refreshToken);
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(init.body).toContain(AUTH.refreshToken);
  });
});
