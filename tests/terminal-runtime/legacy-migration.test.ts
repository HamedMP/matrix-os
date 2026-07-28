import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HomeRelativeCwdSchema, createRuntimeState, migrateLegacyTerminalState, type HomeRelativeCwd } from "../../packages/terminal-runtime/src/index.js";
const roots: string[] = [];
const IDS = ["00000000000000000000000000000001", "00000000000000000000000000000002", "00000000000000000000000000000003"];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "terminal-legacy-migration-"));
  roots.push(root);
  const homePath = join(root, "home");
  const durableRoot = join(homePath, "system", "terminal-runtime");
  const runtimeRoot = join(root, "run");
  await mkdir(join(homePath, "system", "sessions"), { recursive: true });
  await mkdir(join(homePath, "projects", "example"), { recursive: true });
  const state = await createRuntimeState({ durableRoot, runtimeRoot });
  return { root, homePath, state };
}
function cwdResolver(homePath: string) {
  return async (candidate?: string): Promise<HomeRelativeCwd> => {
    const root = resolve(homePath);
    const target = resolve(candidate ?? root);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error("cwd_unavailable");
    }
    return HomeRelativeCwdSchema.parse({
      kind: "home-relative",
      path: relative(root, target).split(sep).join("/"),
    });
  };
}
describe("legacy terminal migration", () => {
  it("creates interrupted immutable receipts without adopting or launching legacy processes", async () => {
    const { homePath, state } = await fixture();
    const createdAt = "2026-07-25T10:00:00.000Z";
    await writeFile(join(homePath, "system", "shell-sessions.json"), JSON.stringify({
      sessions: {
        "release-watch": {
          name: "release-watch",
          status: "active",
          createdAt,
          updatedAt: createdAt,
          cwd: join(homePath, "projects", "example"),
          tabs: [],
          command: "print-secret",
        },
        "../escape": {
          name: "../escape",
          status: "active",
          createdAt,
          updatedAt: createdAt,
          cwd: "/etc",
          tabs: [],
        },
      },
    }));
    await writeFile(join(homePath, "system", "sessions", "sess_alpha.json"), JSON.stringify({
      id: "sess_alpha",
      kind: "agent",
      projectSlug: "example",
      runtime: {
        type: "zellij",
        status: "running",
        zellijSession: "legacy-agent-session",
      },
      prompt: "never-copy-this",
      provider: "claude",
      ownerId: "owner",
    }));
    let nextId = 0;
    const result = await migrateLegacyTerminalState({
      homePath,
      state,
      resolveCwd: cwdResolver(homePath),
      resolveWorkspaceCwd: async () => join(homePath, "projects", "example"),
      now: () => new Date("2026-07-26T10:00:00.000Z"),
      bootId: "migration-boot",
      createId: () => IDS[nextId++]!,
    });
    expect(result).toEqual({
      migrated: 2,
      existing: 0,
      skipped: 1,
      cwdFallbacks: 0,
      workspaceRecordsUpdated: 1,
    });
    const receipts = await state.receipts.list();
    expect(receipts).toHaveLength(2);
    for (const entry of receipts) {
      expect(entry.state?.kind).toBe("supported");
      if (entry.state?.kind !== "supported") continue;
      expect(entry.state.receipt.lastKnown.state).toBe("live");
      expect(entry.state.receipt.lastKnown.bootId).toBe("migration-boot");
      expect(entry.state.receipt.zellij.sessionName).toBe(`matrix-t-${entry.state.receipt.runtimeId}`);
      const serialized = JSON.stringify(entry.state.receipt);
      expect(serialized).not.toContain("print-secret");
      expect(serialized).not.toContain("never-copy-this");
      expect(serialized).not.toContain("claude");
      expect(serialized).not.toContain("legacy-agent-session");
    }
    expect(await state.names.resolve("release-watch", Date.now())).toMatchObject({
      runtimeId: IDS[0],
      source: "canonical",
    });
    expect(await state.names.resolve("sess_alpha", Date.now())).toMatchObject({
      runtimeId: IDS[1],
      source: "canonical",
    });
    const workspace = JSON.parse(await readFile(join(homePath, "system", "sessions", "sess_alpha.json"), "utf8")) as Record<string, unknown>;
    expect(workspace).toMatchObject({
      runtime: {
        type: "zellij",
        status: "degraded",
        runtimeId: IDS[1],
        zellijSession: `matrix-t-${IDS[1]}`,
        fallbackReason: "terminal_runtime_interrupted",
      },
      writeMode: "closed",
    });
    await state.close();
  });
  it("is idempotent and falls back to the owner home for unavailable cwd", async () => {
    const { homePath, state } = await fixture();
    await writeFile(join(homePath, "system", "shell-sessions.json"), JSON.stringify({
      sessions: {
        main: {
          name: "main",
          status: "active",
          createdAt: "2026-07-25T10:00:00.000Z",
          updatedAt: "2026-07-25T10:00:00.000Z",
          cwd: "/deleted/project",
          tabs: [],
        },
      },
    }));
    let calls = 0;
    const migrate = async () => await migrateLegacyTerminalState({
      homePath,
      state,
      resolveCwd: async (candidate) => {
        if (candidate) throw new Error("cwd_unavailable");
        return { kind: "home-relative", path: "" };
      },
      now: () => new Date("2026-07-26T10:00:00.000Z"),
      bootId: "migration-boot",
      createId: () => {
        calls += 1;
        return IDS[0];
      },
    });
    await expect(migrate()).resolves.toMatchObject({
      migrated: 1,
      cwdFallbacks: 1,
    });
    await expect(migrate()).resolves.toMatchObject({
      migrated: 0,
      existing: 1,
    });
    expect(calls).toBe(1);
    const receipt = await state.receipts.read(IDS[0]);
    expect(receipt?.kind === "supported" ? receipt.receipt.cwd : null)
      .toEqual({ kind: "home-relative", path: "" });
    await state.close();
  });
  it("keeps colliding shell and workspace records on distinct immutable runtimes", async () => {
    const { homePath, state } = await fixture();
    await writeFile(join(homePath, "system", "shell-sessions.json"), JSON.stringify({
      sessions: {
        main: {
          name: "main",
          status: "active",
          cwd: homePath,
        },
      },
    }));
    await writeFile(join(homePath, "system", "sessions", "main.json"), JSON.stringify({
      id: "main",
      kind: "agent",
      runtime: {
        type: "zellij",
        status: "running",
        zellijSession: "legacy-agent-main",
      },
    }));
    let nextId = 0;
    const migrate = async () => await migrateLegacyTerminalState({
      homePath,
      state,
      resolveCwd: cwdResolver(homePath),
      now: () => new Date("2026-07-26T10:00:00.000Z"),
      bootId: "migration-boot",
      createId: () => IDS[nextId++]!,
    });
    await expect(migrate()).resolves.toMatchObject({
      migrated: 2,
      existing: 0,
      workspaceRecordsUpdated: 1,
    });
    const workspace = JSON.parse(await readFile(join(homePath, "system", "sessions", "main.json"), "utf8")) as { runtime: { runtimeId: string } };
    expect(workspace.runtime.runtimeId).toBe(IDS[1]);
    expect(workspace.runtime.runtimeId).not.toBe(IDS[0]);
    const receipts = (await state.receipts.list()).flatMap(({ state: receiptState }) => receiptState?.kind === "supported" ? [receiptState.receipt] : []);
    expect(receipts).toHaveLength(2);
    expect(receipts.map((receipt) => receipt.runtimeId).sort()).toEqual([IDS[0], IDS[1]]);
    const workspaceReceipt = receipts.find((receipt) => receipt.runtimeId === IDS[1]);
    expect(workspaceReceipt?.displayName).toMatch(/^main-agent-[0-9a-f]{12}$/);
    expect(await state.names.resolve("main", Date.now())).toMatchObject({
      runtimeId: IDS[0],
    });
    expect(await state.names.resolve(workspaceReceipt!.displayName, Date.now())).toMatchObject({ runtimeId: IDS[1] });
    await expect(migrate()).resolves.toMatchObject({
      migrated: 0,
      existing: 1,
      skipped: 1,
      workspaceRecordsUpdated: 0,
    });
    expect(nextId).toBe(2);
    await state.close();
  });
  it("reuses a colliding workspace runtime after interruption before its legacy marker update", async () => {
    const { homePath, state } = await fixture();
    await writeFile(join(homePath, "system", "shell-sessions.json"), JSON.stringify({
      sessions: {
        main: {
          name: "main",
          status: "active",
          cwd: homePath,
        },
      },
    }));
    const legacyWorkspace = {
      id: "main",
      kind: "agent",
      runtime: {
        type: "zellij",
        status: "running",
        zellijSession: "legacy-agent-main",
      },
    };
    const workspacePath = join(homePath, "system", "sessions", "main.json");
    await writeFile(workspacePath, JSON.stringify(legacyWorkspace));
    let nextId = 0;
    const migrate = async () => await migrateLegacyTerminalState({
      homePath,
      state,
      resolveCwd: cwdResolver(homePath),
      now: () => new Date("2026-07-26T10:00:00.000Z"),
      bootId: "migration-boot",
      createId: () => IDS[nextId++]!,
    });
    await expect(migrate()).resolves.toMatchObject({
      migrated: 2,
      existing: 0,
    });
    // Recreate a crash after receipt/name commit but before replacing the legacy marker.
    await writeFile(workspacePath, JSON.stringify(legacyWorkspace));
    await expect(migrate()).resolves.toMatchObject({
      migrated: 0,
      existing: 2,
      workspaceRecordsUpdated: 1,
    });
    expect(nextId).toBe(2);
    expect(await state.receipts.list()).toHaveLength(2);
    await state.close();
  });
  it("rejects symlinked legacy sources without creating recovery state", async () => {
    const { root, homePath, state } = await fixture();
    const outside = join(root, "outside.json");
    await writeFile(outside, JSON.stringify({
      sessions: {
        main: {
          name: "main",
          status: "active",
          createdAt: "2026-07-25T10:00:00.000Z",
          updatedAt: "2026-07-25T10:00:00.000Z",
          tabs: [],
        },
      },
    }));
    await symlink(outside, join(homePath, "system", "shell-sessions.json"));
    await expect(migrateLegacyTerminalState({
      homePath,
      state,
      resolveCwd: cwdResolver(homePath),
      bootId: "migration-boot",
      createId: () => IDS[0],
    })).rejects.toThrow("unsafe_file");
    expect(await state.receipts.list()).toHaveLength(0);
    await state.close();
  });
  it("rejects symlinked workspace records instead of hiding a trust-boundary failure", async () => {
    const { root, homePath, state } = await fixture();
    const outside = join(root, "workspace.json");
    await writeFile(outside, JSON.stringify({
      id: "sess_alpha",
      runtime: { type: "zellij", status: "running" },
    }));
    await symlink(outside, join(homePath, "system", "sessions", "sess_alpha.json"));
    await expect(migrateLegacyTerminalState({
      homePath,
      state,
      resolveCwd: cwdResolver(homePath),
      bootId: "migration-boot",
      createId: () => IDS[0],
    })).rejects.toThrow("unsafe_file");
    expect(await state.receipts.list()).toHaveLength(0);
    await state.close();
  });
});
