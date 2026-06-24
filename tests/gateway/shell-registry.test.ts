import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellRegistry } from "../../packages/gateway/src/shell/registry.js";

const roots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "matrix-shell-registry-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shell registry", () => {
  it("lists main first, then active sessions by creation time when no custom order exists", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        sessions: {
          bench: { name: "bench", status: "active", createdAt: "2026-06-15T12:00:02.000Z", updatedAt: "x", attachedClients: 0, tabs: [] },
          main: { name: "main", status: "active", createdAt: "2026-06-15T12:00:03.000Z", updatedAt: "x", attachedClients: 0, tabs: [] },
          docs: { name: "docs", status: "active", createdAt: "2026-06-15T12:00:01.000Z", updatedAt: "x", attachedClients: 0, tabs: [] },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => ["bench", "main", "docs"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.list()).resolves.toMatchObject([
      { name: "main" },
      { name: "docs" },
      { name: "bench" },
    ]);
  });

  it("persists custom order and respects it after reload", async () => {
    const root = await tempRoot();
    const live = new Set(["main", "bench", "docs"]);
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await registry.list();
    await expect(registry.reorder(["docs", "main"])).resolves.toMatchObject([
      { name: "docs" },
      { name: "main" },
      { name: "bench" },
    ]);

    const reloaded = new ShellRegistry({ homePath: root, adapter });
    await expect(reloaded.list()).resolves.toMatchObject([
      { name: "docs" },
      { name: "main" },
      { name: "bench" },
    ]);
    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    expect(JSON.parse(raw).order).toEqual(["docs", "main", "bench"]);
  });

  it("prunes deleted sessions from persisted custom order", async () => {
    const root = await tempRoot();
    const live = new Set(["main", "bench", "docs"]);
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async (name: string) => {
        live.delete(name);
      }),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await registry.list();
    await registry.reorder(["docs", "bench", "main"]);
    await registry.delete("bench");

    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    expect(JSON.parse(raw).order).toEqual(["docs", "main"]);
  });

  it("ignores stale custom order entries and appends new live sessions deterministically", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        order: ["ghost", "docs"],
        sessions: {
          docs: { name: "docs", status: "active", createdAt: "2026-06-15T12:00:04.000Z", updatedAt: "x", attachedClients: 0, tabs: [] },
          bench: { name: "bench", status: "active", createdAt: "2026-06-15T12:00:02.000Z", updatedAt: "x", attachedClients: 0, tabs: [] },
          main: { name: "main", status: "active", createdAt: "2026-06-15T12:00:03.000Z", updatedAt: "x", attachedClients: 0, tabs: [] },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => ["main", "bench", "docs"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.list()).resolves.toMatchObject([
      { name: "docs" },
      { name: "bench" },
      { name: "main" },
    ]);
    const raw = await readFile(persistPath, "utf-8");
    expect(JSON.parse(raw).order).toEqual(["docs", "bench", "main"]);
  });

  it("atomically persists created sessions", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await registry.create({ name: "main" });

    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    expect(JSON.parse(raw).sessions.main.name).toBe("main");
  });

  it("does not cap live zellij shell sessions", async () => {
    const root = await tempRoot();
    const live = new Set<string>();
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async ({ name }: { name: string }) => {
        live.add(name);
      }),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });
    await registry.create({ name: "one" });

    await expect(registry.create({ name: "two" })).resolves.toMatchObject({
      name: "two",
      status: "active",
    });
    expect(adapter.createSession).toHaveBeenCalledTimes(2);
  });

  it("reconciles stale metadata against live zellij sessions", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        sessions: {
          stale: { name: "stale", status: "active", createdAt: "x", updatedAt: "x", attachedClients: 0, tabs: [] },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.list()).resolves.toEqual([]);
    const raw = await readFile(persistPath, "utf-8");
    expect(JSON.parse(raw).sessions.stale.status).toBe("exited");
  });

  it("lists orphan zellij sessions missing from metadata and adopts them", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.list()).resolves.toMatchObject([
      { name: "main", status: "active", attachedClients: 0, tabs: [] },
    ]);

    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    expect(JSON.parse(raw).sessions.main.name).toBe("main");
  });

  it("persists active/background placement and derives unread visual status from scrollback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T12:00:00.000Z"));
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => ["main", "deploy-logs", "review-done"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const scrollbackStore = {
      latestSeq: vi.fn(async (name: string) => (
        name === "main" ? 12 : name === "review-done" ? 7 : null
      )),
      cleanup: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
      scrollbackStore: scrollbackStore as never,
    });

    await registry.updateUiState("main", { placement: "background", lastSeenSeq: 4 });
    vi.setSystemTime(new Date("2026-06-18T12:00:01.000Z"));
    await registry.updateUiState("review-done", { lastSeenSeq: 3, visualStatus: "finished" });
    vi.setSystemTime(new Date("2026-06-18T12:00:02.000Z"));

    await expect(registry.list()).resolves.toMatchObject([
      {
        name: "main",
        placement: "background",
        latestSeq: 12,
        lastSeenSeq: 4,
        unread: true,
        visualStatus: "finished",
        attachCommand: "mos shell attach main",
      },
      {
        name: "review-done",
        latestSeq: 7,
        lastSeenSeq: 3,
        unread: true,
        visualStatus: "finished",
      },
      {
        name: "deploy-logs",
        placement: "active",
        unread: false,
        visualStatus: "idle",
      },
    ]);

    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    expect(JSON.parse(raw).sessions.main.placement).toBe("background");
  });

  it("derives Paper status dots from OSC marks, unread output, and waiting metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => [
        "quiet",
        "unread-done",
        "osc-running",
        "osc-done",
        "waiting",
        "legacy-running",
      ]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const latestSeqByName = new Map([
      ["quiet", null],
      ["unread-done", 8],
      ["osc-running", 14],
      ["osc-done", 21],
      ["waiting", 3],
      ["legacy-running", 5],
    ]);
    const scrollbackStore = {
      latestSeq: vi.fn(async (name: string) => latestSeqByName.get(name) ?? null),
      latestActivity: vi.fn(async (name: string) => {
        if (name === "osc-running") {
          return {
            latestSeq: 14,
            latestOutputAt: "2026-06-15T11:59:58.000Z",
            commandRunning: true,
            latestCommandMark: { code: "B", kind: "command-start" },
          };
        }
        if (name === "osc-done") {
          return {
            latestSeq: 21,
            latestOutputAt: "2026-06-15T11:59:59.000Z",
            commandRunning: false,
            latestCommandMark: { code: "D", kind: "command-finished", exitCode: 0 },
          };
        }
        return {
          latestSeq: latestSeqByName.get(name) ?? null,
          latestOutputAt: null,
          commandRunning: null,
          latestCommandMark: null,
        };
      }),
      cleanup: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
      scrollbackStore: scrollbackStore as never,
    });

    await registry.updateUiState("unread-done", { lastSeenSeq: 2 });
    await registry.updateUiState("osc-done", { lastSeenSeq: 20 });
    await registry.updateUiState("waiting", { visualStatus: "waiting" });
    await registry.updateUiState("legacy-running", { lastSeenSeq: 1, visualStatus: "running" });

    await expect(registry.list()).resolves.toMatchObject([
      { name: "legacy-running", latestSeq: 5, lastSeenSeq: 1, unread: true, visualStatus: "finished" },
      { name: "osc-done", latestSeq: 21, lastSeenSeq: 20, unread: true, visualStatus: "finished" },
      { name: "osc-running", unread: false, visualStatus: "running" },
      { name: "quiet", unread: false, visualStatus: "idle" },
      { name: "unread-done", latestSeq: 8, lastSeenSeq: 2, unread: true, visualStatus: "finished" },
      { name: "waiting", visualStatus: "waiting" },
    ]);
  });

  it("rejects UI state updates for sessions absent from metadata and live sessions", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.updateUiState("ghost", { placement: "active" })).rejects.toMatchObject({
      code: "session_not_found",
      status: 404,
    });

    await expect(readFile(join(root, "system", "shell-sessions.json"), "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(adapter.listSessions).toHaveBeenCalled();
  });

  it("uses waiting and idle status dots from durable metadata", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => ["codex-backend", "shell-main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await registry.updateUiState("codex-backend", { visualStatus: "waiting" });
    await registry.updateUiState("shell-main", { visualStatus: "idle" });

    await expect(registry.list()).resolves.toMatchObject([
      { name: "codex-backend", visualStatus: "waiting", unread: false },
      { name: "shell-main", visualStatus: "idle", unread: false },
    ]);
  });

  it("renames live sessions while preserving durable UI state and scrollback", async () => {
    const root = await tempRoot();
    const live = new Set(["main"]);
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      renameSession: vi.fn(async (name: string, nextName: string) => {
        live.delete(name);
        live.add(nextName);
      }),
    };
    const scrollbackStore = {
      latestSeq: vi.fn(async (name: string) => (name === "review-main" ? 9 : null)),
      cleanup: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
    };
    const preferencesStore = {
      rename: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
      scrollbackStore: scrollbackStore as never,
      preferencesStore: preferencesStore as never,
    });

    await registry.updateUiState("main", {
      placement: "background",
      lastSeenSeq: 3,
      visualStatus: "finished",
    });

    await expect(registry.rename("main", "review-main")).resolves.toMatchObject({
      name: "review-main",
      placement: "background",
      latestSeq: 9,
      lastSeenSeq: 3,
      unread: true,
      visualStatus: "finished",
      attachCommand: "mos shell attach review-main",
    });

    expect(adapter.renameSession).toHaveBeenCalledWith("main", "review-main");
    expect(scrollbackStore.rename).toHaveBeenCalledWith("main", "review-main");
    expect(preferencesStore.rename).toHaveBeenCalledWith("main", "review-main");
    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    const sessions = JSON.parse(raw).sessions;
    expect(sessions.main).toBeUndefined();
    expect(sessions["review-main"].placement).toBe("background");
  });

  it("rolls back zellij, scrollback, and preferences when renamed metadata cannot persist", async () => {
    const root = await tempRoot();
    const systemDir = join(root, "system");
    const live = new Set(["main"]);
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      renameSession: vi.fn(async (name: string, nextName: string) => {
        live.delete(name);
        live.add(nextName);
      }),
    };
    const scrollbackStore = {
      latestSeq: vi.fn(async () => null),
      cleanup: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
    };
    const preferencesStore = {
      rename: vi.fn(async () => {
        if (preferencesStore.rename.mock.calls.length === 1) {
          await rm(systemDir, { recursive: true, force: true });
          await writeFile(systemDir, "not a directory", { flag: "wx" });
        }
      }),
    };
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
      scrollbackStore: scrollbackStore as never,
      preferencesStore: preferencesStore as never,
    });

    await registry.updateUiState("main", { placement: "background" });

    await expect(registry.rename("main", "review-main")).rejects.toBeInstanceOf(Error);

    expect(adapter.renameSession).toHaveBeenNthCalledWith(1, "main", "review-main");
    expect(adapter.renameSession).toHaveBeenNthCalledWith(2, "review-main", "main");
    expect(scrollbackStore.rename).toHaveBeenNthCalledWith(1, "main", "review-main");
    expect(scrollbackStore.rename).toHaveBeenNthCalledWith(2, "review-main", "main");
    expect(preferencesStore.rename).toHaveBeenNthCalledWith(1, "main", "review-main");
    expect(preferencesStore.rename).toHaveBeenNthCalledWith(2, "review-main", "main");
    expect(Array.from(live)).toEqual(["main"]);
  });

  it("connects by adopting an orphan active zellij session", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.get("main")).resolves.toMatchObject({
      name: "main",
      status: "active",
    });
  });

  it("connects by resurrecting an orphan exited zellij session", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        sessions: {
          main: { name: "main", status: "exited", createdAt: "x", updatedAt: "x", attachedClients: 0, tabs: [] },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.get("main")).resolves.toMatchObject({
      name: "main",
      status: "active",
    });
    const raw = await readFile(persistPath, "utf-8");
    expect(JSON.parse(raw).sessions.main.status).toBe("active");
  });

  it("adopts existing zellij sessions when creating a duplicate name", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.create({ name: "main" })).resolves.toMatchObject({
      name: "main",
      status: "active",
    });

    expect(adapter.createSession).not.toHaveBeenCalled();
  });

  it("force deletes live orphan zellij sessions missing from metadata", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => ["bench"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.delete("bench", { force: true })).resolves.toBeUndefined();

    expect(adapter.deleteSession).toHaveBeenCalledWith("bench", { force: true });
  });

  it("deletes metadata-tracked sessions without listing live zellij sessions", async () => {
    const root = await tempRoot();
    const persistPath = join(root, "system", "shell-sessions.json");
    await mkdir(join(root, "system"), { recursive: true });
    await writeFile(
      persistPath,
      JSON.stringify({
        sessions: {
          main: { name: "main", status: "active", createdAt: "x", updatedAt: "x", attachedClients: 0, tabs: [] },
        },
      }),
      { flag: "wx" },
    );
    const adapter = {
      listSessions: vi.fn(async () => {
        throw new Error("zellij list unavailable");
      }),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter });

    await expect(registry.delete("main")).resolves.toBeUndefined();

    expect(adapter.listSessions).not.toHaveBeenCalled();
    expect(adapter.deleteSession).toHaveBeenCalledWith("main", {});
  });

  it("rolls back zellij sessions if metadata persistence fails", async () => {
    const root = await tempRoot();
    const systemDir = join(root, "system");
    const adapter = {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => {
        await rm(systemDir, { recursive: true, force: true });
        await writeFile(systemDir, "not a directory", { flag: "wx" });
      }),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
    });

    await expect(registry.create({ name: "main" })).rejects.toBeInstanceOf(Error);
    expect(adapter.deleteSession).toHaveBeenCalledWith("main", { force: true });
  });
});
