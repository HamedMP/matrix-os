import { describe, expect, it, vi } from "vitest";
import { createDirectStreams } from "../../packages/ui/src/collaboration/direct-streams";

const scopeId = "10000000-0000-4000-8000-000000000001";

/**
 * A refresh replaces the transcript, so output that arrives while the refresh handler is
 * still settling must wait for it. Delivering it immediately appends the daemon's replayed
 * snapshot to the transcript the refresh is about to clear, which is the duplicated-history
 * failure this ordering exists to prevent.
 */
describe("shared terminal refresh ordering", () => {
  function harness() {
    const sockets: Array<Record<string, unknown>> = [];
    const streams = createDirectStreams({
      ensure: vi.fn(async () => ({
        session: { id: "session_1", expiresAt: new Date(Date.now() + 60_000).toISOString() },
        origin: "https://home.test",
      })) as never,
      issueTicket: vi.fn(async () => ({
        signedTicket: { ticket: { protocolVersion: 2 }, keyId: "k", signature: "s" },
        origin: "https://home.test",
      })) as never,
      webSocketFactory: (() => {
        const socket: Record<string, unknown> = {
          close: vi.fn(), send: vi.fn(), bufferedAmount: 0,
          onopen: null, onmessage: null, onclose: null, onerror: null,
        };
        sockets.push(socket);
        return socket as unknown as WebSocket;
      }) as never,
    });
    return { streams, sockets };
  }

  it("delivers output queued behind a refresh only after the refresh settles", async () => {
    const { streams, sockets } = harness();
    const order: string[] = [];
    let releaseRefresh: (() => void) | undefined;

    const stop = streams.subscribeTerminal(scopeId, {
      onReady: vi.fn(),
      onState: vi.fn(),
      onUnavailable: vi.fn(),
      onOutput: (frame: { sequence: string }) => { order.push(`output:${frame.sequence}`); },
      onRefreshRequired: () => new Promise<void>((resolve) => {
        order.push("refresh:start");
        releaseRefresh = () => { order.push("refresh:end"); resolve(); };
      }),
    } as never);

    await vi.waitFor(() => { expect(sockets.length).toBeGreaterThan(0); });
    const socket = sockets[0]!;
    const base = { version: 1, scopeId, resourceId: "term_1", authorityGeneration: "1", incarnation: "inc_1" };
    const deliver = (frame: unknown) => {
      (socket.onmessage as (event: { data: string }) => void)({ data: JSON.stringify(frame) });
    };

    deliver({ ...base, type: "terminal.refresh_required", sequence: "5" });
    deliver({ ...base, type: "terminal.output", sequence: "6", data: "aGk=" });

    // The refresh has not resolved, so the snapshot output must not have been delivered yet.
    await Promise.resolve();
    expect(order).toEqual(["refresh:start"]);

    releaseRefresh?.();
    await vi.waitFor(() => { expect(order).toContain("output:6"); });
    expect(order).toEqual(["refresh:start", "refresh:end", "output:6"]);

    stop();
  });
});
