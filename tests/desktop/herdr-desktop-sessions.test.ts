import { describe, expect, it, vi } from "vitest";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { closeHerdrSession, loadHerdrSessions } from "@matrix-os/ui/herdr-sessions";
import { herdrDesktopSession, herdrSessionsRequest } from "../../desktop/src/renderer/src/features/terminal/herdr-desktop-session";
import { parseTerminalRefKey } from "../../desktop/src/renderer/src/lib/terminal-workspaces";

const tabId = `tt_${"5".repeat(32)}`;
const list = { available: true, status: "ready", sessions: [{ id: "t5", tabId, title: "agent", status: "done" }] };

describe("Herdr sessions in the Electron Desktop Terminal", () => {
  it("lists and closes through the authenticated desktop API client", async () => {
    const api = { getText: vi.fn(async () => JSON.stringify(list)), delete: vi.fn(async () => ({ ok: true })) };
    const request = herdrSessionsRequest(api as never);
    expect(await loadHerdrSessions(request)).toEqual(list);
    await closeHerdrSession(request, "t5");
    expect(api.getText).toHaveBeenCalledWith("/api/terminal/herdr", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(api.delete).toHaveBeenCalledWith("/api/terminal/herdr/t5", {}, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("hides the group when the gateway rejects the listing", async () => {
    const api = { getText: vi.fn(async () => { throw new Error("http 404"); }), delete: vi.fn() };
    await expect(loadHerdrSessions(herdrSessionsRequest(api as never))).rejects.toThrow();
  });

  it("opens a Herdr session as a Terminal session keyed by its Matrix ref", () => {
    const shell = herdrDesktopSession({ id: "t5", tabId, title: "agent", status: "done" });
    expect(parseTerminalRefKey(shell.name)).toEqual({ workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId });
    expect(shell).toMatchObject({ subtitle: "agent", cwd: "~", status: "active" });
  });
});
