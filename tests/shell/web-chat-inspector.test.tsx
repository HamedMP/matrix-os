// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WebChatInspector } from "../../shell/src/components/chat/WebChatInspector";

const terminalProps = vi.hoisted(() => vi.fn());
vi.mock("../../shell/src/components/terminal/TerminalPane", () => ({ TerminalPane: (props: unknown) => { terminalProps(props); return <div>Connected terminal</div>; } }));
vi.mock("../../shell/src/hooks/useTheme", () => ({ useTheme: () => ({}) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("asks before stopping an active terminal and keeps it running when canceled", async () => {
  const workspaceId = `tws_${"a".repeat(32)}`;
  const tabId = `tt_${"b".repeat(32)}`;
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ entries: [] }), { status: 200 });
  });
  vi.stubGlobal("fetch", request);
  render(<WebChatInspector chatId="chat_one" gatewayUrl="http://localhost:4000" layoutKey={null} rootWidth={1200} railWidth={260}
    filePath={null} onFilePathChange={vi.fn()} terminalSessionIds={[`${workspaceId}:${tabId}`]}
    sideChatClient={{ getSideChat: vi.fn(), createSideChat: vi.fn(), askSideChat: vi.fn() }} onSendToMain={vi.fn()} onClose={vi.fn()}/>);
  fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
  expect(screen.getByText("Connected terminal")).toBeTruthy();
  expect(terminalProps).toHaveBeenCalledWith(expect.objectContaining({ chatId: "chat_one" }));
  fireEvent.click(screen.getByRole("button", { name: "Close terminal tab" }));
  expect(screen.getByRole("alertdialog", { name: "Stop this terminal?" })).toBeTruthy();
  expect(request.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByText("Connected terminal")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close terminal tab" }));
  fireEvent.click(screen.getByRole("button", { name: "Stop terminal" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith(
    `http://localhost:4000/api/terminal/workspaces/${workspaceId}/tabs/${tabId}`,
    expect.objectContaining({ method: "DELETE" }),
  ));
  await waitFor(() => expect(screen.getByRole("tabpanel", { name: "Files" })).toBeTruthy());
  fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
  expect(screen.queryByText("Connected terminal")).toBeNull();
  expect(screen.getByRole("button", { name: "New terminal" })).toBeTruthy();
});
