import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  private nextTabId = 1;
  async ensureSession(): Promise<void> { /* sessions are implicit */ }
  async createTab(_session: string, input: { internalName: string; command?: string[] }) {
    this.commands.push(input.command);
    const tabId = this.nextTabId++;
    return { tabId, paneId: `terminal_${tabId}` };
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
});
