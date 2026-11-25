import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createTerminalEventHub, type TerminalEventFrame } from "../../packages/gateway/src/terminal-agent/events.js";
import { createTerminalAgentStatusSource } from "../../packages/gateway/src/terminal-agent/status-source.js";
import { createTerminalSeenStore } from "../../packages/gateway/src/terminal-agent/seen-store.js";
import { EMPTY_TERMINAL_EVENTS_STATE, reduceTerminalEvents } from "../../packages/ui/src/terminal-agents/index.js";
import { computerSidebarRows, terminalStatusSections } from "../../packages/ui/src/terminal-status-sidebar/index.js";

// Spec 2706 end-to-end checkpoint (layer 4, before the sidebar is wired in): a
// command tab's exit travels from the real wrapper through the runtime store
// and `/ws/terminal/events` into the sidebar model's Done section, with no
// Zellij call while it runs, including across a runtime restart.

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

/** Zellij stand-in that really runs the command it is given (the recorder's `/bin/sh` wrapper). */
class RunningZellij implements ZellijRuntimeAdapter {
  listCalls = 0;
  readonly running: Array<Promise<number | null>> = [];
  readonly existing = new Map<string, { tabId: number; paneId: string }>();
  private nextTabId = 1;
  constructor(private readonly runCommands = true) {}
  async ensureSession(): Promise<void> { /* implicit */ }
  async createTab(_session: string, input: { internalName: string; command?: string[] }) {
    const tabId = this.nextTabId++;
    if (this.runCommands && input.command) {
      const [program, ...args] = input.command;
      const child = spawn(program!, args, { stdio: "ignore" });
      this.running.push(new Promise((resolve) => child.on("exit", (code) => resolve(code))));
    }
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
  async subscribeWorkspace(): Promise<ZellijObserver> { return { close: async () => undefined }; }
  async listHeldPaneExits() {
    this.listCalls += 1;
    return [];
  }
}

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "matrix-exit-checkpoint-"));
  homes.push(dir);
  return dir;
}

function stream(runtime: TerminalRuntime) {
  const hub = createTerminalEventHub({
    runtime,
    status: createTerminalAgentStatusSource({ runtime: {} }),
    seen: createTerminalSeenStore({ path: null }),
    autoStart: false,
  });
  const frames: TerminalEventFrame[] = [];
  hub.subscribe({ send: (frame) => { frames.push(frame); }, close: () => undefined });
  return { hub, frames };
}

const machine = { id: "computer:primary", name: "Main", remote: true };
function sidebar(frames: TerminalEventFrame[]) {
  const state = frames.reduce((current, frame) => reduceTerminalEvents(current, JSON.parse(JSON.stringify(frame))), EMPTY_TERMINAL_EVENTS_STATE);
  return terminalStatusSections(computerSidebarRows(state, machine)).map((section) => [section.id, section.rows.map((row) => row.name)]);
}

describe("command tab exit, end to end", () => {
  it("records exit code 4 from the wrapper, streams it, and files the tab under Done", async () => {
    const homePath = await home();
    const exits = new TerminalExitRecorder({ directory: join(homePath, "exits") });
    await exits.prepare();
    const store = new TerminalWorkspaceStore({ homePath });
    const zellij = new RunningZellij();
    const runtime = new TerminalRuntime({ store, zellij, exits });
    const workspace = await runtime.ensureWorkspace({});
    const { hub, frames } = stream(runtime);

    const tab = await runtime.createTab(workspace.id, { name: "tests", cwd: "", command: ["/bin/sh", "-c", "exit 4"] });
    await hub.tick();
    expect(sidebar(frames)).toEqual([["idle", ["tests"]]]);

    expect(await zellij.running[0]).toBe(4);
    await vi.waitFor(async () => {
      await runtime.sweepRecordedExits();
      expect((await store.getRuntimeWorkspace(workspace.id))!.tabs[tab.id]!.status).toBe("exited");
    });
    await runtime.sweepHeldPaneExits();
    expect(zellij.listCalls).toBe(0);
    expect((await store.getRuntimeWorkspace(workspace.id))!.tabs[tab.id]!.exitCode).toBe(4);

    await hub.tick();
    expect(frames).toContainEqual(expect.objectContaining({
      type: "event", event: { kind: "finished", ref: { workspaceId: workspace.id, tabId: tab.id }, exitCode: 4 },
    }));
    expect(sidebar(frames)).toEqual([["done", ["tests"]]]);
  });

  it("records an exit written while the runtime was down on the first sweep after restart", async () => {
    const homePath = await home();
    const directory = join(homePath, "exits");
    const firstExits = new TerminalExitRecorder({ directory });
    await firstExits.prepare();
    const first = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij: new RunningZellij(false), exits: firstExits });
    const workspace = await first.ensureWorkspace({});
    const tab = await first.createTab(workspace.id, { name: "agent", cwd: "", command: ["claude"] });
    await first.shutdown();

    // The program exits while nothing is running: only its file says so.
    const store = new TerminalWorkspaceStore({ homePath });
    const saved = (await store.getRuntimeWorkspace(workspace.id))!.tabs[tab.id]!;
    await writeFile(join(directory, saved.zellijTabName), "4\n");

    const zellij = new RunningZellij(false);
    zellij.existing.set(saved.zellijTabName, { tabId: 3, paneId: "terminal_3" });
    const runtime = new TerminalRuntime({ store, zellij, exits: new TerminalExitRecorder({ directory }) });
    await runtime.restoreAll();
    const { hub, frames } = stream(runtime);
    await hub.tick();

    await runtime.sweepRecordedExits();
    expect((await store.getRuntimeWorkspace(workspace.id))!.tabs[tab.id]).toMatchObject({ status: "exited", exitCode: 4 });
    await hub.tick();
    expect(frames).toContainEqual(expect.objectContaining({
      type: "event", event: { kind: "finished", ref: { workspaceId: workspace.id, tabId: tab.id }, exitCode: 4 },
    }));
    expect(sidebar(frames)).toEqual([["done", ["agent"]]]);
    expect(zellij.listCalls).toBe(0);
  });
});
