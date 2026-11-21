import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
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
    expect((await readdir(directory)).sort()).toEqual([`matrix-tab-${"f".repeat(32)}.tmp`]);
    expect(await readFile(target, "utf8")).toBe("x");
    await recorder.clear(`matrix-tab-${"f".repeat(32)}`);
    expect(await readdir(directory)).toEqual([]);
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
    expect(zellij.listCalls).toBe(0);
  });
});
