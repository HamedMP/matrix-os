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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shell registry", () => {
  it("atomically persists created sessions", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter, maxSessions: 2 });

    await registry.create({ name: "main" });

    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    expect(JSON.parse(raw).sessions.main.name).toBe("main");
  });

  it("rejects new sessions at the configured cap", async () => {
    const root = await tempRoot();
    const live = new Set<string>();
    const adapter = {
      listSessions: vi.fn(async () => Array.from(live)),
      createSession: vi.fn(async ({ name }: { name: string }) => {
        live.add(name);
      }),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter, maxSessions: 1 });
    await registry.create({ name: "one" });

    await expect(registry.create({ name: "two" })).rejects.toMatchObject({
      code: "session_limit",
    });
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
    const registry = new ShellRegistry({ homePath: root, adapter, maxSessions: 2 });

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
    const registry = new ShellRegistry({ homePath: root, adapter, maxSessions: 2 });

    await expect(registry.list()).resolves.toMatchObject([
      { name: "main", status: "active", attachedClients: 0, tabs: [] },
    ]);

    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    expect(JSON.parse(raw).sessions.main.name).toBe("main");
  });

  it("persists active/background placement and derives unread visual status from scrollback", async () => {
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
      maxSessions: 4,
      scrollbackStore: scrollbackStore as never,
    });

    await registry.updateUiState("main", { placement: "background", lastSeenSeq: 4 });
    await registry.updateUiState("review-done", { lastSeenSeq: 3, visualStatus: "finished" });

    await expect(registry.list()).resolves.toMatchObject([
      {
        name: "main",
        placement: "background",
        latestSeq: 12,
        lastSeenSeq: 4,
        unread: true,
        visualStatus: "running",
        attachCommand: "mos shell attach main",
      },
      {
        name: "deploy-logs",
        placement: "active",
        unread: false,
        visualStatus: "running",
      },
      {
        name: "review-done",
        latestSeq: 7,
        lastSeenSeq: 3,
        unread: true,
        visualStatus: "finished",
      },
    ]);

    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    expect(JSON.parse(raw).sessions.main.placement).toBe("background");
  });

  it("rejects UI state updates for sessions absent from metadata and live sessions", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter, maxSessions: 4 });

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
    const registry = new ShellRegistry({ homePath: root, adapter, maxSessions: 4 });

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
    const registry = new ShellRegistry({
      homePath: root,
      adapter,
      maxSessions: 4,
      scrollbackStore: scrollbackStore as never,
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
    const raw = await readFile(join(root, "system", "shell-sessions.json"), "utf-8");
    const sessions = JSON.parse(raw).sessions;
    expect(sessions.main).toBeUndefined();
    expect(sessions["review-main"].placement).toBe("background");
  });

  it("connects by adopting an orphan active zellij session", async () => {
    const root = await tempRoot();
    const adapter = {
      listSessions: vi.fn(async () => ["main"]),
      createSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
    };
    const registry = new ShellRegistry({ homePath: root, adapter, maxSessions: 2 });

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
    const registry = new ShellRegistry({ homePath: root, adapter, maxSessions: 2 });

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
    const registry = new ShellRegistry({ homePath: root, adapter, maxSessions: 2 });

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
    const registry = new ShellRegistry({ homePath: root, adapter, maxSessions: 2 });

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
    const registry = new ShellRegistry({ homePath: root, adapter, maxSessions: 2 });

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
      maxSessions: 2,
    });

    await expect(registry.create({ name: "main" })).rejects.toBeInstanceOf(Error);
    expect(adapter.deleteSession).toHaveBeenCalledWith("main", { force: true });
  });
});
