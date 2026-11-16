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
  captures?: Array<{ viewport: string[]; scrollback: string[] }>;
  accessScope?: string;
}) {
  let now = 0;
  let step = 0;
  const at = <T>(list: T[] | undefined, fallback: T) => list?.[Math.min(step, (list?.length ?? 1) - 1)] ?? fallback;
  const captureLines: number[] = [];
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
      ...(script.captures ? {
        captureScreen: async (_ref: unknown, lines: number) => { captureLines.push(lines); return at(script.captures, undefined); },
      } : {}),
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
  return { waiter, elapsed: () => now, captureLines };
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

  // Fault detected: zellij stops updating the snapshot of a tab nobody views, so a wait
  // for a background helper's output timed out although the text was on its screen.
  it("matches output on the live screen when the snapshot is frozen", async () => {
    const { waiter, captureLines } = harness({
      statuses: ["idle"],
      screens: [["boot"]],
      captures: [
        { viewport: ["boot"], scrollback: [] },
        { viewport: ["boot"], scrollback: [] },
        { viewport: ["boot", "ready on :3000"], scrollback: [] },
      ],
    });
    await expect(waiter.wait(ref, { output: "ready", timeoutMs: 5_000 })).resolves.toEqual({ reason: "output" });
    // A bounded window of history, never the whole scrollback on every poll.
    expect(new Set(captureLines)).toEqual(new Set([2_000]));
  });

  // Fault detected (review of #3297): each read holds only the latest history lines, so
  // when an old match scrolled out before a new one printed, the count never rose above
  // the starting count and the wait timed out with the text on screen.
  it("still sees a new match after an old one scrolled out of the read window", async () => {
    const { waiter } = harness({
      statuses: ["idle"],
      screens: [["ready old", "boot"], ["boot", "more"], ["boot", "more", "ready new"]],
    });
    await expect(waiter.wait(ref, { output: "ready", timeoutMs: 5_000 })).resolves.toEqual({ reason: "output" });
  });

  it("reports the lowered baseline on a check-in after matches scrolled out", async () => {
    const { waiter } = harness({ statuses: ["idle"], screens: [["ready old"], ["boot"]] });
    await expect(waiter.wait(ref, { output: "ready", timeoutMs: 1_000 })).resolves.toEqual({ reason: "timeout", seen: 0 });
  });

  // Fault detected (review of #3297): one failed live capture fell back to an older
  // snapshot without the match, which lowered the baseline; when capture recovered the
  // same old text looked new and the wait returned before anything was printed.
  it("does not count old text as new when a read falls back to the snapshot and back", async () => {
    const { waiter } = harness({
      statuses: ["idle"],
      screens: [["boot"]],
      captures: [
        { viewport: ["ready old"], scrollback: [] },
        null as never,
        { viewport: ["ready old"], scrollback: [] },
        { viewport: ["ready old"], scrollback: [] },
      ],
    });
    await expect(waiter.wait(ref, { output: "ready", timeoutMs: 2_000 })).resolves.toMatchObject({ reason: "timeout" });
  });

  // Fault detected (review of #3297): a message printed while the live capture was
  // failing became part of the recovered read's new baseline, so the wait missed it.
  it("sees a message printed while the live capture was failing once it recovers", async () => {
    const { waiter } = harness({
      statuses: ["idle"],
      screens: [["boot"]],
      captures: [
        { viewport: ["boot"], scrollback: [] },
        null as never,
        { viewport: ["boot", "ready on :3000"], scrollback: [] },
      ],
    });
    await expect(waiter.wait(ref, { output: "ready", timeoutMs: 5_000 })).resolves.toEqual({ reason: "output" });
  });

  // Fault detected (review of #3297): one failed first capture switched the whole
  // request to the frozen snapshot, so the wait timed out after capture recovered.
  it("keeps reading live after a failed first capture", async () => {
    const { waiter } = harness({
      statuses: ["idle"],
      screens: [["boot"]],
      captures: [
        null as never,
        { viewport: ["boot"], scrollback: [] },
        { viewport: ["boot", "ready on :3000"], scrollback: [] },
      ],
    });
    await expect(waiter.wait(ref, { output: "ready", timeoutMs: 5_000 })).resolves.toEqual({ reason: "output" });
  });

  // Fault detected (review of #3297): three failed captures switched the request to the
  // frozen snapshot for good, so a message printed after capture recovered was missed.
  it("goes back to the live screen when capture recovers after several failures", async () => {
    const { waiter } = harness({
      statuses: ["idle"],
      screens: [["boot"]],
      captures: [
        null as never, null as never, null as never, null as never,
        { viewport: ["boot"], scrollback: [] },
        { viewport: ["boot", "ready on :3000"], scrollback: [] },
      ],
    });
    await expect(waiter.wait(ref, { output: "ready", timeoutMs: 10_000 })).resolves.toEqual({ reason: "output" });
  });

  // Fault detected: a runtime that cannot capture at all (older than the gateway) made
  // every output wait time out instead of using the snapshot.
  it("uses the snapshot when the runtime never captures", async () => {
    const { waiter } = harness({
      statuses: ["idle"],
      screens: [["boot"], ["boot"], ["boot"], ["boot"], ["boot"], ["boot", "ready"]],
      captures: [null as never],
    });
    await expect(waiter.wait(ref, { output: "ready", timeoutMs: 10_000 })).resolves.toEqual({ reason: "output" });
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

  // Fault detected (review of #3297): a slow screen capture held the wait past its
  // deadline, so a short wait turned into a client request error instead of a check-in.
  function hangingCaptureWaiter() {
    return createTerminalWaiter({
      runtime: {
        listWorkspaces: async () => [{
          id: workspaceId, scope: "main", canonicalSize: { cols: 80, rows: 24 }, status: "running", revision: 1,
          createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z",
          tabs: [{
            id: tabId, workspaceId, name: "t", cwd: "", revision: 1, order: 0, accessScope: "owner", status: "running",
            createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z",
          }],
        }] as never,
        getSnapshot: async () => undefined,
        captureScreen: () => new Promise(() => undefined),
      },
      status: { list: async () => new Map(), get: async () => undefined },
    });
  }

  it("returns a timeout check-in on time when a screen capture hangs", async () => {
    const started = Date.now();
    await expect(hangingCaptureWaiter().wait(ref, { output: "ready", timeoutMs: 100 }))
      .resolves.toEqual({ reason: "timeout", seen: 0 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stops waiting for a hanging capture when the caller goes away", async () => {
    const controller = new AbortController();
    const pending = hangingCaptureWaiter().wait(ref, { output: "ready", timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).resolves.toEqual({ reason: "cancelled" });
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
});
