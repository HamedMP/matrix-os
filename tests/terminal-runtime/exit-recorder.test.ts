import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TerminalRuntime,
  type ZellijAttachment,
  type ZellijObserver,
  type ZellijRuntimeAdapter,
} from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";
import { TerminalExitRecorder } from "../../packages/terminal-runtime/src/exit-recorder.js";

// Spec 2706: Zellij keeps a command tab's pane after its program exits and
// reports that only through `list-panes`, and every `list-panes` redraws every
// attached client. Command tabs now write their exit code to a file the runtime
// reads, so no Zellij call is needed while they run.

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "matrix-exit-recorder-"));
  homes.push(dir);
  return dir;
}

const TAB_NAME = `matrix-tab-${"a".repeat(32)}`;

class RecordingZellij implements ZellijRuntimeAdapter {
  readonly commands: Array<string[] | undefined> = [];
  listCalls = 0;
  /** Tabs Zellij already has, by internal name, as after a restart. */
  readonly existing = new Map<string, { tabId: number; paneId: string }>();
  private nextTabId = 1;
  /** Starts the command, then never answers, like a service stopped mid-launch. */
  constructor(private readonly hangAfterLaunch = false) {}
  async ensureSession(): Promise<void> { /* sessions are implicit */ }
  async createTab(_session: string, input: { internalName: string; command?: string[] }) {
    this.commands.push(input.command);
    const tabId = this.nextTabId++;
    if (this.hangAfterLaunch) return new Promise<never>(() => undefined);
    return { tabId, paneId: `terminal_${tabId}` };
  }
  async findTabsByInternalName(_session: string, names: string[]) {
    return Object.fromEntries(names.flatMap((name) => {
      const ids = this.existing.get(name);
      return ids ? [[name, ids]] : [];
    }));
  }
  async openAttachment(): Promise<ZellijAttachment> {
    return { write: async () => undefined, resize: async () => undefined, close: async () => undefined };
  }
  async subscribeWorkspace(): Promise<ZellijObserver> {
    return { close: async () => undefined };
  }
  async listHeldPaneExits() {
    this.listCalls += 1;
    return [];
  }
}

describe("command exit files", () => {
  it("runs the command and writes its exit code, the signal ones included", async () => {
    const recorder = new TerminalExitRecorder({ directory: await tempDir() });
    await recorder.prepare();
    const [shell, ...args] = recorder.wrap(TAB_NAME, ["sh", "-c", "exit 7"]);
    const result = spawnSync(shell!, args, { encoding: "utf8" });
    expect(result.status).toBe(7);
    expect(await recorder.read()).toEqual([{ zellijTabName: TAB_NAME, exitCode: 7 }]);

    const [shell2, ...args2] = recorder.wrap(TAB_NAME, ["sh", "-c", "kill -TERM $$"]);
    spawnSync(shell2!, args2);
    expect(await recorder.read()).toEqual([{ zellijTabName: TAB_NAME, exitCode: 143 }]);
  });

  // Fault detected (Greptile, #3542): one unreadable exit file discarded every record in the pass.
  it("skips an unreadable exit file and still reports the others", async () => {
    const directory = await tempDir();
    const recorder = new TerminalExitRecorder({ directory });
    await recorder.prepare();
    const locked = join(directory, `matrix-tab-${"e".repeat(32)}`);
    await writeFile(locked, "1\n");
    await chmod(locked, 0o000);
    await writeFile(join(directory, `matrix-tab-${"f".repeat(32)}`), "7\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await recorder.read()).toEqual([{ zellijTabName: `matrix-tab-${"f".repeat(32)}`, exitCode: 7 }]);
      expect(warn).toHaveBeenCalledWith("[terminal-runtime] exit file unreadable:", "EACCES");
    } finally {
      await chmod(locked, 0o600);
    }
  });

  it("ignores files it did not name, symlinks and bad contents", async () => {
    const directory = await tempDir();
    const recorder = new TerminalExitRecorder({ directory });
    await recorder.prepare();
    await writeFile(join(directory, "not-a-tab"), "1\n");
    await writeFile(join(directory, `matrix-tab-${"b".repeat(32)}`), "oops\n");
    await writeFile(join(directory, `matrix-tab-${"c".repeat(32)}.tmp`), "3\n");
    const target = join(await tempDir(), "elsewhere");
    await writeFile(target, "4\n");
    await symlink(target, join(directory, `matrix-tab-${"d".repeat(32)}`));
    expect(await recorder.read()).toEqual([]);
  });

  it("removes temporary files a write left behind, once they are old, and on clear", async () => {
    const directory = await tempDir();
    const now = Date.parse("2026-11-21T12:00:00Z");
    const recorder = new TerminalExitRecorder({ directory, now: () => now });
    await recorder.prepare();
    const stale = join(directory, `${TAB_NAME}.tmp`);
    const fresh = join(directory, `matrix-tab-${"f".repeat(32)}.tmp`);
    await writeFile(stale, "1");
    await writeFile(fresh, "2");
    await utimes(stale, new Date(now - 11 * 60_000), new Date(now - 11 * 60_000));
    await utimes(fresh, new Date(now), new Date(now));
    const target = join(await tempDir(), "kept");
    await writeFile(target, "x");
    await symlink(target, join(directory, `matrix-tab-${"9".repeat(32)}.tmp`));
    expect(await recorder.read()).toEqual([]);
    // The stale file goes; the fresh one and the symlink (never swept) stay.
    expect((await readdir(directory)).sort()).toEqual([`matrix-tab-${"9".repeat(32)}.tmp`, `matrix-tab-${"f".repeat(32)}.tmp`]);
    expect(await readFile(target, "utf8")).toBe("x");
    await recorder.clear(`matrix-tab-${"f".repeat(32)}`);
    expect(await readdir(directory)).toEqual([`matrix-tab-${"9".repeat(32)}.tmp`]);
  });

  it("skips a named pipe under a tab's name without waiting for a writer", async () => {
    const directory = await tempDir();
    const recorder = new TerminalExitRecorder({ directory });
    await recorder.prepare();
    expect(spawnSync("mkfifo", [join(directory, TAB_NAME)]).status).toBe(0);
    await writeFile(join(directory, `matrix-tab-${"e".repeat(32)}`), "5\n");
    const read = recorder.read();
    const outcome = await Promise.race([read, new Promise((resolve) => setTimeout(() => resolve("stalled"), 2_000))]);
    expect(outcome).toEqual([{ zellijTabName: `matrix-tab-${"e".repeat(32)}`, exitCode: 5 }]);
  });
});

describe("runtime with command exit files", () => {
  async function setup() {
    const homePath = await tempDir();
    const store = new TerminalWorkspaceStore({ homePath });
    const zellij = new RecordingZellij();
    const exitDirectory = join(homePath, "exits");
    const exits = new TerminalExitRecorder({ directory: exitDirectory });
    await exits.prepare();
    const runtime = new TerminalRuntime({ store, zellij, exits });
    const workspace = await runtime.ensureWorkspace({ projectId: "app" });
    return { store, zellij, runtime, workspace, exitDirectory };
  }

  it("records a command tab's exit from its file without asking Zellij", async () => {
    const { store, zellij, runtime, workspace, exitDirectory } = await setup();
    const tab = await runtime.createTab(workspace.id, { name: "tests", cwd: "", command: ["bun", "test"] });
    const runtimeTab = (await store.getRuntimeWorkspace(workspace.id))!.tabs[tab.id]!;
    // The program runs under the recorder, which names the file after the tab.
    expect(zellij.commands.at(-1)?.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(zellij.commands.at(-1)?.slice(-2)).toEqual(["bun", "test"]);

    // The first pass after start reconciles once; passes while the command runs ask nothing.
    await runtime.sweepHeldPaneExits();
    zellij.listCalls = 0;
    await runtime.sweepHeldPaneExits();
    await runtime.sweepHeldPaneExits();
    expect(zellij.listCalls).toBe(0);

    await writeFile(join(exitDirectory, runtimeTab.zellijTabName), "3\n");
    await runtime.sweepRecordedExits();
    const ended = (await store.getRuntimeWorkspace(workspace.id))!.tabs[tab.id]!;
    expect(ended.status).toBe("exited");
    expect(ended.exitCode).toBe(3);
    expect(await readdir(exitDirectory)).toEqual([]);
  });

  it("leaves shells unwrapped and drops a file whose tab is gone", async () => {
    const { zellij, runtime, workspace, exitDirectory } = await setup();
    await runtime.createTab(workspace.id, { name: "shell", cwd: "" });
    expect(zellij.commands.at(-1)).toBeUndefined();
    await writeFile(join(exitDirectory, TAB_NAME), "0\n");
    await runtime.sweepRecordedExits();
    expect(await readdir(exitDirectory)).toEqual([]);
  });

  it("keeps a command's exit file after the service stops mid-launch", async () => {
    const homePath = await tempDir();
    const exitDirectory = join(homePath, "exits");
    const exits = new TerminalExitRecorder({ directory: exitDirectory });
    await exits.prepare();
    const firstStore = new TerminalWorkspaceStore({ homePath });
    const stopping = new RecordingZellij(true);
    const first = new TerminalRuntime({ store: firstStore, zellij: stopping, exits });
    const workspace = await first.ensureWorkspace({ projectId: "app" });
    void first.createTab(workspace.id, { name: "agent", cwd: "", command: ["claude"] });
    await vi.waitFor(() => expect(stopping.commands).toHaveLength(1));

    // A new service finds the pane the wrapped command already runs in.
    const store = new TerminalWorkspaceStore({ homePath });
    const [tab] = Object.values((await store.getRuntimeWorkspace(workspace.id))!.tabs);
    const zellij = new RecordingZellij();
    zellij.existing.set(tab!.zellijTabName, { tabId: 7, paneId: "terminal_7" });
    const runtime = new TerminalRuntime({ store, zellij, exits });
    await runtime.restoreAll();
    expect((await store.getRuntimeWorkspace(workspace.id))!.tabs[tab!.id]!.status).toBe("running");

    await runtime.sweepHeldPaneExits();
    zellij.listCalls = 0;
    await runtime.sweepHeldPaneExits();
    expect(zellij.listCalls).toBe(0);
  });
});

// Fault detected (review of #3542): exitRecorded says how a command was
// launched, not that its record was written. A record lost to a storage
// outage left the tab "running" forever, because the held-pane sweep skipped it.
describe("a lost exit record", () => {
  /** Zellij stand-in that runs the wrapped command and, as Zellij does, holds its pane with the exit code. */
  class HoldingZellij extends RecordingZellij {
    readonly held = new Map<string, Array<{ tabId: number; paneId: string; exitCode: number }>>();
    readonly finished: Array<Promise<void>> = [];
    private nextHeldTab = 1;
    /** Runs just before the program starts, after the runtime prepared its launch. */
    beforeRun: () => Promise<void> = async () => undefined;
    override async createTab(session: string, input: { internalName: string; command?: string[] }) {
      this.commands.push(input.command);
      const tabId = this.nextHeldTab++;
      const paneId = `terminal_${tabId}`;
      if (input.command) {
        await this.beforeRun();
        const [program, ...args] = input.command;
        const result = spawnSync(program!, args, { encoding: "utf8" });
        this.held.set(session, [...(this.held.get(session) ?? []), { tabId, paneId, exitCode: result.status ?? 1 }]);
      }
      return { tabId, paneId };
    }
    override async listHeldPaneExits(session?: string) {
      this.listCalls += 1;
      return session ? this.held.get(session) ?? [] : [];
    }
  }

  it("completes the tab once the exit directory is back, on the next reconciling pass", async () => {
    const homePath = await tempDir();
    const exitDirectory = join(homePath, "exits");
    const exits = new TerminalExitRecorder({ directory: exitDirectory });
    await exits.prepare();
    let now = Date.parse("2026-11-22T12:00:00Z");
    const store = new TerminalWorkspaceStore({ homePath, now: () => new Date(now) });
    const zellij = new HoldingZellij();
    const runtime = new TerminalRuntime({ store, zellij, exits, recordedReconcileMs: 5 * 60_000 });
    const workspace = await runtime.ensureWorkspace({ projectId: "app" });
    await runtime.sweepHeldPaneExits();

    // The exit directory becomes unavailable while the program runs and exits.
    zellij.beforeRun = async () => {
      await rm(exitDirectory, { recursive: true, force: true });
      await writeFile(exitDirectory, "not a directory");
    };
    const tab = await runtime.createTab(workspace.id, { name: "tests", cwd: "", command: ["sh", "-c", "exit 7"] });
    expect(zellij.held.get((await store.getRuntimeWorkspace(workspace.id))!.zellijSessionName)?.[0]?.exitCode).toBe(7);

    // Storage comes back; there is no record to read.
    await rm(exitDirectory, { force: true });
    await exits.prepare();
    await runtime.sweepRecordedExits();
    zellij.listCalls = 0;
    await runtime.sweepHeldPaneExits();
    // Still quiet between reconciling passes.
    expect(zellij.listCalls).toBe(0);
    expect((await store.getRuntimeWorkspace(workspace.id))!.tabs[tab.id]!.status).toBe("running");

    now += 5 * 60_000;
    await runtime.sweepRecordedExits();
    await runtime.sweepHeldPaneExits();
    expect(zellij.listCalls).toBe(1);
    expect((await store.getRuntimeWorkspace(workspace.id))!.tabs[tab.id]).toMatchObject({ status: "exited", exitCode: 7 });
  });
});

describe("an unusable exit directory at launch", () => {
  it("starts the command anyway, to be noticed by the held-pane sweep", async () => {
    const homePath = await tempDir();
    const exitDirectory = join(homePath, "exits");
    const exits = new TerminalExitRecorder({ directory: exitDirectory });
    await exits.prepare();
    await rm(exitDirectory, { recursive: true, force: true });
    await writeFile(exitDirectory, "not a directory");
    const store = new TerminalWorkspaceStore({ homePath });
    const zellij = new RecordingZellij();
    const runtime = new TerminalRuntime({ store, zellij, exits });
    const workspace = await runtime.ensureWorkspace({ projectId: "app" });
    const tab = await runtime.createTab(workspace.id, { name: "tests", cwd: "", command: ["bun", "test"] });
    expect(zellij.commands.at(-1)).toEqual(["bun", "test"]);
    expect((await store.getRuntimeWorkspace(workspace.id))!.tabs[tab.id]).toMatchObject({ status: "running", exitRecorded: false });
  });
});

// Fault detected (Greptile, #3542): an unusable exit directory at startup stopped the whole terminal service.
describe("an unusable exit directory at startup", () => {
  it("is logged instead of stopping the service", async () => {
    const homePath = await tempDir();
    const exitDirectory = join(homePath, "exits");
    await writeFile(exitDirectory, "not a directory");
    const exits = new TerminalExitRecorder({ directory: exitDirectory });
    await expect(exits.prepare()).rejects.toThrow();
    await expect(exits.prepareForStartup()).resolves.toBe(false);
    await rm(exitDirectory);
    await expect(exits.prepareForStartup()).resolves.toBe(true);
  });
});
