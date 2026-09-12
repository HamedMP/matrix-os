import { describe, expect, it, vi } from "vitest";
import { CollaborationTerminalEventRegistry } from "../../packages/gateway/src/collaboration/terminal-events.js";

const scopeA = "10000000-0000-4000-8000-000000000001";
const scopeB = "10000000-0000-4000-8000-000000000002";
const incarnation = `terminal-${"a".repeat(32)}`;

describe("CollaborationTerminalEventRegistry", () => {
  it("delivers ordered scope-only output and bounded replay", async () => {
    const fixture = setup({ maxReplayBytes: 9 });
    const alice = socket();
    const other = socket();
    const first = await fixture.registry.open(connection(scopeA, "user_alice", "alice", alice));
    await fixture.registry.open(connection(scopeB, "user_other", "other", other));

    await fixture.registry.publishOutput(scopeA, incarnation, "one");
    await fixture.registry.publishOutput(scopeA, incarnation, "two");
    await fixture.registry.publishOutput(scopeA, incarnation, "three");
    expect(frames(alice).filter((frame) => frame.type === "terminal.output").map((frame) => frame.data))
      .toEqual(["one", "two", "three"]);
    expect(frames(other).some((frame) => frame.type === "terminal.output")).toBe(false);
    first.close();

    const replay = socket();
    await fixture.registry.open(connection(scopeA, "user_alice", "replay", replay, 0));
    expect(frames(replay).map((frame) => frame.type)).toContain("terminal.refresh_required");
    fixture.registry.shutdown();
  });

  it("enforces global, scope, and actor caps and evicts slow or stale sockets", async () => {
    const fixture = setup({ maxConnections: 3, maxScopeConnections: 2, maxActorScopeConnections: 1 });
    const first = socket();
    await fixture.registry.open(connection(scopeA, "user_alice", "first", first));
    await expect(fixture.registry.open(connection(scopeA, "user_alice", "duplicate", socket())))
      .rejects.toMatchObject({ code: "capacity" });
    const slow = socket(2 * 1024 * 1024);
    await fixture.registry.open(connection(scopeA, "user_bob", "slow", slow));
    await fixture.registry.publishOutput(scopeA, incarnation, "blocked");
    expect(slow.close).toHaveBeenCalled();
    expect(fixture.registry.connectionCount).toBe(1);

    fixture.now = new Date("2026-09-11T12:01:00.000Z");
    fixture.registry.sweep(fixture.now);
    expect(first.close).toHaveBeenCalled();
    expect(fixture.registry.connectionCount).toBe(0);
    fixture.registry.shutdown();
  });

  it("reauthorizes live delivery and closes revoked members without affecting others", async () => {
    const fixture = setup();
    const revoked = socket();
    const current = socket();
    await fixture.registry.open(connection(scopeA, "user_revoked", "revoked", revoked));
    await fixture.registry.open(connection(scopeA, "user_current", "current", current));
    fixture.revoked.add("user_revoked");

    await fixture.registry.publishOutput(scopeA, incarnation, "safe");
    expect(frames(revoked).some((frame) => frame.type === "terminal.output")).toBe(false);
    expect(revoked.close).toHaveBeenCalled();
    expect(frames(current).filter((frame) => frame.type === "terminal.output")).toHaveLength(1);
    fixture.registry.shutdown();
  });

  it("reports exit, refuses a changed incarnation, and drains on shutdown", async () => {
    const fixture = setup();
    const client = socket();
    await fixture.registry.open(connection(scopeA, "user_alice", "alice", client));
    await fixture.registry.publishExit(scopeA, incarnation);
    expect(frames(client)).toContainEqual(expect.objectContaining({
      type: "terminal.unavailable",
      code: "exited",
    }));

    await expect(fixture.registry.publishOutput(scopeA, `terminal-${"b".repeat(32)}`, "wrong"))
      .rejects.toMatchObject({ code: "unavailable" });
    fixture.registry.shutdown();
    expect(client.close).toHaveBeenCalled();
    await expect(fixture.registry.open(connection(scopeA, "user_alice", "late", socket())))
      .rejects.toMatchObject({ code: "unavailable" });
  });
});

function setup(limits: {
  maxReplayBytes?: number;
  maxConnections?: number;
  maxScopeConnections?: number;
  maxActorScopeConnections?: number;
} = {}) {
  const fixture = {
    now: new Date("2026-09-11T12:00:00.000Z"),
    revoked: new Set<string>(),
    registry: undefined as unknown as CollaborationTerminalEventRegistry,
  };
  fixture.registry = new CollaborationTerminalEventRegistry({
    now: () => fixture.now,
    startTimers: false,
    ...limits,
    authorize: async (scopeId, actorId) => {
      if (fixture.revoked.has(actorId)) throw new Error("revoked");
      return {
        actorId,
        ownerId: "user_owner",
        scopeId,
        membershipScopeId: scopeId,
        resourceKind: "terminal" as const,
        resourceId: scopeId === scopeA ? "terminal_a" : "terminal_b",
        role: "editor" as const,
        authEpoch: 1,
        authorityRuntimeId: "runtime_owner",
        authorityGeneration: 1,
        capability: "read" as const,
      };
    },
    getTerminal: async (scopeId, terminalId) => ({
      scopeId,
      terminalId,
      incarnation,
      executionGeneration: 4,
      creatorActorId: "user_owner",
      createdAt: "2026-09-11T11:00:00.000Z",
      status: "active" as const,
    }),
    projectTerminal: async (metadata) => ({
      id: metadata.terminalId,
      scopeId: metadata.scopeId,
      incarnation: metadata.incarnation,
      executionGeneration: String(metadata.executionGeneration),
      status: metadata.status,
      createdBy: { actorId: metadata.creatorActorId, displayName: "Owner" },
      createdAt: metadata.createdAt,
    }),
  });
  return fixture;
}

function connection(
  scopeId: string,
  actorId: string,
  connectionId: string,
  target: ReturnType<typeof socket>,
  afterSequence = 0,
) {
  return { scopeId, actorId, connectionId, authorityGeneration: 1, afterSequence, socket: target };
}

function socket(bufferedAmount = 0) {
  return { bufferedAmount, send: vi.fn(), close: vi.fn() };
}

function frames(target: ReturnType<typeof socket>): Array<Record<string, unknown>> {
  return target.send.mock.calls.map(([value]) => JSON.parse(value as string) as Record<string, unknown>);
}
