import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { TerminalWorkspaceStore as PreStackStore } from "./fixtures/pre-2706-workspace-store.js";

// Fault detected (review of #3540 and #3542): spec 2706's launch facts were
// saved in the strict schemaVersion 2 workspace file, so after a host-bundle
// rollback (which keeps the owner's home) the previous runtime rejected the
// whole file and terminals became unreachable. Launch facts now live in a
// separate file the previous reader never opens.

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

class TabsZellij implements ZellijRuntimeAdapter {
  private nextTabId = 1;
  async ensureSession(): Promise<void> { /* implicit */ }
  async createTab() {
    const tabId = this.nextTabId++;
    return { tabId, paneId: `terminal_${tabId}` };
  }
  async openAttachment(): Promise<ZellijAttachment> {
    return { write: async () => undefined, resize: async () => undefined, close: async () => undefined };
  }
  async subscribeWorkspace(): Promise<ZellijObserver> { return { close: async () => undefined }; }
  async listHeldPaneExits() { return []; }
}

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "matrix-state-rollback-"));
  homes.push(dir);
  return dir;
}

const statePath = (homePath: string) => join(homePath, "system", "terminal-workspaces.json");

/** A shell and a command tab, activated by the current runtime. */
async function writeWithCurrentRuntime(homePath: string) {
  const store = new TerminalWorkspaceStore({ homePath });
  const runtime = new TerminalRuntime({ store, zellij: new TabsZellij() });
  const workspace = await runtime.ensureWorkspace({ projectId: "app" });
  const shell = await runtime.createTab(workspace.id, { name: "shell", cwd: "" });
  const command = await runtime.createTab(workspace.id, { name: "tests", cwd: "", command: ["bun", "test"] });
  await runtime.flushCheckpoints();
  return { store, workspace, shell, command };
}

describe("terminal workspace state across a rollback", () => {
  it("is read by the pre-stack runtime after the current one activated tabs", async () => {
    const homePath = await home();
    const { workspace, shell, command } = await writeWithCurrentRuntime(homePath);
    const saved = JSON.parse(await readFile(statePath(homePath), "utf8"));
    expect(JSON.stringify(saved)).not.toMatch(/heldOnExit|exitRecorded/);

    const previous = new PreStackStore({ homePath });
    const listed = await previous.listWorkspaces();
    expect(listed.find((entry) => entry.id === workspace.id)?.tabs.map((tab) => tab.id).sort()).toEqual([shell.id, command.id].sort());
  });

  it("keeps launch facts when the pre-stack runtime rewrites the state, and reads its state as older state", async () => {
    const homePath = await home();
    const { workspace, shell, command } = await writeWithCurrentRuntime(homePath);
    // The rolled-back runtime changes something and writes the whole file.
    const previous = new PreStackStore({ homePath });
    await previous.renameTab({ workspaceId: workspace.id, tabId: shell.id }, { name: "renamed", baseRevision: shell.revision });

    const current = new TerminalWorkspaceStore({ homePath });
    const tabs = (await current.getRuntimeWorkspace(workspace.id))!.tabs;
    expect(tabs[shell.id]).toMatchObject({ name: "renamed", heldOnExit: false });
    expect(tabs[command.id]).toMatchObject({ heldOnExit: true });
  });

  it("reads pre-stack state, with no launch facts, as tabs that may be held", async () => {
    const homePath = await home();
    const previous = new PreStackStore({ homePath });
    const workspace = await previous.ensureWorkspace({ projectId: "app" });
    expect(workspace.id).toMatch(/^tws_/);
    const current = new TerminalWorkspaceStore({ homePath });
    const runtimeWorkspace = await current.getRuntimeWorkspace(workspace.id);
    expect(runtimeWorkspace?.id).toBe(workspace.id);
  });

  it("moves facts an earlier build saved in the state file out of it on the next write", async () => {
    const homePath = await home();
    const { store, workspace, shell } = await writeWithCurrentRuntime(homePath);
    const saved = JSON.parse(await readFile(statePath(homePath), "utf8"));
    saved.workspaces[workspace.id].tabs[shell.id].heldOnExit = false;
    await writeFile(statePath(homePath), JSON.stringify(saved));
    expect((await store.getRuntimeWorkspace(workspace.id))!.tabs[shell.id]!.heldOnExit).toBe(false);

    await store.renameTab({ workspaceId: workspace.id, tabId: shell.id }, { name: "again", baseRevision: shell.revision });
    expect(await readFile(statePath(homePath), "utf8")).not.toMatch(/heldOnExit/);
    await expect(new PreStackStore({ homePath }).listWorkspaces()).resolves.toBeTruthy();
    expect((await store.getRuntimeWorkspace(workspace.id))!.tabs[shell.id]!.heldOnExit).toBe(false);
  });

  it("treats an unreadable launch facts file as older state instead of failing", async () => {
    const homePath = await home();
    const { workspace, shell } = await writeWithCurrentRuntime(homePath);
    await writeFile(join(homePath, "system", "terminal-workspaces", "launch-facts.json"), "{not json");
    const current = new TerminalWorkspaceStore({ homePath });
    expect((await current.getRuntimeWorkspace(workspace.id))!.tabs[shell.id]!.heldOnExit).toBeUndefined();
  });
});
