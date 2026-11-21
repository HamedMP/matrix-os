import { describe, expect, it, vi } from "vitest";
import { createRelayTimingLogger } from "../../packages/platform/src/collaboration/relay-timing-log.js";
import type { RelayMetadata } from "../../packages/platform/src/collaboration/relay.js";

// Outcome: preview and production logs show per-hop owner-VPS timing for
// shared-app opens without leaking who opened what.
// Faults: actor ids, raw paths or resource ids reaching logs; unbounded log
// volume during an asset burst; a logging failure breaking the relay.

const entry: RelayMetadata = {
  actorId: "user_secret_actor",
  runtimeId: "vps-11111111-1111-4111-8111-111111111111",
  resourceId: "10000000-0000-4000-8000-000000000001",
  routeKind: "scope",
  method: "GET",
  path: "/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/apps/sales-crm/assets/index.js",
  requestBytes: 0,
  responseBytes: 2048,
  status: 200,
  durationMs: 812,
  upstreamHeadersMs: 640,
  outcome: "forwarded",
};

describe("relay timing log", () => {
  it("emits one structured line with timing and coarse route data only", () => {
    const log = vi.fn();
    createRelayTimingLogger({ log, now: () => 0 })(entry);
    expect(log).toHaveBeenCalledTimes(1);
    const [prefix, payload] = log.mock.calls[0]!;
    expect(prefix).toBe("[collaboration-relay] timing");
    expect(JSON.parse(payload as string)).toEqual({
      route: "scope", asset: true, method: "GET", status: 200, outcome: "forwarded",
      durationMs: 812, upstreamHeadersMs: 640, requestBytes: 0, responseBytes: 2048,
      runtimeId: entry.runtimeId,
    });
    expect(payload).not.toContain("user_secret_actor");
    expect(payload).not.toContain("10000000-0000-4000-8000-000000000001");
    expect(payload).not.toContain("sales-crm");
  });

  it("bounds log volume per second and reports how many lines it dropped", () => {
    const log = vi.fn();
    let clock = 0;
    const record = createRelayTimingLogger({ log, now: () => clock, maxLinesPerSecond: 2 });
    for (let index = 0; index < 5; index++) record(entry);
    expect(log).toHaveBeenCalledTimes(2);
    clock = 1_000;
    record(entry);
    expect(log).toHaveBeenCalledTimes(3);
    expect(JSON.parse(log.mock.calls[2]![1] as string)).toMatchObject({ droppedSinceLast: 3 });
  });

  it("clamps unexpected values instead of logging them verbatim", () => {
    const log = vi.fn();
    createRelayTimingLogger({ log, now: () => 0 })({ ...entry, method: "X".repeat(64), runtimeId: "bad id with spaces", durationMs: -5 });
    const payload = JSON.parse(log.mock.calls[0]![1] as string);
    expect(payload.method).toBe("OTHER");
    expect(payload.runtimeId).toBeNull();
    expect(payload.durationMs).toBe(0);
  });
});
