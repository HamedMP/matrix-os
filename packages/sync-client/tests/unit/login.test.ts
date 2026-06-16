import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// These mocks intercept the filesystem + device-flow side effects so we can
// assert exactly which auth/config writes happen for each `/api/me` outcome.
const {
  clearProfileAuthMock,
  saveProfileAuthMock,
  saveConfigMock,
  loadConfigMock,
  loadProfilesMock,
  saveProfilesMock,
  loginFn,
} = vi.hoisted(() => ({
  clearProfileAuthMock: vi.fn().mockResolvedValue(undefined),
  saveProfileAuthMock: vi.fn().mockResolvedValue(undefined),
  saveConfigMock: vi.fn().mockResolvedValue(undefined),
  loadConfigMock: vi.fn().mockResolvedValue(null),
  loadProfilesMock: vi.fn().mockResolvedValue({
    active: "cloud",
    profiles: {
      cloud: {
        platformUrl: "https://platform.example",
        gatewayUrl: "https://gateway.example",
      },
    },
  }),
  saveProfilesMock: vi.fn().mockResolvedValue(undefined),
  loginFn: vi.fn(),
}));

vi.mock("../../src/auth/token-store.js", () => ({
  authFilePathForProfile: (profileName: string) => `/tmp/${profileName}/auth.json`,
  clearProfileAuth: clearProfileAuthMock,
  saveProfileAuth: saveProfileAuthMock,
}));

vi.mock("../../src/auth/oauth.js", () => ({
  login: loginFn,
}));

vi.mock("../../src/lib/config.js", () => ({
  defaultPlatformUrl: () => "https://platform.example",
  defaultGatewayUrl: () => "https://gateway.example",
  defaultSyncPath: () => "/tmp/syncpath",
  generatePeerId: () => "peer-test",
  loadConfig: loadConfigMock,
  saveConfig: saveConfigMock,
}));

vi.mock("../../src/lib/profiles.js", () => ({
  loadProfiles: loadProfilesMock,
  saveProfiles: saveProfilesMock,
}));

const PLATFORM_URL = "https://platform.example";
const AUTH = {
  accessToken: "access-token",
  expiresAt: Date.now() + 60_000,
  userId: "user_test",
  handle: "alice",
};

async function runLogin(args: Record<string, unknown> = {}): Promise<void> {
  const mod = await import("../../src/cli/commands/login.js");
  // citty commands expose a `run` fn; we pass no args so the non-dev path runs.
  await mod.loginCommand.run!({ args: { dev: false, ...args } } as never);
}

function lastJsonError(): {
  code: string;
  message: string;
  authenticated?: boolean;
  connected?: boolean;
  journey?: unknown;
  suggestedCommand?: string | null;
} {
  const errArg = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls.at(-1)?.[0];
  return JSON.parse(errArg as string).error;
}

beforeEach(() => {
  clearProfileAuthMock.mockClear();
  saveProfileAuthMock.mockClear();
  saveConfigMock.mockClear();
  loadConfigMock.mockClear();
  loadProfilesMock.mockClear();
  saveProfilesMock.mockClear();
  loginFn.mockReset();
  loginFn.mockResolvedValue(AUTH);
  vi.resetModules();
  // Silence console.log/error so test output stays readable; we're asserting
  // side-effect calls, not stdout.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = 0;
});

describe("loginCommand /api/me handling", () => {
  it("preserves auth and does NOT save config when /api/me returns 404", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/me")) return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({ phase: "provisioning", detail: "d", nextAction: { kind: "wait" } }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await runLogin();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(clearProfileAuthMock).not.toHaveBeenCalled();
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("emits JSON error output when /api/me returns 404 in --json mode", async () => {
    const journey = { phase: "plan_required", detail: "d", nextAction: { kind: "open_plans", url: "https://app.matrix-os.com/?plans=1" } };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/me")) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(journey), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runLogin({ json: true });

    expect(process.exitCode).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(lastJsonError()).toMatchObject({
      code: "login_failed",
      authenticated: true,
      connected: false,
      journey,
      suggestedCommand: "setup",
    });
    expect(lastJsonError().message).toContain("Choose a plan");
    expect(clearProfileAuthMock).not.toHaveBeenCalled();
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("preserves auth and does NOT save config when /api/me returns 500", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("boom", { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runLogin();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Critical: auth token stays on disk so user can retry after transient fix.
    expect(clearProfileAuthMock).not.toHaveBeenCalled();
    // Critical: no half-provisioned config with a guessed gatewayUrl.
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("preserves auth and does NOT save config when /api/me throws (network error)", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    await runLogin();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clearProfileAuthMock).not.toHaveBeenCalled();
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("preserves auth and does NOT save config on other non-ok status (502)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("bad gateway", { status: 502 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runLogin();

    expect(clearProfileAuthMock).not.toHaveBeenCalled();
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("falls back to defaultGatewayUrl when /api/me returns 200 without one", async () => {
    // Regression: earlier impl fell back to `platformUrl`, which was wrong
    // when --platform pointed at a dev override (`http://localhost:9000`).
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ userId: "user_test", handle: "alice" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runLogin();

    expect(saveConfigMock).toHaveBeenCalledTimes(1);
    const written = saveConfigMock.mock.calls[0]![0];
    expect(written.gatewayUrl).toBe("https://gateway.example");
    expect(written.platformUrl).toBe(PLATFORM_URL);
  });

  it("saves config with the server-supplied gatewayUrl on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          userId: "user_test",
          handle: "alice",
          gatewayUrl: "https://app.matrix-os.com",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runLogin();

    expect(clearProfileAuthMock).not.toHaveBeenCalled();
    expect(saveConfigMock).toHaveBeenCalledTimes(1);
    const written = saveConfigMock.mock.calls[0]![0];
    expect(written.platformUrl).toBe(PLATFORM_URL);
    expect(written.gatewayUrl).toBe("https://app.matrix-os.com");
    expect(written.syncPath).toBe("/tmp/syncpath");
    expect(written.peerId).toBe("peer-test");
  });
});
