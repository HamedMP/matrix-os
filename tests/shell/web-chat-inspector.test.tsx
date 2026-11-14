// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WebChatInspector } from "../../shell/src/components/chat/WebChatInspector";

const terminalProps = vi.hoisted(() => vi.fn());
vi.mock("../../shell/src/components/terminal/TerminalPane", () => ({ TerminalPane: (props: unknown) => { terminalProps(props); return <div>Connected terminal</div>; } }));
vi.mock("../../shell/src/hooks/useTheme", () => ({ useTheme: () => ({}) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("covers the chat pane in a narrow floating window instead of leaving an unusable sliver", () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ entries: [] })));
  render(<WebChatInspector chatId="chat_one" gatewayUrl="http://localhost:4000" layoutKey={null} rootWidth={768} railWidth={260}
    filePath={null} onFilePathChange={vi.fn()} terminalSessionIds={[]}
    sideChatClient={{ getSideChat: vi.fn(), createSideChat: vi.fn(), askSideChat: vi.fn() }} onSendToMain={vi.fn()} onClose={vi.fn()}/>);
  const inspector = screen.getByRole("complementary", { name: "Chat inspector" });
  expect(inspector.className).toContain("absolute");
  expect(inspector.style.width).toBe("508px");
  expect(screen.getByRole("button", { name: "Close inspector" })).toBeTruthy();
});

it("asks before stopping an active terminal and keeps it running when canceled", async () => {
  const workspaceId = `tws_${"a".repeat(32)}`;
  const tabId = `tt_${"b".repeat(32)}`;
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response("{}", { status: 200 });
    if (_url.endsWith("/api/terminal/workspaces")) return Response.json({ workspaces: [{ id: workspaceId, tabs: [{ id: tabId }] }] });
    return new Response(JSON.stringify({ entries: [] }), { status: 200 });
  });
  vi.stubGlobal("fetch", request);
  render(<WebChatInspector chatId="chat_one" gatewayUrl="http://localhost:4000" layoutKey={null} rootWidth={1200} railWidth={260}
    filePath={null} onFilePathChange={vi.fn()} terminalSessionIds={[`${workspaceId}:${tabId}`]}
    sideChatClient={{ getSideChat: vi.fn(), createSideChat: vi.fn(), askSideChat: vi.fn() }} onSendToMain={vi.fn()} onClose={vi.fn()}/>);
  fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
  expect(await screen.findByText("Connected terminal")).toBeTruthy();
  expect(terminalProps).toHaveBeenCalledWith(expect.objectContaining({ chatId: "chat_one" }));
  fireEvent.click(screen.getByRole("button", { name: "Close terminal tab" }));
  expect(screen.getByRole("alertdialog", { name: "Stop this terminal?" }).getAttribute("data-slot")).toBe("dialog-content");
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

it("ignores a saved terminal binding after its runtime tab was deleted", async () => {
  const workspaceId = `tws_${"a".repeat(32)}`;
  const tabId = `tt_${"b".repeat(32)}`;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/api/terminal/workspaces")
    ? Response.json({ workspaces: [{ id: workspaceId, tabs: [] }] })
    : Response.json({ entries: [] })));
  render(<WebChatInspector chatId="chat_one" gatewayUrl="http://localhost:4000" layoutKey={null} rootWidth={1200} railWidth={260}
    filePath={null} onFilePathChange={vi.fn()} terminalSessionIds={[`${workspaceId}:${tabId}`]}
    sideChatClient={{ getSideChat: vi.fn(), createSideChat: vi.fn(), askSideChat: vi.fn() }} onSendToMain={vi.fn()} onClose={vi.fn()}/>);
  fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("http://localhost:4000/api/terminal/workspaces", expect.anything()));
  expect(screen.queryByText("Connected terminal")).toBeNull();
  expect(screen.getByRole("button", { name: "New terminal" })).toBeTruthy();
});

it("opens a folder with more than 1,000 files using a bounded visible window", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ entries: Array.from({ length: 1002 }, (_, index) => ({ name: `file_${index}`, type: "file" })) })));
  render(<WebChatInspector chatId="chat_one" gatewayUrl="http://localhost:4000" layoutKey={null} rootWidth={1200} railWidth={260}
    filePath={null} onFilePathChange={vi.fn()} terminalSessionIds={[]}
    sideChatClient={{ getSideChat: vi.fn(), createSideChat: vi.fn(), askSideChat: vi.fn() }} onSendToMain={vi.fn()} onClose={vi.fn()}/>);
  expect(await screen.findByRole("treeitem", { name: "file_0" })).toBeTruthy();
  expect(screen.getAllByRole("treeitem")).toHaveLength(1000);
  expect(screen.getByText("Showing the first 1,000 files.")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not reuse a previous folder's entries while the next folder loads", async () => {
  let finishFolder: (response: Response) => void = () => {};
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("path=folder")
    ? new Promise<Response>(resolve => { finishFolder = resolve; })
    : Response.json({ entries: [{ name: "folder", type: "directory" }] })));
  render(<WebChatInspector chatId="chat_one" gatewayUrl="http://localhost:4000" layoutKey={null} rootWidth={1200} railWidth={260}
    filePath={null} onFilePathChange={vi.fn()} terminalSessionIds={[]}
    sideChatClient={{ getSideChat: vi.fn(), createSideChat: vi.fn(), askSideChat: vi.fn() }} onSendToMain={vi.fn()} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("treeitem", { name: "folder" }));
  expect(screen.queryByRole("treeitem", { name: "folder" })).toBeNull();
  finishFolder(Response.json({ entries: [] }));
  await waitFor(() => expect(screen.queryByRole("status", { name: /Loading files/ })).toBeNull());
});
