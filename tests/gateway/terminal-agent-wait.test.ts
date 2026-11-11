import { describe, expect, it } from "vitest";
import { createTerminalWaiter } from "../../packages/gateway/src/terminal-agent/wait.js";

const workspaceId = "tws_0123456789abcdef0123456789abcdef";
const tabId = "tt_0123456789abcdef0123456789abcdef";
const ref = { workspaceId, tabId };

type Status = "idle" | "working" | "done" | "blocked" | "error" | undefined;

function harness(script: {
  statuses?: Status[];
  tabStates?: Array<{ status: string; exitCode?: number }>;
  screens?: string[][];
  accessScope?: string;
}) {
  let now = 0;
  let step = 0;
  const at = <T>(list: T[] | undefined, fallback: T) => list?.[Math.min(step, (list?.length ?? 1) - 1)] ?? fallback;
  const waiter = createTerminalWaiter({
    runtime: {
      listWorkspaces: async () => [{
        id: workspaceId, scope: "main", canonicalSize: { cols: 80, rows: 24 }, status: "running", revision: 1,
        createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z",
        tabs: [{
          id: tabId, workspaceId, name: "t", cwd: "", revision: 1, order: 0,
          accessScope: script.accessScope ?? "owner",
          createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z",
          ...at(script.tabStates, { status: "running" }),
        }],
      }] as never,
      getSnapshot: async () => ({
        terminalRef: ref, viewport: at(script.screens, [""]), scrollback: [], updatedAt: "2026-11-11T10:00:00.000Z",
      }),
    },
    status: {
      list: async () => new Map(),
      get: async () => {
        const status = at(script.statuses, undefined);
        return status ? { ref, status, reportedAt: "2026-11-11T10:00:00.000Z", source: "reporter" as const } : undefined;
      },
    },
    now: () => now,
    sleep: async (ms) => { now += ms; step += 1; },
    pollMs: 500,
  });
  return { waiter, elapsed: () => now };
}

// Fault detected: an agent sleeps and polls a helper, or returns before the helper finished.
describe("terminal wait", () => {
  it("returns at once when the agent is already not working", async () => {
    const { waiter, elapsed } = harness({ statuses: ["done"] });
    await expect(waiter.wait(ref, {})).resolves.toEqual({ reason: "stopped", status: "done" });
    expect(elapsed()).toBe(0);
  });

  it("waits through working until the agent stops", async () => {
    const { waiter, elapsed } = harness({ statuses: ["working", "working", "blocked"] });
    await expect(waiter.wait(ref, {})).resolves.toEqual({ reason: "stopped", status: "blocked" });
    expect(elapsed()).toBe(1_000);
  });

  it("treats a program that never reports status as working until it exits", async () => {
    const { waiter } = harness({ tabStates: [{ status: "running" }, { status: "running" }, { status: "exited", exitCode: 3 }] });
    await expect(waiter.wait(ref, {})).resolves.toEqual({ reason: "exited", exitCode: 3 });
  });

  it("matches output printed after the wait starts, not output already on screen", async () => {
    const { waiter } = harness({
      statuses: ["idle"],
      screens: [["ready old"], ["ready old"], ["ready old", "ready on :3000"]],
    });
    await expect(waiter.wait(ref, { output: "ready" })).resolves.toEqual({ reason: "output" });
  });

  // Fault detected: text printed between two check-ins of one long wait counts as old.
  it("returns its output baseline on a check-in and honors it on the next request", async () => {
    const first = harness({ statuses: ["idle"], screens: [["boot"]] });
    await expect(first.waiter.wait(ref, { output: "ready", timeoutMs: 1_000 })).resolves.toEqual({ reason: "timeout", seen: 0 });
    // "ready" appeared before the next request started.
    const second = harness({ statuses: ["idle"], screens: [["boot", "ready on :3000"]] });
    await expect(second.waiter.wait(ref, { output: "ready", seen: 0, timeoutMs: 1_000 })).resolves.toEqual({ reason: "output" });
  });

  // Fault detected (second review of #3297): snapshot rows carry colour codes, so a
  // phrase printed with a colour change between words never matched.
  it("matches output as the terminal shows it, ignoring colour codes", async () => {
    const { waiter } = harness({ statuses: ["idle"], screens: [["boot"], ["boot", "\x1b[32mready\x1b[0m on :3000"]] });
    await expect(waiter.wait(ref, { output: "ready on :3000", timeoutMs: 2_000 })).resolves.toEqual({ reason: "output" });
  });

  it("times out as a check-in, not a failure", async () => {
    const { waiter, elapsed } = harness({ statuses: ["working"] });
    await expect(waiter.wait(ref, { timeoutMs: 2_000 })).resolves.toEqual({ reason: "timeout", status: "working" });
    expect(elapsed()).toBe(2_000);
  });

  it("stops promptly when the caller goes away", async () => {
    const { waiter } = harness({ statuses: ["working"] });
    const controller = new AbortController();
    controller.abort();
    await expect(waiter.wait(ref, { signal: controller.signal })).resolves.toEqual({ reason: "cancelled" });
  });

  it("bounds concurrent waiters per tab", async () => {
    const { waiter } = harness({ statuses: ["working"] });
    const pending = Array.from({ length: 16 }, () => waiter.wait(ref, { timeoutMs: 60_000 }));
    await expect(waiter.wait(ref, {})).rejects.toMatchObject({ code: "capacity" });
    waiter.shutdown();
    await expect(Promise.all(pending)).resolves.toEqual(Array(16).fill({ reason: "shutdown" }));
  });

  it("refuses tabs that are not owner terminals", async () => {
    const { waiter } = harness({ accessScope: "chat" });
    await expect(waiter.wait(ref, {})).rejects.toMatchObject({ code: "not_found" });
  });

  // Fault detected: a script sends a task and waits, but the wait returns at once
  // on the status the agent reported before it received the task.
  it("ignores a status reported before the latest send until the agent answers or a grace period passes", async () => {
    let now = 10_000;
    let reportedAt = new Date(5_000).toISOString();
    let status: "done" | "working" = "done";
    const waiter = createTerminalWaiter({
      runtime: {
        listWorkspaces: async () => [{
          id: workspaceId, scope: "main", canonicalSize: { cols: 80, rows: 24 }, status: "running", revision: 1,
          createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z",
          tabs: [{ id: tabId, workspaceId, name: "t", cwd: "", status: "running", revision: 1, order: 0, accessScope: "owner",
            createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z" }],
        }] as never,
        getSnapshot: async () => undefined,
      },
      status: {
        list: async () => new Map(),
        get: async () => ({ ref, status, reportedAt, source: "hook" as const }),
        sentAt: () => 9_000,
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        // The agent picks the task up, works, then finishes.
        if (now === 11_000) { status = "working"; reportedAt = new Date(now).toISOString(); }
        if (now === 12_000) { status = "done"; reportedAt = new Date(now).toISOString(); }
      },
      pollMs: 500,
    });
    await expect(waiter.wait(ref, { timeoutMs: 30_000 })).resolves.toEqual({ reason: "stopped", status: "done" });
    expect(now).toBe(12_000);
  });
});
