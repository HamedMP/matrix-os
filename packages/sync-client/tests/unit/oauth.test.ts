import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));
import {
  openBrowser,
  pollForToken,
  requestDeviceCode,
  type OAuthConfig,
} from "../../src/auth/oauth.js";

const config: OAuthConfig = {
  platformUrl: "http://localhost:9000",
  clientId: "matrixos-cli",
};

let tempDirs: string[] = [];

async function createTokenStorePath(fileName: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "matrixos-oauth-test-"));
  tempDirs.push(dir);
  return join(dir, fileName);
}

beforeEach(() => {
  tempDirs = [];
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
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

describe("openBrowser", () => {
  it("opens http(s) verification URLs via execFile", () => {
    openBrowser("https://platform.matrix-os.com/auth/device?user_code=BCDF-GHJK");
    expect(execFileMock).toHaveBeenCalled();
  });

  it("rejects non-http(s) verification URLs", () => {
    expect(() => openBrowser("javascript:alert(1)")).toThrow(
      /Refusing to open non-http\(s\) verification URL/,
    );
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

    const tokenStorePath = await createTokenStorePath("auth.json");

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

    const tokenStorePath = await createTokenStorePath("auth.json");
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

    const tokenStorePath = await createTokenStorePath("auth.json");
    const promise = pollForToken(config, "device-1", 5, 60, tokenStorePath);
    const assertion = expect(promise).rejects.toThrow(/expired/i);

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("throws when the polling deadline elapses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "authorization_pending" }), {
        status: 428,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokenStorePath = await createTokenStorePath("auth.json");
    const promise = pollForToken(config, "device-1", 5, 10, tokenStorePath);
    const assertion = expect(promise).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
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

    const tokenStorePath = await createTokenStorePath("auth.json");

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

    const tokenStorePath = await createTokenStorePath("auth.json");
    const promise = pollForToken(config, "device-1", 5, 60, tokenStorePath);
    const assertion = expect(promise).rejects.toThrow("Token polling failed with status 500");

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    await expect(promise.catch((err: unknown) => String(err))).resolves.not.toMatch(/stack trace/i);
  });

  it("rejects malformed auth payloads before writing them to disk", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: "jwt-token",
          expiresAt: 9_999_999_999_000,
          userId: "user_alice",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokenStorePath = await createTokenStorePath("auth.json");
    const promise = pollForToken(config, "device-1", 5, 60, tokenStorePath);
    const assertion = expect(promise).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });
});
