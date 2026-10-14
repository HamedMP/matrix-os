import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";
import { TerminalRuntime, type ZellijObserverEvent, type ZellijRuntimeAdapter } from "../../packages/terminal-runtime/src/runtime.js";
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
      expect((await store.getTab(ref))?.activityAt).toBe("2026-10-14T10:02:00.000Z");
      advance();
      await runtime.writeInput(ref, "echo remote\r");
      const accepted = await store.getTab(ref);
      expect(accepted?.activityAt).toBe("2026-10-14T10:03:00.000Z");
      advance();
      failInput = true;
      await expect(runtime.writeInput(ref, "rejected\r")).rejects.toThrow("write failed");
      expect((await store.getTab(ref))?.activityAt).toBe(accepted?.activityAt);
      failInput = false;
      vi.spyOn(store, "recordInputActivity").mockRejectedValueOnce(new Error("disk unavailable"));
      await expect(runtime.writeInput(ref, "already delivered\r")).resolves.toBeUndefined();
      expect((await store.getTab(ref))?.activityAt).toBe(accepted?.activityAt);
      await viewer.detach();
    } finally { await runtime.shutdown(); }
  });
});
