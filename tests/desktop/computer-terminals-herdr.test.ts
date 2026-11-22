import { describe, expect, it, vi } from "vitest";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { listComputerTabs } from "../../desktop/src/renderer/src/features/terminal-window/computer-terminals";

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
});
