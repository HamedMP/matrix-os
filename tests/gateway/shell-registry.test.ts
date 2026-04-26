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
