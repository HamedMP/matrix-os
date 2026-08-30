import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  migrateTerminalWorkspaces,
  rollbackTerminalWorkspaceMigration,
  type LegacyZellijCutover,
} from "../../packages/terminal-runtime/src/migration.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("terminal workspace cutover", () => {
  it("commits a reserved main workspace on a clean install with no legacy sessions", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-migration-clean-"));
    homes.push(homePath);
    const ensured: string[] = [];
    const cutover: LegacyZellijCutover = {
      stopLegacySessions: async (names) => expect(names).toEqual([]),
      ensureWorkspace: async (sessionName) => { ensured.push(sessionName); },
      createShellTab: async () => ({ tabId: 1, paneId: "terminal_1" }),
    };

    await expect(migrateTerminalWorkspaces({ homePath, projects: [], cutover })).resolves.toEqual({
      status: "committed",
      migratedTabs: 0,
      stoppedLegacySessions: 0,
    });
    const state = JSON.parse(await readFile(join(homePath, "system", "terminal-workspaces.json"), "utf8"));
    expect(Object.values(state.workspaces)).toHaveLength(1);
    expect(Object.values(state.workspaces)[0]).toMatchObject({ scope: "main", tabs: {} });
    expect(ensured).toHaveLength(1);
  });

  it("fsyncs the containing directory after atomic journal and owner-state renames", async () => {
    const source = await readFile(
      join(process.cwd(), "packages/terminal-runtime/src/migration.ts"),
      "utf8",
    );

    expect(source).toContain("await renameDurable(stagedStatePath, finalStatePath)");
    expect(source).toContain('const directoryHandle = await open(path, "r")');
    expect(source).toContain("await directoryHandle.sync()");
    expect(source).toContain("await directoryHandle.close()");
  });

  it("persists original reference-file backups before attempting in-place rewrites", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-migration-backup-"));
    homes.push(homePath);
    const systemPath = join(homePath, "system");
    const sessionsPath = join(systemPath, "sessions");
    await mkdir(sessionsPath, { recursive: true });
    const original = `${JSON.stringify({ terminalSessionId: "legacy" })}\n`;
    const referencePath = join(sessionsPath, "thread.json");
    await writeFile(referencePath, original);
    await writeFile(join(systemPath, "shell-sessions.json"), JSON.stringify({
      sessions: {
        legacy: { name: "legacy", status: "active", cwd: "" },
      },
    }));
    await chmod(sessionsPath, 0o500);

    const cutover: LegacyZellijCutover = {
      stopLegacySessions: async () => undefined,
      ensureWorkspace: async () => undefined,
      createShellTab: async () => ({ tabId: 1, paneId: "terminal_1" }),
    };

    try {
      await expect(migrateTerminalWorkspaces({ homePath, projects: [], cutover })).rejects.toMatchObject({
        code: "EACCES",
      });
      const journal = JSON.parse(await readFile(join(systemPath, "terminal-migration-journal.json"), "utf8"));
      expect(journal.status).toBe("staging");
      expect(journal.backups["system/sessions/thread.json"]).toBe(original);
      expect(await readFile(referencePath, "utf8")).toBe(original);
    } finally {
      await chmod(sessionsPath, 0o700);
    }
  });

  it("journals generated name-scoped targets before attempting their writes", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-migration-generated-"));
    homes.push(homePath);
    const systemPath = join(homePath, "system");
    await mkdir(join(systemPath, "shell-preferences"), { recursive: true });
    await writeFile(join(systemPath, "shell-sessions.json"), JSON.stringify({
      sessions: {
        legacy: { name: "legacy", status: "active", cwd: "" },
      },
    }));
    await writeFile(join(systemPath, "shell-preferences", "legacy.json"), JSON.stringify({
      terminalSessionId: "legacy",
    }));
    await writeFile(join(systemPath, "terminal-tabs"), "blocks generated target directory creation");

    const cutover: LegacyZellijCutover = {
      stopLegacySessions: async () => undefined,
      ensureWorkspace: async () => undefined,
      createShellTab: async () => ({ tabId: 1, paneId: "terminal_1" }),
    };

    await expect(migrateTerminalWorkspaces({ homePath, projects: [], cutover })).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    const journal = JSON.parse(await readFile(join(systemPath, "terminal-migration-journal.json"), "utf8"));
    expect(journal.status).toBe("staging");
    expect(journal.generatedPaths).toEqual([
      expect.stringMatching(/^system\/terminal-tabs\/[^/]+\/preferences\.json$/),
    ]);
    await rm(join(systemPath, "terminal-tabs"), { force: true });
    await rollbackTerminalWorkspaceMigration({ homePath, cutover });
    expect(JSON.parse(await readFile(join(systemPath, "terminal-migration-journal.json"), "utf8")).status)
      .toBe("rolled_back");
  });

  it("journals, classifies, rewrites, stops, recreates shells, commits, and rolls back idempotently", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-migration-"));
    homes.push(homePath);
    const systemPath = join(homePath, "system");
    await mkdir(systemPath, { recursive: true });
    const legacy = {
      sessions: {
        explicit: { name: "build", status: "active", cwd: "projects/alpha", projectId: "alpha", createdAt: "2026-08-01T00:00:00.000Z" },
        inferred: { name: "build", status: "active", cwd: "projects/beta/packages/app", createdAt: "2026-08-02T00:00:00.000Z" },
        ambiguous: { name: "setup", status: "active", cwd: "downloads", createdAt: "2026-08-03T00:00:00.000Z" },
      },
    };
    await writeFile(join(systemPath, "shell-sessions.json"), JSON.stringify(legacy));
    await writeFile(join(systemPath, "terminal-layouts.json"), JSON.stringify({ panes: [
      { terminalSessionId: "explicit" },
      { terminalSessionId: "ambiguous" },
    ] }));
    await mkdir(join(systemPath, "scrollback"), { recursive: true });
    const legacyScrollback = [
      JSON.stringify({ type: "output", seq: 4, data: "\u001b[32mbuilding\u001b[0m\n" }),
      "malformed legacy record",
      JSON.stringify({ type: "seq-reserve", seq: 6 }),
      JSON.stringify({ type: "output", seq: 5, data: "done\n" }),
    ].join("\n") + "\n";
    await writeFile(join(systemPath, "scrollback", "explicit.ndjson"), legacyScrollback);

    const created: Array<{ sessionName: string; tabName: string; cwd: string; command?: string }> = [];
    const stopped: string[][] = [];
    const cutover: LegacyZellijCutover = {
      stopLegacySessions: async (names) => {
        const journal = JSON.parse(await readFile(join(systemPath, "terminal-migration-journal.json"), "utf8"));
        expect(journal.status).toBe("staged");
        stopped.push(names);
      },
      ensureWorkspace: async () => undefined,
      createShellTab: async (sessionName, input) => {
        created.push({ sessionName, tabName: input.internalName, cwd: input.cwd, command: input.command });
        const tabId = created.length;
        return { tabId, paneId: `terminal_${tabId}` };
      },
    };

    const result = await migrateTerminalWorkspaces({
      homePath,
      projects: [
        { id: "alpha", cwd: "projects/alpha" },
        { id: "beta", cwd: "projects/beta" },
      ],
      cutover,
    });

    expect(result).toMatchObject({ migratedTabs: 3, stoppedLegacySessions: 3, status: "committed" });
    expect(stopped).toEqual([["explicit", "inferred", "ambiguous"]]);
    expect(created).toHaveLength(3);
    expect(created.every((entry) => entry.command === undefined)).toBe(true);

    const state = JSON.parse(await readFile(join(systemPath, "terminal-workspaces.json"), "utf8"));
    const workspaces = Object.values(state.workspaces) as Array<{ scope: string; projectId?: string; tabs: Record<string, { name: string }> }>;
    expect(workspaces.map((workspace) => workspace.projectId ?? workspace.scope).sort()).toEqual(["alpha", "beta", "main"]);
    expect(workspaces.flatMap((workspace) => Object.values(workspace.tabs).map((tab) => tab.name)).sort()).toEqual(["build", "build", "setup"]);

    const layout = JSON.parse(await readFile(join(systemPath, "terminal-layouts.json"), "utf8"));
    expect(layout.panes.every((pane: Record<string, unknown>) => pane.terminalRef && !("terminalSessionId" in pane))).toBe(true);
    const migratedRef = layout.panes[0].terminalRef;
    await expect(new TerminalWorkspaceStore({ homePath }).readSnapshot(migratedRef)).resolves.toMatchObject({
      terminalRef: migratedRef,
      seq: 6,
      ansi: "\u001b[32mbuilding\u001b[0m\ndone\n",
      scrollback: ["\u001b[32mbuilding\u001b[0m", "done"],
    });

    const journalPath = join(systemPath, "terminal-migration-journal.json");
    const interruptedJournal = JSON.parse(await readFile(journalPath, "utf8"));
    interruptedJournal.status = "activating";
    await writeFile(journalPath, JSON.stringify(interruptedJournal));

    const retry = await migrateTerminalWorkspaces({ homePath, projects: [], cutover });
    expect(retry.status).toBe("already_committed");
    expect(created).toHaveLength(3);
    expect(JSON.parse(await readFile(journalPath, "utf8")).status).toBe("committed");

    await rollbackTerminalWorkspaceMigration({ homePath, cutover });
    expect(JSON.parse(await readFile(join(systemPath, "shell-sessions.json"), "utf8"))).toEqual(legacy);
    expect(JSON.parse(await readFile(join(systemPath, "terminal-layouts.json"), "utf8")).panes[0]).toEqual({ terminalSessionId: "explicit" });
    expect(await readFile(join(systemPath, "scrollback", "explicit.ndjson"), "utf8")).toBe(legacyScrollback);
  });

  it("resumes an interrupted rollback before validating cutover state", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-migration-rollback-retry-"));
    homes.push(homePath);
    const systemPath = join(homePath, "system");
    await mkdir(systemPath, { recursive: true });
    await writeFile(join(systemPath, "shell-sessions.json"), JSON.stringify({
      sessions: {
        legacy: { name: "build", status: "active", cwd: "" },
      },
    }));
    await writeFile(join(systemPath, "terminal-layouts.json"), JSON.stringify({
      panes: [{ terminalSessionId: "legacy" }],
    }));

    let interruptRollback = true;
    const cutover: LegacyZellijCutover = {
      stopLegacySessions: async () => undefined,
      ensureWorkspace: async () => undefined,
      createShellTab: async () => ({ tabId: 1, paneId: "terminal_1" }),
      stopWorkspaceSessions: async () => {
        const journal = JSON.parse(await readFile(
          join(systemPath, "terminal-migration-journal.json"),
          "utf8",
        ));
        expect(journal.status).toBe("rolling_back");
        if (interruptRollback) {
          interruptRollback = false;
          throw new Error("simulated rollback interruption");
        }
      },
    };

    await migrateTerminalWorkspaces({ homePath, projects: [], cutover });
    await expect(rollbackTerminalWorkspaceMigration({ homePath, cutover }))
      .rejects.toThrow("simulated rollback interruption");
    expect(JSON.parse(await readFile(
      join(systemPath, "terminal-migration-journal.json"),
      "utf8",
    )).status).toBe("rolling_back");

    // Model a later interruption after the new state files were removed but
    // before the rollback journal reached its terminal state.
    await rm(join(systemPath, "terminal-workspaces.json"), { force: true });
    await rm(join(systemPath, "terminal-workspaces.staged.json"), { force: true });

    await expect(migrateTerminalWorkspaces({ homePath, projects: [], cutover })).resolves.toMatchObject({
      status: "committed",
      migratedTabs: 1,
    });
    expect(JSON.parse(await readFile(
      join(systemPath, "terminal-migration-journal.json"),
      "utf8",
    )).status).toBe("committed");
    expect(JSON.parse(await readFile(join(systemPath, "terminal-layouts.json"), "utf8")).panes[0])
      .toHaveProperty("terminalRef");
  });

  it("stops staged workspace sessions when activation fails before commit", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-migration-staged-rollback-"));
    homes.push(homePath);
    const systemPath = join(homePath, "system");
    await mkdir(systemPath, { recursive: true });
    await writeFile(join(systemPath, "shell-sessions.json"), JSON.stringify({
      sessions: {
        legacy: { name: "build", status: "active", cwd: "" },
      },
    }));

    const ensured: string[] = [];
    const stopped: string[][] = [];
    const cutover: LegacyZellijCutover = {
      stopLegacySessions: async () => undefined,
      ensureWorkspace: async (sessionName) => { ensured.push(sessionName); },
      createShellTab: async () => {
        throw new Error("simulated activation failure");
      },
      stopWorkspaceSessions: async (sessionNames) => { stopped.push(sessionNames); },
    };

    await expect(migrateTerminalWorkspaces({ homePath, projects: [], cutover }))
      .rejects.toThrow("simulated activation failure");
    await expect(rollbackTerminalWorkspaceMigration({ homePath, cutover })).resolves.toBeUndefined();

    expect(ensured).toHaveLength(1);
    expect(stopped).toEqual([ensured]);
    expect(JSON.parse(await readFile(
      join(systemPath, "terminal-migration-journal.json"),
      "utf8",
    )).status).toBe("rolled_back");
  });

  it("accepts scrollback up to the legacy five MiB retention limit", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-migration-large-scrollback-"));
    homes.push(homePath);
    const systemPath = join(homePath, "system");
    await mkdir(join(systemPath, "scrollback"), { recursive: true });
    await writeFile(join(systemPath, "shell-sessions.json"), JSON.stringify({
      sessions: {
        legacy: { name: "large", status: "active", cwd: "" },
      },
    }));
    const retained = "x".repeat(4 * 1024 * 1024 + 1);
    await writeFile(
      join(systemPath, "scrollback", "legacy.ndjson"),
      `${JSON.stringify({ type: "output", seq: 9, data: retained })}\n`,
    );
    const cutover: LegacyZellijCutover = {
      stopLegacySessions: async () => undefined,
      ensureWorkspace: async () => undefined,
      createShellTab: async () => ({ tabId: 1, paneId: "terminal_1" }),
    };

    await expect(migrateTerminalWorkspaces({ homePath, projects: [], cutover })).resolves.toMatchObject({
      status: "committed",
      migratedTabs: 1,
    });
    const workspace = (await new TerminalWorkspaceStore({ homePath }).listWorkspaces())[0]!;
    await expect(new TerminalWorkspaceStore({ homePath }).readSnapshot({
      workspaceId: workspace.id,
      tabId: workspace.tabs[0]!.id,
    })).resolves.toMatchObject({ ansi: retained, seq: 9 });
  });

  it("rejects a persisted traversal session key before reading scrollback", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-migration-traversal-"));
    homes.push(homePath);
    const systemPath = join(homePath, "system");
    await mkdir(join(systemPath, "scrollback"), { recursive: true });
    await writeFile(join(systemPath, "shell-sessions.json"), JSON.stringify({
      sessions: {
        "../outside": { name: "outside", status: "active", cwd: "" },
      },
    }));
    const outsidePath = join(systemPath, "outside.ndjson");
    const outside = `${JSON.stringify({ type: "output", seq: 1, data: "must not be read" })}\n`;
    await writeFile(outsidePath, outside);
    const cutover: LegacyZellijCutover = {
      stopLegacySessions: async () => undefined,
      ensureWorkspace: async () => undefined,
      createShellTab: async () => ({ tabId: 1, paneId: "terminal_1" }),
    };

    await expect(migrateTerminalWorkspaces({ homePath, projects: [], cutover })).rejects.toThrow();
    expect(await readFile(outsidePath, "utf8")).toBe(outside);
  });
});
