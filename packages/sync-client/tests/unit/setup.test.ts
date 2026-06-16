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

function lastJsonError(): { code: string; message: string } {
  const errArg = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls.at(-1)?.[0];
  return JSON.parse(errArg as string).error;
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
    expect(lastJsonError()).toMatchObject({
      code: "platform_unreachable",
      message: "Platform unreachable. Matrix CLI could not contact the Matrix OS platform.",
    });
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

  it("routes the initial 402 billing error to stderr (not stdout) in --json mode", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/journey/retry-provision")) return new Response("", { status: 402 });
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runSetup({ json: true, "poll-interval-ms": "1" });

    expect(process.exitCode).toBe(1);
    // Only retry-provision runs; the journey is not fetched in JSON mode.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastJsonError()).toMatchObject({
      code: "billing_required",
      message: "Choose a plan before running setup. Visit https://app.matrix-os.com/?plans=1.",
    });
    expect(console.log).not.toHaveBeenCalled();
  });

  it("emits a structured error in --json mode when not authenticated", async () => {
    resolveCliAuthStatusMock.mockResolvedValueOnce({ status: "missing" });

    await runSetup({ json: true, "poll-interval-ms": "1" });

    expect(process.exitCode).toBe(1);
    expect(lastJsonError()).toMatchObject({
      code: "not_authenticated",
      message: "Not signed in. Run `mos login` first.",
    });
  });

  it("emits a structured error in --json mode when setup cannot start", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/journey/retry-provision")) return new Response("", { status: 503 });
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runSetup({ json: true, "poll-interval-ms": "1" });

    expect(process.exitCode).toBe(1);
    expect(lastJsonError()).toMatchObject({
      code: "setup_failed",
      message: "Couldn't start setup. Please try again shortly.",
    });
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
    expect(lastJsonError()).toMatchObject({
      code: "retry_exhausted",
      message: "Setup has failed repeatedly. Contact support@matrix-os.com.",
    });
  });

  it("breaks out with support guidance when payment settling is delayed", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/journey/retry-provision")) return new Response("{}", { status: 200 });
      return new Response(
        JSON.stringify({ phase: "payment_settling", detail: "d", nextAction: { kind: "wait" }, settling: { since: "x", delayed: true } }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await runSetup({ json: true, "poll-interval-ms": "1" });

    expect(process.exitCode).toBe(1);
    // retry-provision + a single journey poll — does NOT loop to the ceiling.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastJsonError()).toMatchObject({
      code: "payment_delayed",
      message: "Payment is taking longer than expected to confirm. Contact support@matrix-os.com if it persists.",
    });
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
    expect(lastJsonError()).toMatchObject({
      code: "billing_required",
      message: "Choose a plan before running setup. Visit https://app.matrix-os.com/?plans=1.",
    });
  });

  it("emits a structured timeout error in --json mode when setup never finishes", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/journey/retry-provision")) return new Response("{}", { status: 200 });
      return new Response(
        JSON.stringify({ phase: "provisioning", detail: "d", nextAction: { kind: "wait" }, provisioning: { stage: "installing" } }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await runSetup({ json: true, "poll-interval-ms": "1" });

    expect(process.exitCode).toBe(1);
    expect(lastJsonError()).toMatchObject({
      code: "setup_timeout",
      message: "Setup is taking longer than expected. Re-run `mos login` shortly to check.",
    });
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
