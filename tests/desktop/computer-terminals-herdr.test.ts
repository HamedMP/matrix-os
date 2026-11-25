import { describe, expect, it, vi } from "vitest";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { desktopLinkWorkspaceId } from "@matrix-os/contracts/desktop-link";
import { closeComputerTab, createComputerTab, listComputerTabs } from "../../desktop/src/renderer/src/features/terminal-window/computer-terminals";

const WORKSPACE_ID = `tws_${"a".repeat(32)}`;
const TAB_ID = `tt_${"b".repeat(32)}`;
const HERDR_TAB = `tt_${"c".repeat(32)}`;

function api(herdr: () => Promise<string>) {
  return {
    get: vi.fn(async () => ({ workspaces: [{ id: WORKSPACE_ID, scope: "main", tabs: [{ id: TAB_ID, name: "Shell", status: "running" }] }] })),
    getText: vi.fn(herdr),
  };
}

describe("Terminal window computer section", () => {
  it("lists the computer's Herdr sessions from its gateway after its Matrix tabs", async () => {
    const client = api(async () => JSON.stringify({ available: true, status: "ready", sessions: [
      { id: "t1", tabId: HERDR_TAB, title: "claude", status: "working" },
    ] }));
    expect(await listComputerTabs(client as never)).toEqual([
      { refKey: `${WORKSPACE_ID}:${TAB_ID}`, name: "Shell", group: "main", ended: false },
      { refKey: `${HERDR_TERMINAL_WORKSPACE_ID}:${HERDR_TAB}`, name: "claude", group: "herdr", ended: false },
    ]);
    expect(client.getText).toHaveBeenCalledWith("/api/terminal/herdr", expect.anything());
  });

  it("keeps the Matrix tabs when the gateway has no Herdr adapter", async () => {
    const client = api(async () => { throw new Error("http 404"); });
    expect(await listComputerTabs(client as never)).toEqual([
      { refKey: `${WORKSPACE_ID}:${TAB_ID}`, name: "Shell", group: "main", ended: false },
    ]);
  });

  // Fault detected (Greptile on #3530): Herdr sessions were appended after the Matrix tabs
  // and the combined list was cut at 200, so Matrix history hid the whole Herdr group.
  it("keeps Herdr sessions visible when the computer has 200 Matrix tabs", async () => {
    const matrixTabs = Array.from({ length: 200 }, (_, index) => ({
      id: `tt_${index.toString(16).padStart(32, "0")}`, name: `old-${index}`, status: "exited",
    }));
    const client = {
      get: vi.fn(async () => ({ workspaces: [{ id: WORKSPACE_ID, scope: "main", tabs: matrixTabs }] })),
      getText: vi.fn(async () => JSON.stringify({ available: true, status: "ready", sessions: [
        { id: "t1", tabId: HERDR_TAB, title: "claude", status: "working" },
        { id: "t2", tabId: `tt_${"d".repeat(32)}`, title: "build", status: null },
      ] })),
    };
    const tabs = await listComputerTabs(client as never);
    expect(tabs.filter((tab) => tab.group === "main")).toHaveLength(200);
    expect(tabs.filter((tab) => tab.group === "herdr").map((tab) => tab.name)).toEqual(["claude", "build"]);
  });

  it("bounds Matrix tabs and Herdr sessions separately", async () => {
    const matrixTabs = Array.from({ length: 250 }, (_, index) => ({
      id: `tt_${index.toString(16).padStart(32, "0")}`, name: `tab-${index}`, status: "running",
    }));
    const sessions = Array.from({ length: 150 }, (_, index) => ({
      id: `t${index + 1}`, tabId: `tt_${(index + 1000).toString(16).padStart(32, "0")}`, title: `h-${index}`, status: null,
    }));
    const client = {
      get: vi.fn(async () => ({ workspaces: [{ id: WORKSPACE_ID, scope: "main", tabs: matrixTabs }] })),
      getText: vi.fn(async () => JSON.stringify({ available: true, status: "ready", sessions })),
    };
    const tabs = await listComputerTabs(client as never);
    expect(tabs.filter((tab) => tab.group === "main")).toHaveLength(200);
    expect(tabs.filter((tab) => tab.group === "herdr")).toHaveLength(100);
  });

  // Fault detected (Greptile on #3530): Close and Split in the Terminal window sent a Herdr
  // pane to Matrix workspace routes, so Close left the program running and showed an error.
  it("ends a Herdr pane through the Herdr route, not the Matrix tab route", async () => {
    const client = {
      getText: vi.fn(async () => JSON.stringify({ available: true, status: "ready", sessions: [
        { id: "t7", tabId: HERDR_TAB, title: "claude", status: "working" },
      ] })),
      delete: vi.fn(async () => ({ ok: true })),
    };
    await closeComputerTab(client as never, { workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: HERDR_TAB });
    expect(client.delete).toHaveBeenCalledTimes(1);
    expect(client.delete).toHaveBeenCalledWith("/api/terminal/herdr/t7", expect.anything(), expect.anything());
  });

  it("treats a Herdr pane that is no longer listed as already ended", async () => {
    const client = {
      getText: vi.fn(async () => JSON.stringify({ available: true, status: "ready", sessions: [] })),
      delete: vi.fn(),
    };
    await expect(closeComputerTab(client as never, { workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: HERDR_TAB })).resolves.toBeUndefined();
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("fails a Herdr close when the computer cannot list its Herdr sessions", async () => {
    const client = {
      getText: vi.fn(async () => { throw new Error("http 503"); }),
      delete: vi.fn(),
    };
    await expect(closeComputerTab(client as never, { workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: HERDR_TAB })).rejects.toBeTruthy();
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("splits a Herdr pane with a new Matrix tab in the main workspace", async () => {
    const created = `tt_${"e".repeat(32)}`;
    const client = {
      post: vi.fn(async (path: string) => (path.endsWith("/ensure")
        ? { workspace: { id: WORKSPACE_ID } }
        : { tab: { id: created, name: "Terminal" } })),
    };
    const refKey = await createComputerTab(client as never, "Terminal", { workspaceId: HERDR_TERMINAL_WORKSPACE_ID, cwd: "/tmp" });
    expect(refKey).toBe(`${WORKSPACE_ID}:${created}`);
    expect(client.post).toHaveBeenCalledWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs`, { name: "Terminal", cwd: "" });
    expect(client.post.mock.calls.some(([path]) => String(path).includes(HERDR_TERMINAL_WORKSPACE_ID))).toBe(false);
  });
});

describe("Terminal window: a computer's linked desktop (spec 2716)", () => {
  const MAC = "a5".repeat(32);
  const MACHINE = "4ab40e59-2f6e-4715-8d58-61b010b1cb14";
  const DESKTOP_TAB = `tt_${"e".repeat(32)}`;
  function client() {
    return {
      get: vi.fn(async () => ({ workspaces: [] })),
      getText: vi.fn(async (path: string) => {
        if (path === "/api/desktop-link/machines") return JSON.stringify({ machineId: MACHINE, machines: [{
          deviceId: MAC, name: "Studio Mac", revision: 1, state: "online", lastSeenAt: null, device: null,
        }] });
        if (path === `/api/desktop-link/machines/${MAC}/terminals`) return JSON.stringify({ workspaceId: desktopLinkWorkspaceId(MAC), sessions: [{ id: "t1", tabId: DESKTOP_TAB, title: "zsh", status: null }] });
        throw new Error("http 404");
      }),
    };
  }

  // Fault detected (review): the Electron Terminal window never showed a linked desktop's
  // terminals, only the main window's Terminal did.
  it("lists the desktop's terminals as their own group, opened by the desktop's ref", async () => {
    const tabs = await listComputerTabs(client() as never);
    expect(tabs).toEqual([{ refKey: `${desktopLinkWorkspaceId(MAC)}:${DESKTOP_TAB}`, name: "zsh", group: "Desktop · Studio Mac", ended: false }]);
  });

  it("leaves this device out of its own list", async () => {
    expect(await listComputerTabs(client() as never, [MAC])).toEqual([]);
  });
});

// Fault detected (Greptile on #3748): Close and Split on a linked desktop's pane used the
// Matrix workspace routes, so Close left the desktop's program running and showed an error.
describe("Terminal window linked desktop panes", () => {
  const DEVICE = "e".repeat(64);
  const DESKTOP_TAB = `tt_${"f".repeat(32)}`;
  const desktopApi = () => ({
    getText: vi.fn(async (path: string) => {
      if (path === "/api/desktop-link/machines") {
        return JSON.stringify({ machineId: "11111111-2222-4333-8444-555555555555", machines: [{ deviceId: DEVICE, name: "Laptop", revision: 1, state: "online", lastSeenAt: null, device: null }] });
      }
      return JSON.stringify({ deviceId: DEVICE, workspaceId: desktopLinkWorkspaceId(DEVICE), sessions: [{ id: "t9", tabId: DESKTOP_TAB, title: "claude", status: null }] });
    }),
    delete: vi.fn(async () => ({})),
    post: vi.fn(async (path: string) => (path.endsWith("/ensure") ? { workspace: { id: WORKSPACE_ID } } : { tab: { id: TAB_ID, name: "Terminal" } })),
  });

  it("ends a desktop pane on the desktop, through its own route", async () => {
    const client = desktopApi();
    await closeComputerTab(client as never, { workspaceId: desktopLinkWorkspaceId(DEVICE), tabId: DESKTOP_TAB });
    expect(client.delete).toHaveBeenCalledTimes(1);
    expect(client.delete.mock.calls[0]![0]).toBe(`/api/desktop-link/machines/${DEVICE}/terminals/t9`);
  });

  it("opens a split beside a desktop pane in the computer's main workspace", async () => {
    const client = desktopApi();
    const refKey = await createComputerTab(client as never, "Terminal", { workspaceId: desktopLinkWorkspaceId(DEVICE), cwd: "~" });
    expect(refKey).toBe(`${WORKSPACE_ID}:${TAB_ID}`);
    expect(client.post.mock.calls.map((call) => call[0])).toEqual(["/api/terminal/workspaces/ensure", `/api/terminal/workspaces/${WORKSPACE_ID}/tabs`]);
  });
});
