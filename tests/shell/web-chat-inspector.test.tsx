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
  fireEvent.click(screen.getByRole("button", { name: "Close Terminal tab" }));
  expect(screen.getByRole("alertdialog", { name: "Stop this terminal?" }).getAttribute("data-slot")).toBe("dialog-content");
  expect(request.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByText("Connected terminal")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close Terminal tab" }));
  fireEvent.click(screen.getByRole("button", { name: "Stop terminal" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith(
    `http://localhost:4000/api/terminal/workspaces/${workspaceId}/tabs/${tabId}`,
    expect.objectContaining({ method: "DELETE" }),
  ));
  await waitFor(() => expect(screen.getByRole("tabpanel", { name: "Files" })).toBeTruthy());
  expect(screen.queryByRole("tab", { name: "Terminal" })).toBeNull();
  expect(screen.queryByText("Connected terminal")).toBeNull();
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
  expect(screen.getByRole("treeitem", { name: "folder" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.queryByRole("treeitem", { name: "old-child" })).toBeNull();
  finishFolder(Response.json({ entries: [] }));
  await waitFor(() => expect(screen.queryByRole("status", { name: /Loading files/ })).toBeNull());
});


it("opens a New tab picker, then preserves Files while adding Side chat", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ entries: [] })));
  const sideChatClient = { getSideChat: vi.fn(async () => ({threadId:null,messages:[]})), createSideChat: vi.fn(), askSideChat: vi.fn() };
  render(<WebChatInspector chatId="chat_picker" gatewayUrl="http://localhost:4000" layoutKey={null} rootWidth={1512} railWidth={240}
    filePath={null} onFilePathChange={vi.fn()} terminalSessionIds={[]} sideChatClient={sideChatClient} onSendToMain={vi.fn()} onClose={vi.fn()}/>);
  expect(screen.queryByRole("tab", {name:"Side chat"})).toBeNull();
  fireEvent.click(screen.getByRole("button", {name:"Add inspector tab"}));
  expect(screen.getByRole("tabpanel", {name:"New tab"})).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name:/Side chat/}));
  expect(screen.getByRole("tab", {name:"Files"})).toBeTruthy();
  expect(screen.getByRole("tab", {name:"Side chat"}).getAttribute("aria-selected")).toBe("true");
  await screen.findByRole("note");
});


it("opens the verified project file root rather than listing Home for a project chat", async () => {
 const request=vi.fn(async(url:string)=>url.includes("files-location")?Response.json({path:"projects/matrix-os/repo"}):Response.json({entries:[{name:"MobileNav.tsx",type:"file"}]}));
 vi.stubGlobal("fetch",request);
 render(<WebChatInspector chatId="chat_project" gatewayUrl="http://localhost:4000" layoutKey={null} rootWidth={1512} railWidth={240} project={{id:"project_matrix",slug:"matrix-os"}} filePath={null} onFilePathChange={vi.fn()} terminalSessionIds={[]} sideChatClient={{getSideChat:vi.fn(),createSideChat:vi.fn(),askSideChat:vi.fn()}} onSendToMain={vi.fn()} onClose={vi.fn()}/>);
 await screen.findByRole("treeitem",{name:"MobileNav.tsx"});
 expect(request).toHaveBeenCalledWith("http://localhost:4000/api/projects/matrix-os/files-location?projectId=project_matrix",expect.anything());
 expect(request).toHaveBeenCalledWith("http://localhost:4000/api/files/list?path=projects%2Fmatrix-os%2Frepo",expect.anything());
 expect(request.mock.calls.some(([url])=>url.endsWith("files/list?path="))).toBe(false);
});
