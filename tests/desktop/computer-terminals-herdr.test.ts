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
});
