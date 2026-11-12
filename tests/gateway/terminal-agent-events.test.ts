import { describe, expect, it } from "vitest";
import { createTerminalEventHub, type TerminalEventFrame } from "../../packages/gateway/src/terminal-agent/events.js";

const workspaceId = "tws_0123456789abcdef0123456789abcdef";
const tabA = "tt_0123456789abcdef0123456789abcdef";
const tabB = "tt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function tab(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, workspaceId, name: id === tabA ? "review" : "build", cwd: "projects/app", status: "running",
    revision: 1, order: 0, accessScope: "owner", createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: "2026-11-11T10:00:00.000Z", ...overrides,
  };
}

function harness() {
  let tabs: Array<Record<string, unknown>> = [tab(tabA)];
  let statuses = new Map<string, { status: string; message?: string }>();
  let now = 0;
  const hub = createTerminalEventHub({
    runtime: {
      listWorkspaces: async () => [{
        id: workspaceId, scope: "project", projectId: "app", canonicalSize: { cols: 80, rows: 24 }, status: "running",
        revision: 1, createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z", tabs,
      }] as never,
    },
    status: {
      get: async () => undefined,
      list: async () => new Map([...statuses].map(([key, value]) => [key, {
        ref: { workspaceId, tabId: key.split(":")[1]! }, reportedAt: "2026-11-11T10:00:01.000Z", source: "reporter" as const,
        ...value,
      }])) as never,
    },
    now: () => now,
    autoStart: false,
  });
  const subscriber = (options: { backlog?: () => number } = {}) => {
    const frames: TerminalEventFrame[] = [];
    let closed = false;
    const handle = hub.subscribe({
      send: (frame) => { frames.push(frame); },
      close: () => { closed = true; },
      ...(options.backlog ? { backlog: options.backlog } : {}),
    });
    return { frames, handle, isClosed: () => closed };
  };
  return {
    hub, subscriber,
    setTabs: (next: Array<Record<string, unknown>>) => { tabs = next; },
    setStatus: (tabId: string, status: string, message?: string) => {
      statuses = new Map(statuses);
      statuses.set(`${workspaceId}:${tabId}`, { status, ...(message ? { message } : {}) });
    },
    advance: (ms: number) => { now += ms; },
  };
}

// Fault detected: clients poll for terminal changes, or miss a status change
// (the "needs you" signal) between polls.
describe("terminal event hub", () => {
  it("sends a snapshot first, then ordered facts as they change", async () => {
    const h = harness();
    const sub = h.subscriber();
    await h.hub.tick();
    expect(sub.frames[0]).toMatchObject({
      type: "snapshot",
      tabs: [{ ref: { workspaceId, tabId: tabA }, name: "review", state: "live", projectId: "app" }],
    });

    h.setStatus(tabA, "working");
    h.setTabs([tab(tabA), tab(tabB)]);
    await h.hub.tick();
    h.setStatus(tabA, "blocked", "Allow edit?");
    h.setTabs([tab(tabA, { name: "review 2" }), tab(tabB, { status: "exited", exitCode: 1 })]);
    await h.hub.tick();
    h.setTabs([tab(tabA, { name: "review 2" })]);
    await h.hub.tick();

    const events = sub.frames.filter((frame) => frame.type === "event").map((frame) => frame.type === "event" ? frame.event : null);
    expect(events).toEqual([
      { kind: "status", ref: { workspaceId, tabId: tabA }, status: "working" },
      expect.objectContaining({ kind: "created", ref: { workspaceId, tabId: tabB } }),
      { kind: "title", ref: { workspaceId, tabId: tabA }, name: "review 2" },
      { kind: "status", ref: { workspaceId, tabId: tabA }, status: "blocked", message: "Allow edit?" },
      { kind: "finished", ref: { workspaceId, tabId: tabB }, exitCode: 1 },
      { kind: "removed", ref: { workspaceId, tabId: tabB } },
    ]);
    const seqs = sub.frames.map((frame) => frame.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
  });

  it("leaves Chat-bound tabs out of the stream", async () => {
    const h = harness();
    h.setTabs([tab(tabA), tab(tabB, { accessScope: "chat" })]);
    const sub = h.subscriber();
    await h.hub.tick();
    expect(sub.frames[0]).toMatchObject({ type: "snapshot", tabs: [expect.objectContaining({ ref: { workspaceId, tabId: tabA } })] });
    expect(JSON.stringify(sub.frames)).not.toContain(tabB);
  });

  it("tells a backed-up subscriber it missed events, then resnapshots", async () => {
    const h = harness();
    let backlog = 0;
    const sub = h.subscriber({ backlog: () => backlog });
    await h.hub.tick();
    backlog = 10 * 1024 * 1024;
    h.setStatus(tabA, "working");
    await h.hub.tick();
    backlog = 0;
    await h.hub.tick();
    expect(sub.frames.map((frame) => frame.type)).toEqual(["snapshot", "missed", "snapshot"]);
    expect(sub.frames[2]).toMatchObject({ tabs: [expect.objectContaining({ agentStatus: "working" })] });
  });

  it("isolates a failing subscriber and evicts it", async () => {
    const h = harness();
    const healthy = h.subscriber();
    const broken = h.hub.subscribe({ send: () => { throw new Error("socket gone"); }, close: () => undefined });
    await h.hub.tick();
    expect(healthy.frames).toHaveLength(1);
    expect(h.hub.size()).toBe(1);
    void broken;
  });

  it("evicts subscribers that stopped answering and drains on shutdown", async () => {
    const h = harness();
    const stale = h.subscriber();
    const live = h.subscriber();
    await h.hub.tick();
    h.advance(61_000);
    live.handle.touch();
    await h.hub.tick();
    expect(stale.isClosed()).toBe(true);
    expect(live.isClosed()).toBe(false);
    h.hub.shutdown();
    expect(live.frames.at(-1)).toMatchObject({ type: "shutdown" });
    expect(live.isClosed()).toBe(true);
    expect(() => h.subscriber()).toThrow();
  });

  // Fault detected (fourth review of #3299): a long terminal history made the snapshot
  // too large for the client, which then lost every live badge.
  it("keeps every live tab and bounds finished history in the stream", async () => {
    const h = harness();
    const finished = Array.from({ length: 1_500 }, (_, i) => tab(`tt_${i.toString(16).padStart(32, "0")}`, { status: "exited", exitCode: 0 }));
    h.setTabs([...finished, tab(tabA)]);
    h.setStatus(tabA, "blocked");
    const sub = h.subscriber();
    await h.hub.tick();
    const snapshot = sub.frames[0];
    expect(snapshot?.type).toBe("snapshot");
    const tabs = snapshot?.type === "snapshot" ? snapshot.tabs : [];
    expect(tabs.length).toBeLessThanOrEqual(1_024);
    expect(tabs).toContainEqual(expect.objectContaining({ ref: { workspaceId, tabId: tabA }, agentStatus: "blocked" }));
  });

  // Fault detected (fifth review of #3297): live tabs past the cap vanished, and a tab
  // that exited behind a long history lost its exit code.
  it("keeps all live tabs and reports exits even behind a long finished history", async () => {
    const h = harness();
    const finished = Array.from({ length: 1_100 }, (_, i) => tab(`tt_${i.toString(16).padStart(32, "0")}`, { status: "exited", exitCode: 0 }));
    const live = Array.from({ length: 1_100 }, (_, i) => tab(`tt_${(i + 5_000).toString(16).padStart(32, "0")}`));
    h.setTabs([...finished, ...live]);
    const sub = h.subscriber();
    await h.hub.tick();
    const snapshot = sub.frames[0]?.type === "snapshot" ? sub.frames[0].tabs : [];
    expect(snapshot.filter((entry) => entry.state === "live")).toHaveLength(1_100);
    const exiting = live[0]!.id as string;
    h.setTabs([...finished, tab(exiting, { status: "exited", exitCode: 7 }), ...live.slice(1)]);
    await h.hub.tick();
    const events = sub.frames.flatMap((frame) => frame.type === "event" ? [frame.event] : []);
    expect(events).toContainEqual({ kind: "finished", ref: { workspaceId, tabId: exiting }, exitCode: 7 });
  });

  it("caps subscribers", () => {
    const h = harness();
    for (let index = 0; index < 64; index += 1) h.subscriber();
    expect(() => h.subscriber()).toThrow(/capacity/);
  });
});
