import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZellijCliRuntimeAdapter } from "../../packages/terminal-runtime/src/zellij-adapter.js";
import { TerminalRuntime, type ZellijRuntimeAdapter } from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";
import { TerminalRuntimeSocketClient } from "../../packages/terminal-runtime/src/socket-client.js";
import { TerminalRuntimeSocketServer } from "../../packages/terminal-runtime/src/socket-server.js";
import { TerminalRuntimeRequestSchema } from "../../packages/terminal-runtime/src/socket-protocol.js";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";

const SESSION = "matrix-w-00000000000000000000000000000001";
const REF = { workspaceId: "tws_00000000000000000000000000000001", tabId: "tt_00000000000000000000000000000001" };
const pane = { id: 2, tab_id: 3, is_plugin: false, is_held: false, exit_status: null };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe("exact Terminal command state", () => {
  it.each([
    [{ ...pane, is_held: true, exit_status: 1 }, "exited"],
    [{ ...pane, is_held: true, exit_status: 0 }, "exited"],
    [pane, "running"],
    [{ ...pane, is_held: true, exit_status: null }, "unknown"],
    [{ ...pane, is_held: false, exit_status: 1 }, "unknown"],
    [{ id: 2, tab_id: 3, is_plugin: false }, "unknown"],
    [{ ...pane, tab_id: 4 }, "unknown"],
    [{ ...pane, id: 4 }, "unknown"],
    [{ ...pane, is_plugin: true }, "unknown"],
    [{ ...pane, exit_status: "1" }, "unknown"],
  ])("classifies structured pane evidence %j as %s", async (observed, expected) => {
    const run = vi.fn(async () => JSON.stringify([observed, { ...pane, id: 5, is_held: true, exit_status: 1 }]));
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix/home", run });
    await expect(adapter.getCommandState(SESSION, 3, "terminal_2")).resolves.toBe(expected);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(["--session", SESSION, "action", "list-panes", "--all", "--json"]);
  });

  it("fails closed on missing, duplicate, malformed or unavailable observations", async () => {
    const run = vi.fn().mockResolvedValueOnce("[]").mockResolvedValueOnce(JSON.stringify([pane, pane]))
      .mockResolvedValueOnce("not json").mockRejectedValueOnce(new Error("private process detail"));
    const adapter = new ZellijCliRuntimeAdapter({ homePath: "/home/matrix/home", run });
    for (let index = 0; index < 4; index++) {
      await expect(adapter.getCommandState(SESSION, 3, "terminal_2")).resolves.toBe("unknown");
    }
  });

  async function runtimeHarness() {
    const home = await createUnixSocketTempDir(); cleanup.push(() => rm(home, { recursive: true, force: true }));
    const store = new TerminalWorkspaceStore({ homePath: home });
    const workspace = await store.ensureWorkspace();
    const tab = await store.createTab(workspace.id, { name: "provider-auth-test", cwd: "" });
    const ref = { workspaceId: workspace.id, tabId: tab.id };
    const active = await store.activateTab(ref, { tabId: 3, paneId: "terminal_2" });
    const getCommandState = vi.fn<NonNullable<ZellijRuntimeAdapter["getCommandState"]>>(async () => "exited");
    const adapter = { getCommandState } as unknown as ZellijRuntimeAdapter;
    const runtime = new TerminalRuntime({ store, zellij: adapter }); cleanup.push(() => runtime.shutdown());
    return { home, store, runtime, adapter, getCommandState, ref, active };
  }

  it("resolves exact internal tab/pane identity without creating or changing a terminal", async () => {
    const h = await runtimeHarness();
    const before = await h.store.listWorkspaces();
    await expect(h.runtime.getCommandState(h.ref, h.active.incarnation)).resolves.toBe("exited");
    expect(h.getCommandState).toHaveBeenCalledWith(expect.stringMatching(/^matrix-w-/), 3, "terminal_2");
    expect(await h.store.listWorkspaces()).toEqual(before);
  });

  it("rejects a stale incarnation before querying the pane and rejects replacement during the read", async () => {
    const h = await runtimeHarness();
    await expect(h.runtime.getCommandState(h.ref, "ti_00000000000000000000000000000001")).resolves.toBe("unknown");
    expect(h.getCommandState).not.toHaveBeenCalled();
    h.getCommandState.mockImplementationOnce(async () => {
      await h.store.activateTab(h.ref, { tabId: 9, paneId: "terminal_9" }); return "exited";
    });
    await expect(h.runtime.getCommandState(h.ref)).resolves.toBe("unknown");
  });

  it("returns unknown for missing refs and an adapter without command observation", async () => {
    const h = await runtimeHarness();
    await expect(h.runtime.getCommandState(REF)).resolves.toBe("unknown");
    await expect(h.runtime.getCommandState({ ...h.ref, tabId: REF.tabId })).resolves.toBe("unknown");
    delete h.adapter.getCommandState;
    await expect(h.runtime.getCommandState(h.ref)).resolves.toBe("unknown");
    await expect(h.runtime.getCommandState({ workspaceId: "legacy", tabId: "bad" })).rejects.toThrow();
  });

  it("discards a command observation when the stored incarnation changes during the read", async () => {
    const h = await runtimeHarness();
    const workspace = await h.store.getRuntimeWorkspace(h.ref.workspaceId);
    if (!workspace) throw new Error("Expected runtime workspace");
    const tab = workspace.tabs[h.ref.tabId]!;
    vi.spyOn(h.store, "getRuntimeWorkspace").mockResolvedValueOnce(workspace).mockResolvedValueOnce({
      ...workspace, tabs: { ...workspace.tabs, [tab.id]: { ...tab,
        zellijTabName: "matrix-tab-00000000000000000000000000000002" } },
    });
    await expect(h.runtime.getCommandState(h.ref)).resolves.toBe("unknown");
  });

  it("round-trips only the coarse enum through the actual owner-only Unix socket", async () => {
    const h = await runtimeHarness();
    const path = join(h.home, "command.sock");
    const server = new TerminalRuntimeSocketServer({ socketPath: path, runtime: h.runtime });
    await server.start(); cleanup.push(() => server.close());
    const client = new TerminalRuntimeSocketClient({ socketPath: path });
    await expect(client.getCommandState(h.ref, h.active.incarnation)).resolves.toBe("exited");
    h.getCommandState.mockResolvedValueOnce("running");
    await expect(client.getCommandState(h.ref)).resolves.toBe("running");
    h.getCommandState.mockResolvedValueOnce({ command: "private process info" } as never);
    await expect(client.getCommandState(h.ref)).resolves.toBe("unknown");
    await expect(client.getCommandState(h.ref, "ti_00000000000000000000000000000001")).resolves.toBe("unknown");
    const request = { version: 1, requestId: "req_00000000000000000000000000000001", operation: "GetCommandState",
      input: { ...h.ref, expectedIncarnation: h.active.incarnation } };
    expect(TerminalRuntimeRequestSchema.safeParse(request).success).toBe(true);
    expect(TerminalRuntimeRequestSchema.safeParse({ ...request, input: { ...request.input, command: "codex" } }).success).toBe(false);
  });
});
