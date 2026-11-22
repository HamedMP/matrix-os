import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTerminalEventHub, type TerminalEventFrame } from "../../packages/gateway/src/terminal-agent/events.js";
import { createTerminalSeenStore } from "../../packages/gateway/src/terminal-agent/seen-store.js";

// Spec 2706 layer 4: "Done" means finished since the person last looked, and
// opening a terminal marks it seen for every window and device of that person.

const workspaceId = "tws_0123456789abcdef0123456789abcdef";
const tabA = "tt_0123456789abcdef0123456789abcdef";
const tabB = "tt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const keyA = `${workspaceId}:${tabA}`;
const keyB = `${workspaceId}:${tabB}`;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "matrix-terminal-seen-"));
  dirs.push(dir);
  return dir;
}

function tab(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, workspaceId, name: id === tabA ? "review" : "build", cwd: "projects/app", status: "running",
    revision: 1, order: 0, accessScope: "owner", createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: "2026-11-11T10:00:00.000Z", ...overrides,
  };
}

function harness(seen = createTerminalSeenStore({ path: null })) {
  let tabs: Array<Record<string, unknown>> = [tab(tabA), tab(tabB)];
  let statuses = new Map<string, { status: string; reportedAt: string }>();
  let now = Date.parse("2026-11-11T10:05:00.000Z");
  const hub = createTerminalEventHub({
    runtime: {
      listWorkspaces: async () => [{
        id: workspaceId, scope: "main", canonicalSize: { cols: 80, rows: 24 }, status: "running",
        revision: 1, createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z", tabs,
      }] as never,
    },
    status: {
      get: async () => undefined,
      list: async () => new Map([...statuses].map(([key, value]) => [key, {
        ref: { workspaceId, tabId: key.split(":")[1]! }, source: "reporter" as const, ...value,
      }])) as never,
    },
    seen,
    now: () => now,
    autoStart: false,
  });
  const frames: TerminalEventFrame[] = [];
  let subscription: ReturnType<typeof hub.subscribe> | null = null;
  return {
    hub, frames, seen,
    /** Subscribes with the data set so far and waits for the first snapshot. */
    async start() {
      subscription = hub.subscribe({ send: (frame) => { frames.push(frame); }, close: () => undefined });
      await hub.tick();
    },
    get handle() {
      if (!subscription) throw new Error("not started");
      return subscription;
    },
    setTabs: (next: Array<Record<string, unknown>>) => { tabs = next; },
    setStatus: (tabId: string, status: string, reportedAt: string) => {
      statuses = new Map(statuses);
      statuses.set(`${workspaceId}:${tabId}`, { status, reportedAt });
    },
    advance: (ms: number) => { now += ms; },
    attention: () => frames.filter((frame) => frame.type === "attention").at(-1),
  };
}

describe("terminal seen over the events stream", () => {
  it("sends which done tabs were opened since they finished, after the snapshot and on change", async () => {
    const h = harness();
    h.setTabs([tab(tabA, { status: "exited", exitCode: 4, updatedAt: "2026-11-11T10:04:00.000Z" }), tab(tabB)]);
    h.setStatus(tabB, "done", "2026-11-11T10:03:00.000Z");
    await h.start();
    expect(h.frames.map((frame) => frame.type)).toEqual(["snapshot", "attention"]);
    expect(h.attention()).toMatchObject({
      tabs: {
        [keyA]: { doneAt: "2026-11-11T10:04:00.000Z", seen: false },
        [keyB]: { doneAt: "2026-11-11T10:03:00.000Z", seen: false },
      },
    });

    expect(h.handle.markSeen({ workspaceId, tabId: tabA })).toBe(true);
    expect(h.attention()).toMatchObject({ tabs: { [keyA]: { seen: true }, [keyB]: { seen: false } } });

    // Nothing changed: no new attention frame.
    const count = h.frames.length;
    await h.hub.tick();
    expect(h.frames).toHaveLength(count);
  });

  it("files a tab as unseen again when it finishes another turn after being opened", async () => {
    const h = harness();
    h.setStatus(tabB, "done", "2026-11-11T10:03:00.000Z");
    await h.start();
    h.handle.markSeen({ workspaceId, tabId: tabB });
    expect(h.attention()).toMatchObject({ tabs: { [keyB]: { seen: true } } });
    h.advance(60_000);
    h.setStatus(tabB, "done", "2026-11-11T10:06:30.000Z");
    await h.hub.tick();
    expect(h.attention()).toMatchObject({ tabs: { [keyB]: { doneAt: "2026-11-11T10:06:30.000Z", seen: false } } });
  });

  it("refuses refs the stream does not list", async () => {
    const h = harness();
    await h.start();
    expect(h.handle.markSeen({ workspaceId, tabId: "tt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })).toBe(false);
    expect(h.seen.get("tws_0123456789abcdef0123456789abcdef:tt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBeUndefined();
  });

  it("shares seen between subscribers (other windows and devices)", async () => {
    const h = harness();
    h.setStatus(tabA, "done", "2026-11-11T10:03:00.000Z");
    const other: TerminalEventFrame[] = [];
    h.hub.subscribe({ send: (frame) => { other.push(frame); }, close: () => undefined });
    await h.start();
    h.handle.markSeen({ workspaceId, tabId: tabA });
    expect(other.filter((frame) => frame.type === "attention").at(-1)).toMatchObject({ tabs: { [keyA]: { seen: true } } });
  });
});

describe("seen while a subscriber is backed up", () => {
  it("resnapshots it with attention once it drains instead of dropping the change", async () => {
    let backlog = 0;
    const h = harness();
    h.setStatus(tabA, "done", "2026-11-11T10:03:00.000Z");
    const slow: TerminalEventFrame[] = [];
    h.hub.subscribe({ send: (frame) => { slow.push(frame); }, close: () => undefined, backlog: () => backlog });
    await h.start();
    backlog = 10 * 1024 * 1024;
    h.handle.markSeen({ workspaceId, tabId: tabA });
    expect(slow.filter((frame) => frame.type === "attention").at(-1)).toMatchObject({ tabs: { [keyA]: { seen: false } } });
    backlog = 0;
    await h.hub.tick();
    expect(slow.slice(-2).map((frame) => frame.type)).toEqual(["snapshot", "attention"]);
    expect(slow.at(-1)).toMatchObject({ tabs: { [keyA]: { seen: true } } });
  });
});

describe("terminal seen store", () => {
  it("keeps seen across a gateway restart in the owner's home", async () => {
    const home = await tempHome();
    const path = join(home, "system", "terminal-seen.json");
    const first = createTerminalSeenStore({ path, saveDelayMs: 0 });
    await first.load();
    first.mark(keyA, Date.parse("2026-11-11T10:05:00.000Z"));
    await first.close();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, tabs: { [keyA]: "2026-11-11T10:05:00.000Z" } });

    const second = createTerminalSeenStore({ path, saveDelayMs: 0 });
    await second.load();
    expect(second.get(keyA)).toBe(Date.parse("2026-11-11T10:05:00.000Z"));
    await second.close();
  });

  it("starts empty from a missing or unreadable file and skips bad entries", async () => {
    const home = await tempHome();
    const path = join(home, "terminal-seen.json");
    const missing = createTerminalSeenStore({ path });
    await missing.load();
    expect(missing.get(keyA)).toBeUndefined();

    await writeFile(path, "{not json");
    const broken = createTerminalSeenStore({ path });
    await broken.load();
    expect(broken.get(keyA)).toBeUndefined();

    await writeFile(path, JSON.stringify({ version: 1, tabs: { [keyA]: "2026-11-11T10:05:00.000Z", "../etc": "x", [keyB]: "yesterday" } }));
    const partial = createTerminalSeenStore({ path });
    await partial.load();
    expect(partial.get(keyA)).toBe(Date.parse("2026-11-11T10:05:00.000Z"));
    expect(partial.get(keyB)).toBeUndefined();
  });

  it("keeps the later time when a mark arrives before loading finishes", async () => {
    const home = await tempHome();
    const path = join(home, "terminal-seen.json");
    await writeFile(path, JSON.stringify({ version: 1, tabs: { [keyA]: "2026-11-11T10:09:00.000Z" } }));
    const store = createTerminalSeenStore({ path });
    store.mark(keyA, Date.parse("2026-11-11T10:05:00.000Z"));
    store.mark(keyB, Date.parse("2026-11-11T10:05:00.000Z"));
    await store.load();
    expect(store.get(keyA)).toBe(Date.parse("2026-11-11T10:09:00.000Z"));
    expect(store.get(keyB)).toBe(Date.parse("2026-11-11T10:05:00.000Z"));
  });

  it("is bounded, forgets closed tabs and refuses keys that are not terminal refs", () => {
    const store = createTerminalSeenStore({ path: null, maxEntries: 3 });
    for (let index = 0; index < 5; index += 1) {
      store.mark(`${workspaceId}:tt_${index.toString(16).padStart(32, "0")}`, 1_000 + index);
    }
    expect(store.size()).toBe(3);
    expect(store.get(`${workspaceId}:tt_${"0".repeat(32)}`)).toBeUndefined();
    store.retain(new Set([`${workspaceId}:tt_${"4".padStart(32, "0")}`]));
    expect(store.size()).toBe(1);
    store.mark("not-a-ref", 1);
    expect(store.size()).toBe(1);
  });
});
