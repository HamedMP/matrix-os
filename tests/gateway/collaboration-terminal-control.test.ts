import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CollaborationTerminalControlError,
  TerminalControlCoordinator,
} from "../../packages/gateway/src/collaboration/terminal-control.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const terminalId = "terminal_release";
const incarnation = "terminal-incarnation-7";

function holder(actorId: string, role: "owner" | "editor", connectionId: string) {
  return { scopeId, terminalId, incarnation, actorId, role, connectionId };
}

describe("TerminalControlCoordinator", () => {
  afterEach(() => vi.useRealTimers());

  it("selects at most one controller from simultaneous editor acquisitions", async () => {
    const coordinator = new TerminalControlCoordinator({ startTimer: false });
    const results = await Promise.allSettled([
      coordinator.acquire(holder("user_editor_a", "editor", "connection_a")),
      coordinator.acquire(holder("user_editor_b", "editor", "connection_b")),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(coordinator.current(scopeId, terminalId, incarnation)).toMatchObject({
      actorId: expect.stringMatching(/^user_editor_[ab]$/),
      epoch: 1,
    });
    coordinator.close();
  });

  it("makes editors wait for release or expiry while an owner can take over", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
    const coordinator = new TerminalControlCoordinator({
      now: () => new Date(Date.now()),
      leaseMs: 30_000,
      startTimer: false,
    });
    const editorA = holder("user_editor_a", "editor", "connection_a");
    const editorB = holder("user_editor_b", "editor", "connection_b");
    const owner = holder("user_owner", "owner", "connection_owner");
    const first = await coordinator.acquire(editorA);

    await expect(coordinator.acquire(editorB)).rejects.toMatchObject({ code: "held" });
    const takeover = await coordinator.takeover(owner);
    expect(takeover).toMatchObject({ actorId: "user_owner", epoch: first.epoch + 1 });
    await expect(coordinator.assertHeld({ ...editorA, epoch: first.epoch })).rejects.toMatchObject({
      code: "stale_lease",
    });

    await coordinator.release({ ...owner, epoch: takeover.epoch });
    const second = await coordinator.acquire(editorB);
    vi.advanceTimersByTime(30_001);
    const reacquired = await coordinator.acquire(editorA);
    expect(reacquired.epoch).toBeGreaterThan(second.epoch);
    coordinator.close();
  });

  it("fences delayed input by lease epoch, connection, incarnation, downgrade, and revoke", async () => {
    const coordinator = new TerminalControlCoordinator({ startTimer: false });
    const editor = holder("user_editor", "editor", "connection_editor");
    const lease = await coordinator.acquire(editor);

    await expect(coordinator.assertHeld({ ...editor, epoch: lease.epoch + 1 })).rejects.toMatchObject({
      code: "stale_lease",
    });
    await expect(coordinator.assertHeld({
      ...editor,
      connectionId: "connection_reconnected",
      epoch: lease.epoch,
    })).rejects.toMatchObject({ code: "stale_lease" });
    await expect(coordinator.assertHeld({
      ...editor,
      incarnation: "terminal-replacement",
      epoch: lease.epoch,
    })).rejects.toBeInstanceOf(CollaborationTerminalControlError);

    coordinator.invalidateActor(scopeId, "user_editor");
    await expect(coordinator.assertHeld({ ...editor, epoch: lease.epoch })).rejects.toMatchObject({
      code: "stale_lease",
    });
    expect(coordinator.current(scopeId, terminalId, incarnation)).toBeNull();
    coordinator.close();
  });

  it("expires disconnected controllers, bounds tracked sessions, and drains on shutdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
    const changed = vi.fn();
    const coordinator = new TerminalControlCoordinator({
      now: () => new Date(Date.now()),
      leaseMs: 30_000,
      maxSessions: 2,
      startTimer: false,
      onChanged: changed,
    });
    const first = await coordinator.acquire(holder("user_editor_a", "editor", "connection_a"));
    coordinator.markDisconnected(scopeId, "connection_a");
    expect(coordinator.current(scopeId, terminalId, incarnation)).toMatchObject({ epoch: first.epoch });
    vi.advanceTimersByTime(30_001);
    expect(coordinator.sweep()).toBe(1);
    expect(coordinator.current(scopeId, terminalId, incarnation)).toBeNull();

    await coordinator.acquire({
      ...holder("user_editor_b", "editor", "connection_b"),
      terminalId: "terminal_two",
      incarnation: "incarnation-two",
    });
    await coordinator.acquire({
      ...holder("user_editor_c", "editor", "connection_c"),
      terminalId: "terminal_three",
      incarnation: "incarnation-three",
    });
    await expect(coordinator.acquire({
      ...holder("user_editor_d", "editor", "connection_d"),
      terminalId: "terminal_four",
      incarnation: "incarnation-four",
    })).rejects.toMatchObject({ code: "capacity" });

    coordinator.close();
    expect(coordinator.size).toBe(0);
    await expect(coordinator.acquire(holder("user_editor", "editor", "connection_new")))
      .rejects.toMatchObject({ code: "closed" });
    expect(changed).toHaveBeenCalled();
  });
});
