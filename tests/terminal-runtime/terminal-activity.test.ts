import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";
import { TerminalRuntime, type ZellijObserverEvent, type ZellijRuntimeAdapter } from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalRuntimeSocketClient } from "../../packages/terminal-runtime/src/socket-client.js";
import { TerminalRuntimeSocketServer } from "../../packages/terminal-runtime/src/socket-server.js";
import { isTerminalOutputActivity } from "../../packages/terminal-runtime/src/terminal-activity.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "terminal-activity-"));
  homes.push(homePath);
  let now = new Date("2026-10-14T10:00:00Z");
  const store = new TerminalWorkspaceStore({ homePath, now: () => now });
  const workspace = await store.ensureWorkspace();
  const tab = await store.createTab(workspace.id, { name: "idle", cwd: "" });
  const ref = { workspaceId: workspace.id, tabId: tab.id };
  return { homePath, store, ref, tab, advance: () => { now = new Date(now.getTime() + 60_000); } };
}

const screen = { ansi: "ready$ ", viewport: ["ready$ "], scrollback: [] };

describe("terminal activity timestamps", () => {
  it("keeps the process alive while shutdown drains the last coalesced activity", async () => {
    const recorderUrl = new URL("../../packages/terminal-runtime/src/input-activity-recorder.ts", import.meta.url).href;
    const script = `
      import { InputActivityRecorder } from ${JSON.stringify(recorderUrl)};
      const written = [];
      let sequence = 0;
      const recorder = new InputActivityRecorder(() => String(++sequence), async (at) => { written.push(at); });
      recorder.mark();
      await recorder.flush();
      recorder.mark();
      await recorder.flush();
      process.stdout.write(JSON.stringify(written));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import=tsx", "--input-type=module", "-e", script], {
      timeout: 5_000,
      maxBuffer: 4_096,
    });
    expect(JSON.parse(stdout)).toEqual(["1", "2"]);
  });

  it("delivers later input while activity persistence is blocked, and coalesces pending timestamps", async () => {
    const { store, ref, advance } = await fixture();
    await store.activateTab(ref, { tabId: 1, paneId: "terminal_1" });
    const delivered: string[] = [];
    const gate = Promise.withResolvers<void>();
    const original = store.recordInputActivity.bind(store);
    const recorded = vi.spyOn(store, "recordInputActivity").mockImplementationOnce(async (...args) => { await gate.promise; await original(...args); });
    const runtime = new TerminalRuntime({ store, zellij: {
      ensureSession: async () => undefined, createTab: async () => ({ tabId: 1, paneId: "terminal_1" }),
      openAttachment: async () => ({ write: async (data) => { delivered.push(new TextDecoder().decode(data)); }, resize: async () => undefined, close: async () => undefined }),
    } });
    let first: Promise<void> | undefined; let second: Promise<void> | undefined;
    try {
      const viewer = await runtime.attach(ref, { viewerId: "slow-disk", send: () => undefined, size: { cols: 120, rows: 36 } });
      advance(); first = viewer.write("a");
      await vi.waitFor(() => expect(recorded).toHaveBeenCalledTimes(1));
      advance(); second = viewer.write("b");
      await vi.waitFor(() => expect(delivered).toEqual(["a", "b"]), { timeout: 400 });
      advance(); await viewer.write("c");
      expect(recorded).toHaveBeenCalledTimes(1);
      // Persistence completes later than the input: it must retain the captured input time.
      advance(); gate.resolve();
      await Promise.all([first, second]);
      await runtime.shutdown();
      expect(recorded).toHaveBeenCalledTimes(2);
      expect((await store.getTab(ref))?.activityAt).toBe("2026-10-14T10:03:00.000Z");
    } finally { gate.resolve(); await Promise.all([first, second]); await runtime.shutdown(); }
  });

  it("delivers automatic replies without activity and records identical user bytes", async () => {
    const { store, ref, tab, advance } = await fixture();
    await store.activateTab(ref, { tabId: 1, paneId: "terminal_1" });
    const delivered: string[] = [];
    const runtime = new TerminalRuntime({ store, zellij: {
      ensureSession: async () => undefined, createTab: async () => ({ tabId: 1, paneId: "terminal_1" }),
      openAttachment: async () => ({ write: async (data) => { delivered.push(new TextDecoder().decode(data)); }, resize: async () => undefined, close: async () => undefined }),
      writeToPane: async (_session, _pane, data) => { delivered.push(new TextDecoder().decode(data)); },
    } });
    const socketHome = await mkdtemp("/tmp/terminal-provenance-"); homes.push(socketHome);
    const socketPath = join(socketHome, "r.sock");
    const server = new TerminalRuntimeSocketServer({ socketPath, runtime });
    let stream: ReturnType<TerminalRuntimeSocketClient["attach"]> | undefined;
    try {
      await server.start();
      const ready = Promise.withResolvers<void>();
      stream = new TerminalRuntimeSocketClient({ socketPath }).attach({ ref, viewerId: "provenance", mode: "soft", size: { cols: 120, rows: 36 },
        onFrame: (frame) => { if (frame.type === "attached") { expect(frame.capabilities).toContain("input-activity-v1"); ready.resolve(); } },
        onError: ready.reject, onClose: () => undefined });
      await ready.promise;
      advance(); stream.send({ type: "input", terminalRef: ref, data: "\x1b[1;2R", isUserInput: false });
      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      expect((await store.getTab(ref))?.activityAt).toBe(tab.activityAt);
      advance(); stream.send({ type: "input", terminalRef: ref, data: "\x1b[1;2R", isUserInput: true });
      await vi.waitFor(async () => expect((await store.getTab(ref))?.activityAt).toBe("2026-10-14T10:02:00.000Z"));
      advance(); await runtime.writeInput(ref, "direct\r");
      await runtime.flushInputActivity();
      expect((await store.getTab(ref))?.activityAt).toBe("2026-10-14T10:03:00.000Z");
      expect(delivered).toEqual(["\x1b[1;2R", "\x1b[1;2R", "direct\r"]);
    } finally { stream?.close(); await server.close(); await runtime.shutdown(); }
  });

  it.each([
    { ansi: "changed", viewport: screen.viewport, scrollback: [] },
    { ...screen, viewport: ["changed"] },
    { ...screen, viewport: [] },
    { ...screen, scrollback: ["history"] },
  ])("recognizes changed screen content %#", (next) => {
    expect(isTerminalOutputActivity(screen, next)).toBe(true);
    expect(isTerminalOutputActivity(next, { ...next, viewport: [...next.viewport], scrollback: [...next.scrollback] })).toBe(false);
  });

  it("does not turn an imported historical snapshot into fresh activity", async () => {
    const { store, ref, tab, advance } = await fixture();
    advance();
    await store.importSnapshot(ref, { ...screen, seq: 12 });
    expect((await store.getTab(ref))?.activityAt).toBe(tab.createdAt);
  });
  it("preserves activity across runtime activation, polling and UI bookkeeping", async () => {
    const { store, ref, tab, advance } = await fixture();
    expect(tab.activityAt).toBe(tab.createdAt);
    advance();
    const activated = await store.activateTab(ref, { tabId: 1, paneId: "terminal_1" });
    advance();
    await store.updateTabUiState(ref, { pinned: true, lastSeenSeq: 7, baseRevision: activated.revision });
    advance();
    await store.activateTab(ref, { tabId: 1, paneId: "terminal_1" });
    await store.updateCanonicalSize(ref.workspaceId, { cols: 140, rows: 40 });
    expect((await store.listWorkspaces())[0]?.tabs[0]?.activityAt).toBe(tab.createdAt);
    expect((await store.getTab(ref))?.updatedAt).not.toBe(tab.createdAt);
  });

  it("does not treat initial replay or identical checkpoints as output activity", async () => {
    const { store, ref, tab, advance } = await fixture();
    advance();
    await store.checkpointTab(ref, { ...screen, isInitial: true });
    advance();
    await store.checkpointTab(ref, screen);
    expect((await store.getTab(ref))?.activityAt).toBe(tab.createdAt);
    advance();
    await store.checkpointTab(ref, { ansi: "done", viewport: ["done"], scrollback: [] });
    const changed = await store.getTab(ref);
    expect(changed?.activityAt).toBe("2026-10-14T10:03:00.000Z");
    advance();
    await store.checkpointTab(ref, { ansi: "different replay", viewport: ["different replay"], scrollback: [], isInitial: true });
    expect((await store.getTab(ref))?.activityAt).toBe(changed?.activityAt);
    expect((await new TerminalWorkspaceStore({ homePath: homes.at(-1)! }).getTab(ref))?.activityAt).toBe(changed?.activityAt);
  });

  it("keeps legacy activity unknown rather than copying polluted metadata timestamps", async () => {
    const { homePath, store, ref, advance } = await fixture();
    const path = join(homePath, "system", "terminal-workspaces.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    delete state.workspaces[ref.workspaceId].tabs[ref.tabId].activityAt;
    await writeFile(path, JSON.stringify(state));
    advance();
    await store.activateTab(ref, { tabId: 1, paneId: "terminal_1" });
    await store.checkpointTab(ref, { ...screen, isInitial: true });
    expect((await store.getTab(ref))?.activityAt).toBeUndefined();
    advance();
    await store.checkpointTab(ref, { ansi: "new output", viewport: ["new output"], scrollback: [] });
    expect((await store.getTab(ref))?.activityAt).toBe("2026-10-14T10:02:00.000Z");
  });

  it("preserves idle tabs through restore and heartbeat, and records only successful input", async () => {
    const { store, ref, tab, advance } = await fixture();
    await store.activateTab(ref, { tabId: 1, paneId: "terminal_1" });
    let emit!: (event: ZellijObserverEvent) => void;
    let failInput = false;
    const write = async () => { if (failInput) throw new Error("write failed"); };
    const zellij: ZellijRuntimeAdapter = {
      ensureSession: async () => undefined,
      createTab: async () => ({ tabId: 1, paneId: "terminal_1" }),
      findTabByInternalName: async () => ({ tabId: 1, paneId: "terminal_1" }),
      openAttachment: async () => ({ write, resize: async () => undefined, close: async () => undefined }),
      writeToPane: write,
      subscribeWorkspace: async (_name, input) => { emit = input.onEvent; return { close: async () => undefined }; },
    };
    const runtime = new TerminalRuntime({ store, zellij });
    try {
      advance();
      await runtime.restoreAll();
      emit({ type: "pane-update", paneId: "terminal_1", ...screen, isInitial: true });
      await runtime.flushCheckpoints();
      const viewer = await runtime.attach(ref, { viewerId: "viewer", send: () => undefined, size: { cols: 120, rows: 36 } });
      advance();
      viewer.touch();
      expect((await runtime.listWorkspaces())[0]?.tabs[0]?.activityAt).toBe(tab.createdAt);
      await viewer.write("echo hello\r");
      await runtime.flushInputActivity();
      expect((await store.getTab(ref))?.activityAt).toBe("2026-10-14T10:02:00.000Z");
      advance();
      await runtime.writeInput(ref, "echo remote\r");
      await runtime.flushInputActivity();
      const accepted = await store.getTab(ref);
      expect(accepted?.activityAt).toBe("2026-10-14T10:03:00.000Z");
      advance();
      failInput = true;
      await expect(runtime.writeInput(ref, "rejected\r")).rejects.toThrow("write failed");
      expect((await store.getTab(ref))?.activityAt).toBe(accepted?.activityAt);
      failInput = false;
      vi.spyOn(store, "recordInputActivity").mockRejectedValueOnce(new Error("disk unavailable"));
      await expect(runtime.writeInput(ref, "already delivered\r")).resolves.toBeUndefined();
      await runtime.flushInputActivity();
      expect((await store.getTab(ref))?.activityAt).toBe(accepted?.activityAt);
      await viewer.detach();
    } finally { await runtime.shutdown(); }
  });
});
