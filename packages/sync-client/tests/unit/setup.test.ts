import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the profile/auth resolvers so `mos setup` runs as an authenticated user
// and we can drive only the fetch behavior under test.
const { resolveCliProfileMock, resolveCliAuthStatusMock } = vi.hoisted(() => ({
  resolveCliProfileMock: vi.fn(),
  resolveCliAuthStatusMock: vi.fn(),
}));

vi.mock("../../src/cli/profiles.js", () => ({
  resolveCliProfile: resolveCliProfileMock,
}));
vi.mock("../../src/cli/auth-state.js", () => ({
  resolveCliAuthStatus: resolveCliAuthStatusMock,
}));

async function runSetup(args: Record<string, unknown>): Promise<void> {
  const mod = await import("../../src/cli/commands/setup.js");
  await mod.setupCommand.run!({ args } as never);
}

beforeEach(() => {
  resolveCliProfileMock.mockReset().mockResolvedValue({ platformUrl: "https://platform.example" });
  resolveCliAuthStatusMock.mockReset().mockResolvedValue({ status: "authenticated", token: "tok" });
  vi.resetModules();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = 0;
});

describe("mos setup poll loop", () => {
  it("bails after repeated journey failures instead of sleeping the full ceiling", async () => {
    // retry-provision succeeds, then every journey poll 401s (auth expired
    // mid-provision) and fetchJourney collapses it to null.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/journey/retry-provision")) return new Response("{}", { status: 200 });
      return new Response("", { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runSetup({ json: true, "poll-interval-ms": "1" });

    expect(process.exitCode).toBe(1);
    // 1 retry-provision + 5 (MAX_CONSECUTIVE_FAILURES) journey polls — NOT 180.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(console.error).toHaveBeenCalled();
  });

  it("recovers when a transient failure is followed by a terminal phase", async () => {
    let journeyCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/journey/retry-provision")) return new Response("{}", { status: 200 });
      journeyCalls += 1;
      if (journeyCalls <= 2) return new Response("", { status: 503 }); // transient
      return new Response(
        JSON.stringify({ phase: "ready", detail: "d", nextAction: { kind: "login" } }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await runSetup({ json: true, "poll-interval-ms": "1" });

    // Two transient failures didn't trip the bail; the loop reached `ready`.
    expect(process.exitCode).toBe(0);
  });

  it("emits a structured error in --json mode when provisioning fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/journey/retry-provision")) return new Response("{}", { status: 200 });
      return new Response(
        JSON.stringify({ phase: "provisioning_failed", detail: "d", nextAction: { kind: "contact_support" }, failure: { retryable: false, attempt: 3 } }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await runSetup({ json: true, "poll-interval-ms": "1" });

    expect(process.exitCode).toBe(1);
    const errArg = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls.at(-1)?.[0];
    expect(JSON.parse(errArg as string).error.code).toBe("retry_exhausted");
  });

  it("emits a structured error in --json mode when a plan is still required", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/journey/retry-provision")) return new Response("{}", { status: 200 });
      return new Response(
        JSON.stringify({ phase: "plan_required", detail: "d", nextAction: { kind: "open_plans" } }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await runSetup({ json: true, "poll-interval-ms": "1" });

    expect(process.exitCode).toBe(1);
    const errArg = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls.at(-1)?.[0];
    expect(JSON.parse(errArg as string).error.code).toBe("billing_required");
  });

  it("rejects a non-finite --poll-interval-ms instead of hanging", async () => {
    // Reaching `ready` immediately proves the loop ran with a sane interval and
    // did not hang on setTimeout(Infinity).
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/journey/retry-provision")) return new Response("{}", { status: 200 });
      return new Response(
        JSON.stringify({ phase: "ready", detail: "d", nextAction: { kind: "login" } }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await runSetup({ json: true, "poll-interval-ms": "Infinity" });

    expect(process.exitCode).toBe(0);
  });
});
