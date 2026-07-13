import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrollbackStore } from "../../packages/gateway/src/shell/scrollback-store.js";
import { ShellReplayBuffer } from "../../packages/gateway/src/shell/replay-buffer.js";

const roots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "matrix-shell-scrollback-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("scrollback store", () => {
  it("appends records and recovers them after restart", async () => {
    const root = await tempRoot();
    const store = new ScrollbackStore({ homePath: root, maxBytesPerSession: 4096 });

    await store.append("main", [{ type: "output", seq: 0, data: "hello" }]);
    const restarted = new ScrollbackStore({ homePath: root, maxBytesPerSession: 4096 });

    await expect(restarted.readSince("main", 0)).resolves.toEqual([
      { type: "output", seq: 0, data: "hello" },
    ]);
  });

  it("stores seq reservations that raise latestSeq but never replay", async () => {
    const root = await tempRoot();
    const store = new ScrollbackStore({ homePath: root, maxBytesPerSession: 4096 });

    await store.append("main", [{ type: "output", seq: 3, data: "visible" }]);
    await store.append("main", [{ type: "seq-reserve", seq: 10_000 }]);

    await expect(store.latestSeq("main")).resolves.toBe(10_000);
    const replayed = await store.readSince("main", 0);
    expect(replayed).toEqual([{ type: "output", seq: 3, data: "visible" }]);
    const activity = await store.latestActivity("main");
    expect(activity.latestSeq).toBe(3);
  });

  it("returns latest activity metadata for Paper status derivation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const root = await tempRoot();
    const store = new ScrollbackStore({ homePath: root, maxBytesPerSession: 4096 });

    await store.append("main", [
      { type: "output", seq: 0, data: "$ build\n" },
      { type: "block-mark", seq: 0, mark: { code: "B", kind: "command-start" } },
    ]);
    vi.setSystemTime(new Date("2026-06-15T12:00:05.000Z"));
    await store.append("main", [
      { type: "output", seq: 1, data: "done\n" },
      { type: "block-mark", seq: 1, mark: { code: "D", kind: "command-finished", exitCode: 0 } },
    ]);

    await expect(store.latestActivity("main")).resolves.toEqual({
      latestSeq: 1,
      latestOutputAt: "2026-06-15T12:00:05.000Z",
      commandRunning: false,
      latestCommandMark: { code: "D", kind: "command-finished", exitCode: 0 },
    });
  });

  it("bounds per-session scrollback size", async () => {
    const root = await tempRoot();
    const store = new ScrollbackStore({ homePath: root, maxBytesPerSession: 180 });

    for (let i = 0; i < 10; i++) {
      await store.append("main", [{ type: "output", seq: i, data: `line-${i}` }]);
    }

    const info = await stat(store.pathForSession("main"));
    expect(info.size).toBeLessThanOrEqual(180);
    const records = await store.readSince("main", 0);
    expect(records[0]!.seq).toBeGreaterThan(0);
  });

  it("serves replay across cold scrollback and hot memory without duplicates", async () => {
    const root = await tempRoot();
    const store = new ScrollbackStore({ homePath: root, maxBytesPerSession: 4096 });
    await store.append("main", [{ type: "output", seq: 0, data: "cold" }]);
    const replay = new ShellReplayBuffer({
      maxBytes: 100,
      scrollbackStore: store,
      sessionName: "main",
    });

    await replay.writePersistent("hot");

    await expect(replay.replayFromSeq(0)).resolves.toEqual([
      { type: "replay-start", fromSeq: 0 },
      { type: "output", seq: 0, data: "cold" },
      { type: "output", seq: 1, data: "hot" },
      { type: "replay-end", toSeq: 1 },
    ]);
  });

  it("cleans up scrollback on session delete", async () => {
    const root = await tempRoot();
    const store = new ScrollbackStore({ homePath: root, maxBytesPerSession: 4096 });
    await store.append("main", [{ type: "output", seq: 0, data: "hello" }]);

    await store.cleanup("main");

    await expect(readFile(store.pathForSession("main"), "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("skips malformed scrollback records when replaying a session", async () => {
    const root = await tempRoot();
    const store = new ScrollbackStore({ homePath: root });
    const path = store.pathForSession("main");
    await mkdir(join(root, "system", "scrollback"), { recursive: true });
    await writeFile(path, [
      JSON.stringify({ type: "output", seq: 1, data: "one" }),
      "{\"type\":\"output\",\"seq\":",
      JSON.stringify({ type: "output", seq: 3, data: "three" }),
      "",
    ].join("\n"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(store.readSince("main", 0)).resolves.toEqual([
      { type: "output", seq: 1, data: "one" },
      { type: "output", seq: 3, data: "three" },
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[shell] skipped malformed scrollback records:",
      expect.objectContaining({ session: "main", count: 1 }),
    );
  });

  it("uses the newest valid sequence when the scrollback tail is malformed", async () => {
    const root = await tempRoot();
    const store = new ScrollbackStore({ homePath: root });
    const path = store.pathForSession("main");
    await mkdir(join(root, "system", "scrollback"), { recursive: true });
    await writeFile(path, [
      JSON.stringify({ type: "output", seq: 8, data: "ready" }),
      "{\"type\":\"output\",\"seq\":",
      "",
    ].join("\n"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(store.latestSeq("main")).resolves.toBe(8);
    expect(warn).toHaveBeenCalledWith(
      "[shell] skipped malformed scrollback records:",
      expect.objectContaining({ session: "main", count: 1 }),
    );
  });
});
