import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScrollbackStore } from "../../packages/gateway/src/shell/scrollback-store.js";
import { ShellReplayBuffer } from "../../packages/gateway/src/shell/replay-buffer.js";

const roots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "matrix-shell-scrollback-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
});
