import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TerminalRuntime,
  type ZellijObserver,
  type ZellijObserverEvent,
  type ZellijRuntimeAdapter,
} from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";

const homes: string[] = [];
const runtimes: TerminalRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  vi.useRealTimers();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

// Process boundary: the adapter independently reports child liveness; real
// runtime/store code must recover the current pane set and persist its output.
class ObserverZellij implements ZellijRuntimeAdapter {
  readonly panes = new Map<string, { tabId: number; paneId: string }>();
  readonly subscriptions: Array<{
    paneIds: string[];
    closed: boolean;
    emit: (event: ZellijObserverEvent) => void;
  }> = [];
  nextSessionPause?: { started: () => void; wait: Promise<void> };
  private nextId = 1;

  async ensureSession(): Promise<void> {
    const pause = this.nextSessionPause;
    this.nextSessionPause = undefined;
    if (pause) {
      pause.started();
      await pause.wait;
    }
  }
  async createTab(_session: string, input: { internalName: string }) {
    const tabId = this.nextId++;
    const ids = { tabId, paneId: `terminal_${tabId}` };
    this.panes.set(input.internalName, ids);
    return ids;
  }
  async findTabByInternalName(_session: string, internalName: string) {
    return this.panes.get(internalName);
  }
  async openAttachment(): Promise<never> {
    throw new Error("Observer recovery must not open a viewer attachment");
  }
  async subscribeWorkspace(_session: string, input: {
    paneIds: string[];
    onEvent: (event: ZellijObserverEvent) => void;
  }): Promise<ZellijObserver> {
    const child = { paneIds: input.paneIds, closed: false, emit: input.onEvent };
    this.subscriptions.push(child);
    return {
      get closed() { return child.closed; },
      close: async () => { child.closed = true; },
    };
  }
}

async function setup() {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-observer-recovery-"));
  homes.push(homePath);
  const store = new TerminalWorkspaceStore({ homePath });
  const zellij = new ObserverZellij();
  const runtime = new TerminalRuntime({ store, zellij });
  runtimes.push(runtime);
  const workspace = await runtime.ensureWorkspace();
  return { homePath, store, zellij, runtime, workspace };
}

describe("workspace observer recovery", () => {
  it("restores only live panes while preserving the exited tab's historical pane ID", async () => {
    const { homePath, store, zellij, runtime, workspace } = await setup();
    const gone = await runtime.createTab(workspace.id, { name: "gone", cwd: "" });
    await runtime.createTab(workspace.id, { name: "live", cwd: "" });
    const before = (await store.getRuntimeWorkspace(workspace.id))!;
    await runtime.shutdown();
    zellij.panes.delete(before.tabs[gone.id]!.zellijTabName);
    const restarted = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
    runtimes.push(restarted);

    await restarted.restoreAll();

    expect(zellij.subscriptions.at(-1)?.paneIds).toEqual(["terminal_2"]);
    expect((await store.getRuntimeWorkspace(workspace.id))?.tabs[gone.id]).toMatchObject({
      status: "exited", zellijPaneId: "terminal_1",
    });
  });

  it("reconciles an unexpectedly closed observer and resumes durable background snapshots", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { store, zellij, runtime, workspace } = await setup();
    const gone = await runtime.createTab(workspace.id, { name: "gone", cwd: "" });
    const live = await runtime.createTab(workspace.id, { name: "live", cwd: "" });
    const before = (await store.getRuntimeWorkspace(workspace.id))!;
    const failed = zellij.subscriptions.at(-1)!;
    failed.closed = true; // Child exits after subscribeWorkspace has returned.
    zellij.panes.delete(before.tabs[gone.id]!.zellijTabName);

    await vi.advanceTimersByTimeAsync(30_000);
    await expect.poll(() => zellij.subscriptions.length).toBe(3);

    const replacement = zellij.subscriptions.at(-1)!;
    expect(replacement.paneIds).toEqual(["terminal_2"]);
    replacement.emit({
      type: "pane-update", paneId: "terminal_2", ansi: "build resumed",
      viewport: ["build resumed"], scrollback: ["before disconnect"],
    });
    await runtime.flushCheckpoints();
    expect(await runtime.getSnapshot({ workspaceId: workspace.id, tabId: live.id })).toMatchObject({
      ansi: "build resumed", scrollback: ["before disconnect"],
    });
    expect((await store.getRuntimeWorkspace(workspace.id))?.tabs[gone.id]?.status).toBe("exited");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(zellij.subscriptions).toHaveLength(3);
  });

  it("does not respawn a dead observer when shutdown overtakes a queued recovery", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { store, zellij, runtime, workspace } = await setup();
    const tab = await runtime.createTab(workspace.id, { name: "live", cwd: "" });
    zellij.subscriptions.at(-1)!.closed = true;

    // Hold a normal admitted read on the existing workspace mutation chain.
    // The sweep queues recovery behind it, then shutdown revokes admission.
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const readWorkspace = store.getRuntimeWorkspace.bind(store);
    vi.spyOn(store, "getRuntimeWorkspace").mockImplementationOnce(async (workspaceId) => {
      blocked.resolve();
      await release.promise;
      return readWorkspace(workspaceId);
    });
    const reading = runtime.getSnapshot({ workspaceId: workspace.id, tabId: tab.id }, tab.incarnation);
    await blocked.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    const shuttingDown = runtime.shutdown();
    release.resolve();
    await Promise.all([reading, shuttingDown]);

    expect(zellij.subscriptions).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(zellij.subscriptions).toHaveLength(1);
  });

  it("does not respawn after shutdown begins during native pane reconciliation", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { zellij, runtime, workspace } = await setup();
    await runtime.createTab(workspace.id, { name: "live", cwd: "" });
    zellij.subscriptions.at(-1)!.closed = true;
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    zellij.nextSessionPause = { started: () => blocked.resolve(), wait: release.promise };
    await vi.advanceTimersByTimeAsync(30_000);
    await blocked.promise;

    const shuttingDown = runtime.shutdown();
    release.resolve();
    await shuttingDown;

    expect(zellij.subscriptions).toHaveLength(1);
  });
});
