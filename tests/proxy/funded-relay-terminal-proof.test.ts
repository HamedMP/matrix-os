import { describe, expect, it, vi } from "vitest";
import { boundedBody } from "../../packages/proxy/src/funded-relay-stream.js";

describe("terminal receipt waits for local stream termination", () => {
  it("does not attest termination until cancellation is acknowledged", async () => {
    let finish!: () => void; const source = new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>((resolve) => { finish = resolve; }) });
    const ambiguous = vi.fn(); const complete = vi.fn(); const release = vi.fn(); const lifetime = new AbortController();
    const body = boundedBody(source, 100, { release }, () => undefined, lifetime.signal, { push: () => undefined, complete, ambiguous });
    const pending = body.cancel("caller stopped"); await Promise.resolve();
    expect(ambiguous).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
    finish(); await pending; expect(ambiguous).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
  });
  it("fails closed when local cancellation rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ambiguous = vi.fn(); const source = new ReadableStream<Uint8Array>({ cancel: async () => { throw new Error("cancel failed"); } });
    const body = boundedBody(source, 100, { release: () => undefined }, () => undefined, new AbortController().signal,
      { push: () => undefined, complete: vi.fn(), ambiguous });
    await expect(body.cancel()).rejects.toThrow("cancel failed"); expect(ambiguous).not.toHaveBeenCalled(); vi.restoreAllMocks();
  });
});

it("fails closed on a Relay clock preceding the authoritative start without disrupting timeout handling", async () => {
  const { createRelayTerminalRecorder } = await import("../../packages/proxy/src/funded-relay-terminal-outcome.js");
  const { SettlementRetryQueue } = await import("../../packages/proxy/src/funded-relay-settlement-queue.js");
  const terminal = vi.fn(); const queue = new SettlementRetryQueue({ capacity: 1, ttlMs: 1_000, retryIntervalMs: 60_000, now: () => 0, terminal, finalize: async () => undefined });
  const recorder = createRelayTerminalRecorder({ identity: { ownerId: "owner", machineId: "machine", runtimeSlot: "primary", tokenId: "token" },
    reservationId: "reservation", requestId: "request", now: () => new Date("2026-09-10T12:00:00.000Z"), queue });
  recorder.started({ contractVersion: 1, reservationId: "reservation", requestId: "request", tokenId: "token", status: "in_flight",
    startedAt: "2026-09-10T12:00:01.000Z", expiresAt: "2026-09-10T12:10:01.000Z" });
  expect(() => recorder.unknown("failed")).not.toThrow(); expect(terminal).not.toHaveBeenCalled(); await queue.close();
});
