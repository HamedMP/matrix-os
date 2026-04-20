import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  pollForToken,
  requestDeviceCode,
  type OAuthConfig,
} from "../../src/auth/oauth.js";

const config: OAuthConfig = {
  platformUrl: "http://localhost:9000",
  clientId: "matrixos-cli",
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("requestDeviceCode", () => {
  it("POSTs to /api/auth/device/code with the clientId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          deviceCode: "abc",
          userCode: "BCDF-GHJK",
          verificationUri: "http://localhost:9000/auth/device?user_code=BCDF-GHJK",
          expiresIn: 900,
          interval: 5,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestDeviceCode(config);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:9000/api/auth/device/code",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ clientId: "matrixos-cli" }),
      }),
    );
    expect(result.deviceCode).toBe("abc");
    expect(result.userCode).toBe("BCDF-GHJK");
  });
});

describe("pollForToken", () => {
  it("respects the polling interval", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 428,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accessToken: "jwt-token",
            expiresAt: 9_999_999_999_000,
            userId: "user_alice",
            handle: "alice",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const tokenStorePath = "/tmp/test-auth-1.json";

    const promise = pollForToken(config, "device-1", 5, 60, tokenStorePath);

    // First poll fires after 5s
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second poll fires after another 5s
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(result.accessToken).toBe("jwt-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats 429 slow_down by extending the interval and retrying", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "slow_down" }), { status: 429 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accessToken: "jwt-token",
            expiresAt: 9_999_999_999_000,
            userId: "user_alice",
            handle: "alice",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const tokenStorePath = "/tmp/test-auth-2.json";
    const promise = pollForToken(config, "device-1", 5, 60, tokenStorePath);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // After slow_down, next attempt should wait at least one extra interval
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;
    expect(result.accessToken).toBe("jwt-token");
  });

  it("throws on 410 expired_token", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "expired_token" }), { status: 410 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokenStorePath = "/tmp/test-auth-3.json";
    const promise = pollForToken(config, "device-1", 5, 60, tokenStorePath);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).rejects.toThrow(/expired/i);
  });

  it("throws when the polling deadline elapses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "authorization_pending" }), {
        status: 428,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokenStorePath = "/tmp/test-auth-4.json";
    const promise = pollForToken(config, "device-1", 5, 10, tokenStorePath);

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(promise).rejects.toThrow(/timed out/i);
  });

  it("persists the returned token to the configured path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: "jwt-token",
          expiresAt: 9_999_999_999_000,
          userId: "user_alice",
          handle: "alice",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmp = await mkdtemp(join(tmpdir(), "oauth-test-"));
    const tokenStorePath = join(tmp, "auth.json");

    const promise = pollForToken(config, "device-1", 5, 60, tokenStorePath);
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;

    const written = JSON.parse(await readFile(tokenStorePath, "utf-8"));
    expect(written.accessToken).toBe("jwt-token");
    expect(written.handle).toBe("alice");
  });

  it("does not leak raw response bodies in polling errors", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("<html>stack trace</html>", { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const promise = pollForToken(config, "device-1", 5, 60, "/tmp/test-auth-5.json");

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).rejects.toThrow("Token polling failed with status 500");
    await expect(promise).rejects.not.toThrow(/stack trace/i);
  });
});
