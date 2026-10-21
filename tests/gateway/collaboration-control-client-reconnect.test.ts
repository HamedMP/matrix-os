/**
 * Control client reconnect discipline: backoff is reset only by a stream that proved healthy
 * (applied an inbound frame), reconnect and re-registration delays are jittered so a fleet
 * that loses its streams together does not reconnect in lockstep, and a platform Retry-After
 * on registration is honored as the floor for the next attempt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollaborationControlClient, parseRetryAfterMs } from "../../packages/gateway/src/collaboration/control-client.js";

const machineId = "11111111-1111-4111-8111-111111111111";
const runtimeId = `vps:${machineId}`;
const logicalRuntimeId = `vps-${machineId}`;
const keepalive = JSON.stringify({ protocolVersion: 2, type: "generation", runtimeId: logicalRuntimeId, authorityGeneration: 1 });
const invalidFrame = "{\"protocolVersion\":1}";
function denialFrame(): string {
  const fencedAt = new Date(Date.now());
  return JSON.stringify({
    protocolVersion: 2,
    type: "denial",
    denial: {
      organizationId: "org_reconnect_1",
      actorId: "user_collaboration_editor",
      generation: 2,
      fencedAt: fencedAt.toISOString(),
      ackDeadline: new Date(fencedAt.getTime() + 25_000).toISOString(),
      state: "pending",
    },
  });
}

function registrationResponse(): Response {
  return new Response(JSON.stringify({
    protocolVersion: 2,
    runtime: { runtimeId: logicalRuntimeId, authorityGeneration: 1, registeredAt: new Date().toISOString() },
    platformSigningKeys: [{ keyId: "platform-key-1", algorithm: "ed25519", publicKey: "A".repeat(43) }],
    controlTicket: "t".repeat(43),
    relay: { origin: "https://app.matrix-os.com" },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * fail: upgrade rejected. healthy: one keepalive, then stays open. invalid: a refused first frame.
 * flap: one keepalive, then the platform closes it a second later (e.g. 1008).
 * poison: one keepalive, then a frame the client always refuses a second later.
 * slow_denial: a denial whose grant cleanup is still in flight when the platform closes the stream.
 */
type StreamMode = "fail" | "healthy" | "invalid" | "flap" | "poison" | "slow_denial";

interface Harness {
  client: CollaborationControlClient;
  /** Fake-clock times at which a registration was attempted. */
  registrations: number[];
  /** Fake-clock times at which a control socket was opened. */
  connects: number[];
  /** Fake-clock times at which a socket close was delivered to the client. */
  closes: number[];
  acks: unknown[];
  /** Closes the most recent stream from the platform side (e.g. a routine 1012 rotation). */
  dropLatest(): void;
  /** Delivers a raw frame on the most recent stream. */
  sendLatest(raw: string): void;
}

function harness(input: {
  streams?: StreamMode[] | ((index: number) => StreamMode);
  responses?: Array<() => Response>;
  random?: () => number;
  capabilities?: { endActorGrants(input: { organizationId: string; actorId: string }): Promise<unknown> };
}): Harness {
  const registrations: number[] = [];
  const connects: number[] = [];
  const closes: number[] = [];
  const acks: unknown[] = [];
  let latestClose: (() => void) | undefined;
  let latestMessage: ((raw: string) => void) | undefined;
  const modeFor = (index: number): StreamMode => {
    if (typeof input.streams === "function") return input.streams(index);
    return input.streams?.[index] ?? "healthy";
  };
  const client = new CollaborationControlClient({
    platformBaseUrl: "https://platform.internal",
    runtimeId,
    ownerId: "user_owner000000000000000000",
    relayHandle: "owner-handle",
    serviceToken: "s".repeat(40),
    identity: { keyId: "home-key-1", publicKey: "k".repeat(43) },
    sessions: { revoke: () => undefined },
    ...(input.capabilities ? { capabilities: input.capabilities as never } : {}),
    fetchImpl: (async () => {
      const index = registrations.length;
      registrations.push(Date.now());
      return input.responses?.[index]?.() ?? registrationResponse();
    }) as never,
    connect: (_url, _headers, onMessage, onClose) => {
      const index = connects.length;
      connects.push(Date.now());
      const mode = modeFor(index);
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        // Like `ws`, the close event is delivered asynchronously.
        setTimeout(() => {
          closes.push(Date.now());
          onClose();
        }, 0);
      };
      latestClose = close;
      latestMessage = onMessage;
      // Like a rejected upgrade (HTTP 401) or a delivered frame: observed after the socket object exists.
      setTimeout(() => {
        if (mode === "fail") close();
        else if (mode === "invalid") onMessage(invalidFrame);
        else if (mode === "slow_denial") onMessage(denialFrame());
        else onMessage(keepalive);
      }, 0);
      if (mode === "flap" || mode === "slow_denial") setTimeout(close, 1_000);
      if (mode === "poison") setTimeout(() => onMessage(invalidFrame), 1_000);
      return { send: (value: string) => { acks.push(JSON.parse(value) as unknown); }, close };
    },
    random: input.random,
    startTimers: true,
  });
  return {
    client, registrations, connects, closes, acks,
    dropLatest: () => latestClose?.(),
    sendLatest: (raw) => latestMessage?.(raw),
  };
}

function gaps(times: number[]): number[] {
  return times.slice(1).map((time, index) => time - times[index]!);
}

/** Delay from each delivered close to the registration attempt it triggered. */
function reconnectDelays(closes: number[], registrations: number[]): number[] {
  return closes.slice(0, registrations.length - 1).map((closedAt, index) => registrations[index + 1]! - closedAt);
}

describe("collaboration control client reconnects", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T09:00:00.000Z"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps backing off while upgrades keep failing: an opened socket object is not a healthy stream", async () => {
    const { client, registrations, closes } = harness({ streams: () => "fail", random: () => 1 });
    await client.start();
    await vi.advanceTimersByTimeAsync(260_000);
    // With jitter pinned to the top of its range the delays are the exponential base, capped at 60s.
    // Before the fix the backoff reset as soon as connect() returned, so this looped once per second.
    expect(reconnectDelays(closes, registrations).slice(0, 8)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    client.fence();
  });

  it("spreads failed reconnects with equal jitter between half the base delay and the base delay", async () => {
    const { client, registrations, closes } = harness({ streams: () => "fail", random: () => 0 });
    await client.start();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(reconnectDelays(closes, registrations).slice(0, 8)).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    client.fence();
  });

  it("resets the backoff once a frame is applied and reconnects a stream that closes after being healthy within a short jittered window", async () => {
    const { client, registrations, connects, closes, acks, dropLatest } = harness({
      streams: ["fail", "fail", "fail", "healthy", "fail", "healthy"],
      random: () => 0.5,
    });
    await client.start();
    // Three failed upgrades: 750, 1500, 3000 (base x 0.75 at random 0.5).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connects).toHaveLength(4);
    expect(reconnectDelays(closes, registrations)).toEqual([750, 1_500, 3_000]);
    // The healthy stream applied its keepalive and acknowledged it.
    expect(acks).toHaveLength(1);

    // Routine server-side rotation (close 1012) later on: reconnect in 0.5s..5s, not after the grown backoff.
    await vi.advanceTimersByTimeAsync(60_000);
    dropLatest();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(registrations).toHaveLength(6);
    expect(closes).toHaveLength(5);
    expect(registrations[4]! - closes[3]!).toBe(2_750);
    // That stream failed: the backoff starts again from its initial base because the previous stream was healthy.
    expect(registrations[5]! - closes[4]!).toBe(750);
    client.fence();
  });

  it.each([
    [0, 500],
    [1, 5_000],
  ])("bounds the healthy-stream reconnect delay to 0.5s..5s (random %s -> %sms)", async (random, expected) => {
    const { client, registrations, closes, dropLatest } = harness({ streams: ["healthy", "healthy"], random: () => random });
    await client.start();
    // Past the 30s minimum lifetime that makes a closed stream count as healthy.
    await vi.advanceTimersByTimeAsync(31_000);
    dropLatest();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(registrations).toHaveLength(2);
    expect(registrations[1]! - closes[0]!).toBe(expected);
    client.fence();
  });

  it("does not treat a stream whose first frame was refused as healthy", async () => {
    const { client, registrations, closes } = harness({ streams: ["invalid", "invalid", "invalid", "invalid"], random: () => 1 });
    await client.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconnectDelays(closes, registrations).slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
    client.fence();
  });

  it("re-registers on a self-rescheduling jittered timer that the fence clears", async () => {
    const randoms = [0, 1, 0.5];
    const { client, registrations } = harness({ streams: () => "healthy", random: () => randoms.shift() ?? 0.5 });
    await client.start();
    expect(registrations).toHaveLength(1);
    // 5 min x 0.8 = 4 min.
    await vi.advanceTimersByTimeAsync(240_000 - 1);
    expect(registrations).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(registrations).toHaveLength(2);
    // 5 min x 1.2 = 6 min.
    await vi.advanceTimersByTimeAsync(360_000 - 1);
    expect(registrations).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(registrations).toHaveLength(3);

    client.fence();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(registrations).toHaveLength(3);
  });

  it("keeps re-registering after a failed periodic registration", async () => {
    const { client, registrations } = harness({
      streams: () => "healthy",
      responses: [registrationResponse, () => new Response("busy", { status: 503 })],
      random: () => 0.5,
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(2 * 300_000);
    expect(registrations).toHaveLength(3);
    client.fence();
  });

  it("waits at least the Retry-After of a throttled periodic registration before the next one", async () => {
    const { client, registrations } = harness({
      streams: () => "healthy",
      responses: [
        registrationResponse,
        () => new Response("busy", { status: 429, headers: { "retry-after": "300" } }),
        registrationResponse,
      ],
      random: () => 0,
    });
    await client.start();
    // random 0: the periodic interval is 5 min x 0.8 = 4 min, below the 5 min the platform asked for.
    await vi.advanceTimersByTimeAsync(240_000);
    expect(registrations).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(300_000 - 1);
    expect(registrations).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(registrations).toHaveLength(3);
    client.fence();
  });

  it("honors a delta-seconds Retry-After on 429 and 503 as a one-shot floor for the next reconnect", async () => {
    const { client, registrations } = harness({
      streams: () => "healthy",
      responses: [
        () => new Response("upstream provider quota detail", { status: 429, headers: { "retry-after": "120" } }),
        () => new Response("unavailable", { status: 503, headers: { "retry-after": "7" } }),
        () => new Response("boom", { status: 500 }),
      ],
      random: () => 1,
    });
    await client.start();
    // The floor is spread by up to a fifth of itself: 120s + 24s at the top of the jitter range.
    await vi.advanceTimersByTimeAsync(143_999);
    expect(registrations).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(registrations).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(20_000);
    // 144s (spread 120s floor over the 1s base), 8.4s (spread 7s floor over the 2s base), then the plain 4s base.
    expect(gaps(registrations)).toEqual([144_000, 8_400, 4_000]);
    // The raw response body never reaches the logs.
    const logged = vi.mocked(console.warn).mock.calls.flat().map(String).join("\n");
    expect(logged).not.toContain("upstream provider quota detail");
    client.fence();
  });

  it("spreads a Retry-After floor at the bottom of the jitter range exactly onto the floor", async () => {
    const { client, registrations } = harness({
      streams: () => "healthy",
      responses: [
        () => new Response("x", { status: 429, headers: { "retry-after": "120" } }),
        () => new Response("x", { status: 503, headers: { "retry-after": "7" } }),
        () => new Response("x", { status: 500 }),
      ],
      random: () => 0,
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(200_000);
    // Floors 120s and 7s, then the 2s base at random 0 (500, 1000, 2000 are the unfloored delays).
    expect(gaps(registrations).slice(0, 3)).toEqual([120_000, 7_000, 2_000]);
    client.fence();
  });

  it("caps the Retry-After spread at the maximum backoff", async () => {
    const { client, registrations, connects } = harness({
      streams: () => "healthy",
      responses: [() => new Response("x", { status: 503, headers: { "retry-after": "999999" } })],
      random: () => 1,
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(400_000);
    // 300s clamp + min(60s, 60s) spread, measured to the reconnect's control connect.
    expect(connects[0]! - registrations[0]!).toBe(360_000);
    client.fence();
  });

  // Random 0 makes the unfloored first delay 500ms, so a header that is wrongly accepted
  // (even at the 1s minimum) produces a distinguishable delay.
  it.each([
    ["Wed, 21 Oct 2026 07:28:00 GMT", 429, 500],
    ["soon", 503, 500],
    ["-5", 429, 500],
    ["1.5", 429, 500],
    ["", 503, 500],
    ["0", 429, 1_000],
    ["30", 429, 30_000],
    ["999999", 503, 300_000],
    ["30", 500, 500],
    ["30", 403, 500],
  ])("treats Retry-After %j on HTTP %s as a %sms first delay", async (header, status, expected) => {
    const { client, registrations, connects } = harness({
      streams: () => "healthy",
      responses: [() => new Response("x", { status, headers: { "retry-after": header } })],
      random: () => 0,
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(400_000);
    // Measured to the first control connect: the periodic re-registration (4 min at random 0) registers but never connects.
    expect(connects.length).toBeGreaterThanOrEqual(1);
    expect(connects[0]! - registrations[0]!).toBe(expected);
    client.fence();
  });

  describe("parseRetryAfterMs", () => {
    it.each([
      [null, undefined],
      ["", undefined],
      ["   ", undefined],
      ["0", 1_000],
      ["1", 1_000],
      ["30", 30_000],
      [" 30 ", 30_000],
      ["300", 300_000],
      ["999999", 300_000],
      ["1.5", undefined],
      ["-5", undefined],
      ["+5", undefined],
      ["1e3", undefined],
      ["soon", undefined],
      ["12345678901", undefined],
      ["Wed, 21 Oct 2026 07:28:00 GMT", undefined],
    ])("parses %j as %s", (value, expected) => {
      expect(parseRetryAfterMs(value)).toBe(expected);
    });
  });

  it("backs off exponentially when every stream applies one frame and the platform closes it right after", async () => {
    const { client, registrations, closes } = harness({ streams: () => "flap", random: () => 1 });
    await client.start();
    await vi.advanceTimersByTimeAsync(60_000);
    // Each stream applied a keepalive but lived 1s, far short of the 30s that proves it healthy.
    // Before the fix each close was a "healthy_close" (0.5s..5s, backoff reset) forever.
    expect(reconnectDelays(closes, registrations).slice(0, 5)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    client.fence();
  });

  it("backs off exponentially when every stream applies a keepalive and then a frame the client refuses", async () => {
    const { client, registrations, closes } = harness({ streams: () => "poison", random: () => 1 });
    await client.start();
    await vi.advanceTimersByTimeAsync(60_000);
    // The client terminated each stream itself: a failure, never a healthy close.
    expect(reconnectDelays(closes, registrations).slice(0, 5)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    client.fence();
  });

  it("treats a long-lived stream the client terminates as a failure from the reset base", async () => {
    const { client, registrations, closes, sendLatest } = harness({
      streams: ["fail", "fail", "fail", "healthy", "fail", "fail"],
      random: () => 1,
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconnectDelays(closes, registrations)).toEqual([1_000, 2_000, 4_000]);
    // Healthy for well past the minimum lifetime, then a frame the client refuses.
    await vi.advanceTimersByTimeAsync(60_000);
    sendLatest(invalidFrame);
    await vi.advanceTimersByTimeAsync(10_000);
    // Proven stream resets the base, but its self-termination is a failure (1s at random 1), not the 5s healthy window.
    expect(reconnectDelays(closes, registrations).slice(3, 6)).toEqual([1_000, 2_000, 4_000]);
    client.fence();
  });

  it("does not let a frame that finishes after its stream closed reset a newer failure sequence", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { client, registrations, closes } = harness({
      streams: (index) => (index === 0 ? "slow_denial" : "fail"),
      random: () => 1,
      capabilities: { endActorGrants: () => gate },
    });
    await client.start();
    // Stream 0 closes at ~1s with its denial still applying: failure, 1s delay. Then 2s.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reconnectDelays(closes, registrations)).toEqual([1_000]);
    // The stale denial completes while the failure sequence is underway.
    release?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconnectDelays(closes, registrations).slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
    client.fence();
  });

  it("keeps an upgrade_required registration retryable", async () => {
    const { client, registrations } = harness({
      streams: () => "healthy",
      responses: [() => new Response("old", { status: 426 })],
      random: () => 1,
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(registrations).toHaveLength(2);
    client.fence();
  });
});
