import { describe, expect, it, vi } from "vitest";
import {
  requestDeviceCode,
  pollForToken,
  DEVICE_CLIENT_ID,
  DEVICE_REDIRECT_URI,
} from "@desktop/main/auth/device-auth";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("requestDeviceCode", () => {
  it("posts clientId and parses the device code payload", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        deviceCode: "dc1",
        userCode: "ABCD-1234",
        verificationUri: "https://app.matrix-os.com/activate",
        expiresIn: 600,
        interval: 5,
      }),
    );
    const result = await requestDeviceCode({
      fetchFn,
      baseUrl: "https://app.matrix-os.com",
    });
    expect(result.userCode).toBe("ABCD-1234");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://app.matrix-os.com/api/auth/device/code");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.clientId).toBe(DEVICE_CLIENT_ID);
    expect(body.redirectUri).toBe(DEVICE_REDIRECT_URI);
    expect(body).toMatchObject({
      clientId: "matrix-os-desktop",
      redirectUri: "matrixos://auth?status=approved",
    });
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("maps failures to typed errors", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    await expect(
      requestDeviceCode({ fetchFn, baseUrl: "https://app.matrix-os.com" }),
    ).rejects.toMatchObject({ category: "server" });
  });
});

describe("pollForToken", () => {
  const base = { baseUrl: "https://app.matrix-os.com", deviceCode: "dc1" };

  it("polls at the given interval until authorized", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(428, { error: "authorization_pending" }))
      .mockResolvedValueOnce(jsonResponse(428, { error: "authorization_pending" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { accessToken: "tok", expiresAt: 1750000000000, userId: "u1", handle: "neo" }),
      );
    const sleeps: number[] = [];
    const result = await pollForToken({
      ...base,
      fetchFn,
      intervalSeconds: 5,
      expiresInSeconds: 600,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.accessToken).toBe("tok");
    expect(result.handle).toBe("neo");
    expect(sleeps).toEqual([5000, 5000]);
  });

  it("parses the optional display profile when present", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        accessToken: "tok",
        expiresAt: 1,
        userId: "u1",
        handle: "neo",
        runtimeSlot: "review",
        displayName: "Thomas Anderson",
        imageUrl: "https://img.clerk.com/neo.png",
        email: "neo@matrix-os.com",
      }),
    );
    const result = await pollForToken({ ...base, fetchFn, intervalSeconds: 5, expiresInSeconds: 600, sleep: async () => {} });
    expect(result.displayName).toBe("Thomas Anderson");
    expect(result.imageUrl).toBe("https://img.clerk.com/neo.png");
    expect(result.email).toBe("neo@matrix-os.com");
    expect(result.runtimeSlot).toBe("review");
  });

  it("ignores a non-string display profile and still returns the token", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        accessToken: "tok",
        expiresAt: 1,
        userId: "u1",
        handle: "neo",
        displayName: 42,
        imageUrl: { not: "a string" },
      }),
    );
    const result = await pollForToken({ ...base, fetchFn, intervalSeconds: 5, expiresInSeconds: 600, sleep: async () => {} });
    expect(result.accessToken).toBe("tok");
    expect(result.displayName).toBeUndefined();
    expect(result.imageUrl).toBeUndefined();
  });

  it("adds 5 seconds to the interval on 429 slow_down", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "slow_down" }))
      .mockResolvedValueOnce(jsonResponse(428, { error: "authorization_pending" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { accessToken: "tok", expiresAt: 1, userId: "u", handle: "h" }),
      );
    const sleeps: number[] = [];
    await pollForToken({
      ...base,
      fetchFn,
      intervalSeconds: 5,
      expiresInSeconds: 600,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([10000, 10000]);
  });

  it("throws expired on 410", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(410, { error: "expired_token" }));
    await expect(
      pollForToken({ ...base, fetchFn, intervalSeconds: 5, expiresInSeconds: 600, sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "expired" });
  });

  it("gives up when the device code lifetime is exhausted", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(428, { error: "authorization_pending" }));
    let now = 0;
    await expect(
      pollForToken({
        ...base,
        fetchFn,
        intervalSeconds: 5,
        expiresInSeconds: 12,
        sleep: async (ms) => {
          now += ms;
        },
        clock: () => now,
      }),
    ).rejects.toMatchObject({ code: "expired" });
    expect(fetchFn.mock.calls.length).toBeLessThan(10);
  });

  it("maps 401 to unauthorized", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    await expect(
      pollForToken({ ...base, fetchFn, intervalSeconds: 5, expiresInSeconds: 600, sleep: async () => {} }),
    ).rejects.toMatchObject({ category: "unauthorized" });
  });
});
