import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
const { execFileMock, platformMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  platformMock: vi.fn(() => "darwin"),
}));
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  platform: platformMock,
}));
import {
  login,
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
  execFileMock.mockReset();
  platformMock.mockReturnValue("darwin");
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("requestDeviceCode", () => {
  const validDeviceResponse = {
    deviceCode: "device-1",
    userCode: "BCDF-GHJK",
    verificationUri: "https://app.matrix-os.com/auth/device?user_code=BCDF-GHJK",
    expiresIn: 900,
    interval: 5,
  };

  it.each([
    null,
    {},
    { ...validDeviceResponse, deviceCode: "" },
    { ...validDeviceResponse, deviceCode: 123 },
    { ...validDeviceResponse, userCode: "BCDF\nGHJK" },
    { ...validDeviceResponse, userCode: "" },
    { ...validDeviceResponse, expiresIn: "900" },
    { ...validDeviceResponse, expiresIn: -1 },
    { ...validDeviceResponse, expiresIn: 100_000 },
    { ...validDeviceResponse, interval: 0 },
    { ...validDeviceResponse, interval: 1.5 },
    { ...validDeviceResponse, interval: 10_000 },
    { ...validDeviceResponse, verificationUri: "file:///C:/Windows/example.exe" },
    { ...validDeviceResponse, verificationUri: "https://user:secret@example.com/auth/device" },
    { ...validDeviceResponse, verificationUri: "https://example.com/auth/device\n" },
  ])("rejects malformed device responses at the response boundary (%#)", async (body) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
    vi.stubGlobal("fetch", fetchMock);
    execFileMock.mockClear();

    await expect(requestDeviceCode(config)).rejects.toMatchObject({
      code: "login_failed",
      message: "Request failed",
    });

    expect(execFileMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid JSON with a safe login error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json")));
    await expect(requestDeviceCode(config)).rejects.toMatchObject({
      code: "login_failed",
      message: "Request failed",
    });
  });

  it.each([
    { error: new TypeError("connection closed while reading response"), code: "platform_unreachable" },
    { error: new DOMException("response body aborted", "AbortError"), code: "request_timeout" },
    { error: new DOMException("response body timed out", "TimeoutError"), code: "request_timeout" },
    { error: new Error("unexpected response reader failure"), code: "login_failed" },
  ])("maps response-body failures to a safe $code error", async ({ error, code }) => {
    const response = new Response(JSON.stringify(validDeviceResponse));
    const jsonSpy = vi.spyOn(response, "json").mockRejectedValue(error);
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestDeviceCode(config)).rejects.toMatchObject({
      code,
      message: "Request failed",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jsonSpy).toHaveBeenCalledTimes(1);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("accepts a configured public verification origin different from the API origin", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(validDeviceResponse))));
    await expect(requestDeviceCode(config)).resolves.toEqual(validDeviceResponse);
  });

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

  it("maps device-code network errors to platform_unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("connect ECONNREFUSED 127.0.0.1:9000");
    }));

    await expect(requestDeviceCode(config)).rejects.toMatchObject({
      code: "platform_unreachable",
      message: "Request failed",
    });
  });

  it("maps device-code aborts to request_timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    }));

    await expect(requestDeviceCode(config)).rejects.toMatchObject({
      code: "request_timeout",
      message: "Request failed",
    });
  });
});

describe("openBrowser", () => {
  it("opens http(s) verification URLs via execFile", () => {
    openBrowser("https://platform.matrix-os.com/auth/device?user_code=BCDF-GHJK");
    expect(execFileMock).toHaveBeenCalled();
  });

  it("prints the user code to stderr if browser open fails", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    execFileMock.mockImplementationOnce((_cmd, _args, callback) => {
      callback(new Error("xdg-open unavailable"));
    });

    openBrowser("https://platform.matrix-os.com/auth/device", "BCDF-GHJK");

    expect(errorSpy).toHaveBeenCalledWith(
      "Could not open browser. Visit: https://platform.matrix-os.com/auth/device\nEnter code: BCDF-GHJK",
    );
  });

  it("rejects non-http(s) verification URLs", () => {
    expect(() => openBrowser("javascript:alert(1)")).toThrow(
      /Request failed/,
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
    await expect(promise).rejects.toMatchObject({ code: "login_failed" });
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

  it("maps token polling network failures to platform_unreachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed with token details");
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokenStorePath = await createTokenStorePath("auth.json");
    const promise = pollForToken(config, "device-1", 5, 60, tokenStorePath);
    const assertion = expect(promise).rejects.toMatchObject({
      code: "platform_unreachable",
      message: "Request failed",
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
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

describe("login", () => {
  it("rejects an invalid verification response before display, launch, or polling", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      deviceCode: "device-1",
      userCode: "BCDF-GHJK",
      verificationUri: "https://user:secret@example.com/auth/device",
      expiresIn: 900,
      interval: 5,
    })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(login(config)).rejects.toMatchObject({ code: "login_failed" });
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("completes Windows login and persists the token while keeping quiet stdout clean", async () => {
    platformMock.mockReturnValue("win32");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => callback(null));
    const token = {
      accessToken: "jwt-token", expiresAt: 9_999_999_999_000, userId: "user_alice", handle: "alice",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        deviceCode: "device-1", userCode: "BCDF-GHJK",
        verificationUri: "https://app.matrix-os.com/auth/device?user_code=BCDF-GHJK&intent=sign-in",
        expiresIn: 900, interval: 5,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify(token)));
    vi.stubGlobal("fetch", fetchMock);
    const tokenStorePath = await createTokenStorePath("auth.json");

    const promise = login({ ...config, quiet: true, tokenStorePath });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toEqual(token);
    expect(JSON.parse(await readFile(tokenStorePath, "utf-8"))).toEqual(token);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(execFileMock).toHaveBeenCalledWith(
      "powershell.exe", expect.any(Array), expect.objectContaining({ shell: false }), expect.any(Function),
    );
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("keeps JSON-mode stdout clean while preserving manual device-flow recovery on stderr", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    execFileMock.mockImplementationOnce((_cmd, _args, callback) => {
      callback(new Error("xdg-open unavailable"));
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deviceCode: "device-1",
            userCode: "BCDF-GHJK",
            verificationUri: "https://platform.matrix-os.com/auth/device",
            expiresIn: 10,
            interval: 5,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "authorization_pending" }), { status: 428 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const tokenStorePath = await createTokenStorePath("auth.json");
    const promise = login({ ...config, tokenStorePath, quiet: true });
    const assertion = expect(promise).rejects.toMatchObject({ code: "login_failed" });

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "Could not open browser. Visit: https://platform.matrix-os.com/auth/device\nEnter code: BCDF-GHJK",
    );
  });
});
