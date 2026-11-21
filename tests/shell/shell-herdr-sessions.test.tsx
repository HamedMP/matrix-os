// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { ShellHerdrSessions } from "../../shell/src/components/terminal/ShellHerdrSessions";
import { parseTerminalRefKey, terminalWebSocketPathForSession } from "../../shell/src/components/terminal/terminal-session-id";

vi.mock("@/lib/gateway", () => ({ getGatewayUrl: () => "http://gateway.test" }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const tabId = `tt_${"9".repeat(32)}`;

describe("Herdr sessions in the Web Terminal sidebar", () => {
  it("opens a Herdr session as a terminal tab that attaches through the Herdr socket", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      available: true, status: "ready", sessions: [{ id: "t4", tabId, title: "claude", status: "working" }],
    })));
    vi.stubGlobal("fetch", fetchMock);
    const onOpen = vi.fn();
    render(<ShellHerdrSessions selectedSessionId={null} onOpen={onOpen} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open claude" }));

    expect(fetchMock).toHaveBeenCalledWith("http://gateway.test/api/terminal/herdr", expect.objectContaining({ method: "GET" }));
    const shell = onOpen.mock.calls[0]![0];
    expect(shell).toMatchObject({ workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId, subtitle: "claude" });
    expect(parseTerminalRefKey(shell.name)).toEqual({ workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId });
    expect(terminalWebSocketPathForSession(shell.name)).toBe("/ws/terminal/herdr");
  });

  it("shows nothing when the computer has no Herdr", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ available: false, status: "not-installed", sessions: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<ShellHerdrSessions selectedSessionId={null} onOpen={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});
