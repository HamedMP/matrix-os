import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalRuntime, type ZellijRuntimeAdapter } from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";
import { TerminalRuntimeSocketServer } from "../../packages/terminal-runtime/src/socket-server.js";
import { TerminalRuntimeSocketClient } from "../../packages/terminal-runtime/src/socket-client.js";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
import { ZellijCliRuntimeAdapter } from "../../packages/terminal-runtime/src/zellij-adapter.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function harness() {
  const home = await createUnixSocketTempDir(); cleanup.push(() => rm(home, { recursive: true, force: true }));
  const store = new TerminalWorkspaceStore({ homePath: home });
  const workspace = await store.ensureWorkspace();
  const initial = await store.createTab(workspace.id, { name: "provider-auth-original", cwd: "", agent: { providerId: "codex" } });
  const ref = { workspaceId: workspace.id, tabId: initial.id };
  const tab = await store.activateTab(ref, { tabId: 3, paneId: "terminal_2" });
  const adapter = {
    findTabByInternalNameReadOnly: vi.fn<NonNullable<ZellijRuntimeAdapter["findTabByInternalNameReadOnly"]>>(async () => ({ tabId: 3, paneId: "terminal_2" })),
    getCommandState: vi.fn<NonNullable<ZellijRuntimeAdapter["getCommandState"]>>(async () => "exited"),
    renameTab: vi.fn(), closeTab: vi.fn(), deleteSession: vi.fn(), createTab: vi.fn(),
  } as unknown as ZellijRuntimeAdapter & { findTabByInternalNameReadOnly: ReturnType<typeof vi.fn>; getCommandState: ReturnType<typeof vi.fn>;
    renameTab: ReturnType<typeof vi.fn>; closeTab: ReturnType<typeof vi.fn>; createTab: ReturnType<typeof vi.fn> };
  const runtime = new TerminalRuntime({ store, zellij: adapter }); cleanup.push(() => runtime.shutdown());
  const input = { name: "provider-auth-ended-history", expectedName: tab.name, providerId: "codex" as const,
    expectedIncarnation: tab.incarnation!, baseRevision: tab.revision };
  return { home, store, runtime, ref, tab, input, adapter };
}

describe("atomic ended Terminal archive", () => {
  it("reads an exact managed identity without renaming an owner pane title", async () => {
    const internalName = "matrix-tab-00000000000000000000000000000001";
    const run = vi.fn(async (args: string[]) => args.includes("list-tabs")
      ? JSON.stringify([{ tab_id: 3, name: internalName }])
      : JSON.stringify([{ id: 2, tab_id: 3, is_plugin: false, pane_title: "Owner title" }]));
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix/home", run });
    await expect(adapter.findTabByInternalNameReadOnly("matrix-w-00000000000000000000000000000001", internalName))
      .resolves.toEqual({ tabId: 3, paneId: "terminal_2" });
    expect(run.mock.calls.every(([args]) => args.includes("list-tabs") || args.includes("list-panes"))).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("requires positive structured absence and rejects duplicate managed tabs or multiple panes", async () => {
    const name = "matrix-tab-00000000000000000000000000000001";
    const session = "matrix-w-00000000000000000000000000000001";
    const run = vi.fn().mockResolvedValueOnce("[]");
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix/home", run });
    await expect(adapter.findTabByInternalNameReadOnly(session, name)).resolves.toBeUndefined();
    run.mockResolvedValueOnce(JSON.stringify([{ tab_id: 3, name }, { tab_id: 4, name }]));
    await expect(adapter.findTabByInternalNameReadOnly(session, name)).rejects.toThrow();
    run.mockResolvedValueOnce(JSON.stringify([{ tab_id: 3, name }])).mockResolvedValueOnce(JSON.stringify([
      { id: 2, tab_id: 3, is_plugin: false }, { id: 4, tab_id: 3, is_plugin: false },
    ]));
    await expect(adapter.findTabByInternalNameReadOnly(session, name)).rejects.toMatchObject({ code: "unavailable" });
    run.mockResolvedValueOnce(JSON.stringify([{ tab_id: 3, name }])).mockResolvedValueOnce("[]");
    await expect(adapter.findTabByInternalNameReadOnly(session, name)).resolves.toBeUndefined();
  });

  it("does not infer absence from a changed managed name while its stored tab or pane ID remains present", async () => {
    const name = "matrix-tab-00000000000000000000000000000001";
    const session = "matrix-w-00000000000000000000000000000001";
    const run = vi.fn().mockResolvedValueOnce(JSON.stringify([{ tab_id: 3, name: "Owner display name" }]))
      .mockResolvedValueOnce(JSON.stringify([{ id: 2, tab_id: 3, is_plugin: false }]));
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix/home", run });
    await expect(adapter.findTabByInternalNameReadOnly(session, name, { tabId: 3, paneId: "terminal_2" }))
      .rejects.toMatchObject({ code: "conflict" });
    run.mockResolvedValueOnce("[]").mockResolvedValueOnce(JSON.stringify([{ id: 2, tab_id: 9, is_plugin: false }]));
    await expect(adapter.findTabByInternalNameReadOnly(session, name, { tabId: 3, paneId: "terminal_2" }))
      .rejects.toMatchObject({ code: "conflict" });
    run.mockResolvedValueOnce(JSON.stringify([{ tab_id: 3, name }]))
      .mockResolvedValueOnce(JSON.stringify([{ id: 2, tab_id: 9, is_plugin: false }]));
    await expect(adapter.findTabByInternalNameReadOnly(session, name, { tabId: 3, paneId: "terminal_2" }))
      .rejects.toMatchObject({ code: "conflict" });
    run.mockResolvedValueOnce("[]").mockResolvedValueOnce("[]");
    await expect(adapter.findTabByInternalNameReadOnly(session, name, { tabId: 3, paneId: "terminal_2" })).resolves.toBeUndefined();
  });

  it("renames only public metadata for an exact held-ended tab and preserves immutable runtime identity", async () => {
    const h = await harness();
    const before = (await h.store.getRuntimeWorkspace(h.ref.workspaceId))!.tabs[h.ref.tabId]!;
    const snapshot = await h.store.importSnapshot(h.ref, { ansi: "retained login output", viewport: ["retained login output"], scrollback: [], seq: 1 });
    const archived = await h.runtime.archiveEndedTab(h.ref, { ...h.input, baseRevision: (await h.store.getTab(h.ref))!.revision });
    expect(archived).toMatchObject({ id: h.tab.id, name: h.input.name, incarnation: h.tab.incarnation });
    const after = (await h.store.getRuntimeWorkspace(h.ref.workspaceId))!.tabs[h.ref.tabId]!;
    expect(after.zellijTabName).toBe(before.zellijTabName);
    expect(after.zellijTabId).toBe(before.zellijTabId); expect(after.zellijPaneId).toBe(before.zellijPaneId);
    expect(await h.store.readSnapshot(h.ref)).toEqual(snapshot);
    expect(h.adapter.renameTab).not.toHaveBeenCalled(); expect(h.adapter.closeTab).not.toHaveBeenCalled();
    expect(h.adapter.createTab).not.toHaveBeenCalled();
  });

  it.each(["running", "unknown"])("rechecks actual %s state after an earlier exited observation and rejects archive", async (state) => {
    const h = await harness();
    expect(await h.runtime.getCommandState(h.ref)).toBe("exited");
    h.adapter.getCommandState.mockResolvedValue(state);
    await expect(h.runtime.archiveEndedTab(h.ref, h.input)).rejects.toMatchObject({ code: "unavailable" });
    expect((await h.store.getTab(h.ref))!.name).toBe(h.tab.name);
  });

  it("archives a positively absent tab without calling Zellij rename", async () => {
    const h = await harness(); h.adapter.findTabByInternalNameReadOnly.mockResolvedValue(undefined);
    await expect(h.runtime.archiveEndedTab(h.ref, h.input)).resolves.toMatchObject({ name: h.input.name });
    expect(h.adapter.getCommandState).not.toHaveBeenCalled(); expect(h.adapter.renameTab).not.toHaveBeenCalled();
  });

  it("does not treat stale exited metadata as authority when the actual pane is running", async () => {
    const h = await harness(); const exited = await h.store.markTabExited(h.ref, 1);
    h.adapter.getCommandState.mockResolvedValue("running");
    await expect(h.runtime.archiveEndedTab(h.ref, { ...h.input, baseRevision: exited.revision }))
      .rejects.toMatchObject({ code: "unavailable" });
  });

  it("archives exited metadata only after a successful inventory confirms absence", async () => {
    const h = await harness(); const exited = await h.store.markTabExited(h.ref, 1);
    h.adapter.findTabByInternalNameReadOnly.mockResolvedValue(undefined);
    await expect(h.runtime.archiveEndedTab(h.ref, { ...h.input, baseRevision: exited.revision }))
      .resolves.toMatchObject({ name: h.input.name });
  });

  it("rejects wrong provider, changed names/revisions and a replaced pane without renaming", async () => {
    const h = await harness();
    await expect(h.runtime.archiveEndedTab(h.ref, { ...h.input, providerId: "claude" })).rejects.toMatchObject({ code: "unavailable" });
    await expect(h.runtime.archiveEndedTab(h.ref, { ...h.input, expectedName: "another" })).rejects.toMatchObject({ code: "conflict" });
    await expect(h.runtime.archiveEndedTab(h.ref, { ...h.input, baseRevision: 999 })).rejects.toMatchObject({ code: "conflict" });
    await expect(h.runtime.archiveEndedTab(h.ref, { ...h.input, expectedIncarnation: "ti_00000000000000000000000000000001" }))
      .rejects.toMatchObject({ code: "conflict" });
    h.adapter.findTabByInternalNameReadOnly.mockResolvedValue({ tabId: 9, paneId: "terminal_9" });
    await expect(h.runtime.archiveEndedTab(h.ref, h.input)).rejects.toMatchObject({ code: "conflict" });
    expect((await h.store.getTab(h.ref))!.name).toBe(h.tab.name);
  });

  it("fails closed when inventory is unsupported or failed, and when archive destination already exists", async () => {
    const h = await harness();
    h.adapter.findTabByInternalNameReadOnly.mockRejectedValueOnce(new Error("inventory unavailable"));
    await expect(h.runtime.archiveEndedTab(h.ref, h.input)).rejects.toThrow();
    await h.store.createTab(h.ref.workspaceId, { name: h.input.name, cwd: "" });
    await expect(h.runtime.archiveEndedTab(h.ref, h.input)).rejects.toMatchObject({ code: "conflict" });
    delete h.adapter.findTabByInternalNameReadOnly;
    await expect(h.runtime.archiveEndedTab(h.ref, h.input)).rejects.toThrow();
    expect((await h.store.getTab(h.ref))!.name).toBe(h.tab.name);
  });

  it("rejects concurrent revision changes observed while the command query settles", async () => {
    const h = await harness();
    h.adapter.getCommandState.mockImplementationOnce(async () => {
      await h.store.renameTab(h.ref, { name: "owner-changed", baseRevision: h.tab.revision }); return "exited";
    });
    await expect(h.runtime.archiveEndedTab(h.ref, h.input)).rejects.toMatchObject({ code: "conflict" });
    expect((await h.store.getTab(h.ref))!.name).toBe("owner-changed");
  });

  it("claims a unique archive name inside the conditional store write after concurrent inventory changes", async () => {
    const h = await harness();
    h.adapter.getCommandState.mockImplementationOnce(async () => {
      await h.store.createTab(h.ref.workspaceId, { name: h.input.name, cwd: "" }); return "exited";
    });
    await expect(h.runtime.archiveEndedTab(h.ref, h.input)).rejects.toMatchObject({ code: "conflict" });
    expect((await h.store.getTab(h.ref))!.name).toBe(h.tab.name);
  });

  it("rejects a replaced incarnation at the final store write even when its revision matches", async () => {
    const h = await harness();
    h.adapter.getCommandState.mockImplementationOnce(async () => {
      await h.store.removeTab(h.ref);
      await h.store.createTab(h.ref.workspaceId, { tabId: h.ref.tabId, name: h.tab.name, cwd: "", agent: { providerId: "codex" } });
      await h.store.activateTab(h.ref, { tabId: 3, paneId: "terminal_2" }); return "exited";
    });
    await expect(h.runtime.archiveEndedTab(h.ref, h.input)).rejects.toMatchObject({ code: "conflict" });
    expect((await h.store.getTab(h.ref))!.name).toBe(h.tab.name);
  });

  it("blocks held-pane restart input while archive verification runs and releases the gate after failure", async () => {
    const h = await harness();
    const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    h.adapter.getCommandState.mockImplementationOnce(async () => {
      entered.resolve(); await resume.promise; return "running";
    });
    const result = h.runtime.archiveEndedTab(h.ref, h.input);
    const rejected = expect(result).rejects.toMatchObject({ code: "unavailable" });
    await entered.promise;
    await expect(h.runtime.writeInput(h.ref, "\r")).rejects.toMatchObject({ code: "conflict" });
    resume.resolve(); await rejected;
    // A later archive succeeds: the temporary input reservation did not remain stuck.
    await expect(h.runtime.archiveEndedTab(h.ref, h.input)).resolves.toMatchObject({ name: h.input.name });
  });

  it("round-trips the validated operation through the owner-only socket", async () => {
    const h = await harness(); const socketPath = join(h.home, "archive.sock");
    const server = new TerminalRuntimeSocketServer({ socketPath, runtime: h.runtime }); await server.start(); cleanup.push(() => server.close());
    const client = new TerminalRuntimeSocketClient({ socketPath });
    await expect(client.archiveEndedTab(h.ref, h.input)).resolves.toMatchObject({ id: h.tab.id, name: h.input.name });
    await expect(client.archiveEndedTab(h.ref, { ...h.input, providerId: "untrusted" } as never)).rejects.toThrow();
  });
});
