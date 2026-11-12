// @vitest-environment jsdom
import React, { StrictMode, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FocusedWebProject } from "../../shell/src/components/chat/FocusedWebProject";
import { WebProjectHome } from "../../shell/src/components/chat/WebProjectHome";
import { WebProjectAgentContextNavigation } from "../../shell/src/components/chat/WebProjectAgentContext";
import { useFileBrowser } from "../../shell/src/hooks/useFileBrowser";
import { resetWindowManagerLayoutPersistenceForTests, useWindowManager } from "../../shell/src/hooks/useWindowManager";
import { usePreviewWindow } from "../../shell/src/hooks/usePreviewWindow";
import { PreviewWindow } from "../../shell/src/components/preview-window/PreviewWindow";
import { organizationDriveNavigationIdentity } from "../../shell/src/stores/organization-drive-navigation";
import { FileBrowser } from "../../shell/src/components/file-browser/FileBrowser";
import type { RenameableConversation } from "../../shell/src/components/chat/ChatTitleRename";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => {
  if (document.documentElement.dataset.matrixSelfHosted === "1") throw new Error("ClerkProvider is absent");
  return { userId: "owner", sessionId: "session" };
} }));
vi.mock("@/hooks/useFileWatcher", () => ({ useFileWatcher: vi.fn() }));
// Every fetched Chat is already listed, and paging has reached its cap.
vi.mock("../../shell/src/components/chat/usePagedProjectChats", async original => ({
  ...await original<typeof import("../../shell/src/components/chat/usePagedProjectChats")>(),
  usePagedProjectChats: () => ({ expanded: true, toggleExpanded: vi.fn(), fetched: [{ id: "chat_1", title: "Chat 1", titleVersion: 0 }],
    loading: false, error: false, retry: vi.fn(), loadMore: vi.fn(), hasMore: false, capped: true }),
}));

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.matrixSelfHosted;
  useFileBrowser.setState(useFileBrowser.getInitialState());
  resetWindowManagerLayoutPersistenceForTests();
  useWindowManager.setState(useWindowManager.getInitialState());
  usePreviewWindow.setState(usePreviewWindow.getInitialState());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("reads declarations only after opening Agent context for the selected project", async () => {
  const fetch = vi.fn(async () => Response.json({
    instructions: ["CLAUDE.md"], skills: [], mcpServers: [],
    incompleteSources: [".codex/config.toml"],
  }));
  vi.stubGlobal("fetch", fetch);
  render(<WebProjectHome project={{ id: "proj_france", slug: "france", name: "France" }} gatewayUrl="https://example.test" identity="owner" />);
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Agent configuration" }));
  expect(await screen.findByText("CLAUDE.md")).toBeTruthy();
  expect(screen.getByText(/Some sources could not be read/)).toBeTruthy();
  expect(fetch).toHaveBeenCalledWith("https://example.test/api/projects/proj_france/agent-context", expect.objectContaining({ cache: "no-store" }));
});

it("opens a cold Files window at the project folder", async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url.includes("/files-location?")) return Response.json({ path: "Projects/france" });
    if (url.includes("/api/files/list")) return Response.json({ entries: [
      { name: url.includes("path=Projects%2Ffrance") ? "project-notes.md" : "unrelated-home.md", type: "file" },
    ] });
    return Response.json({ instructions: [], skills: [], mcpServers: [], incompleteSources: [] });
  });
  vi.stubGlobal("fetch", fetch);
  const openMcpSettings = vi.fn();
  function ShellFixture() {
    const [filesOpen, setFilesOpen] = useState(false);
    const openFiles = () => {
      useWindowManager.setState({ focusedWindowId: "files" });
      setFilesOpen(true);
    };
    return <WebProjectAgentContextNavigation.Provider value={{ openFiles, openMcpSettings }}>
      <WebProjectHome project={{ id: "proj_france", slug: "france", name: "France" }} gatewayUrl={window.location.origin} identity="owner" />
      {filesOpen ? <FileBrowser windowId="files" mobile={false} /> : null}
    </WebProjectAgentContextNavigation.Provider>;
  }
  render(<StrictMode><ShellFixture /></StrictMode>);
  fireEvent.click(screen.getByRole("button", { name: "Agent configuration" }));
  expect(await screen.findByText(/No agent context files/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "MCP" }));
  fireEvent.click(screen.getByRole("button", { name: "Open MCP settings" }));
  expect(openMcpSettings).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Config files" }));
  fireEvent.click(screen.getByRole("button", { name: "Open project files" }));
  await waitFor(() => expect(useFileBrowser.getState().currentPath).toBe("Projects/france"));
  expect(await screen.findByText("project-notes.md")).toBeTruthy();
  expect(screen.queryByText("unrelated-home.md")).toBeNull();
  expect(useFileBrowser.getState().pendingView).toBeNull();
  expect(fetch.mock.calls.filter(([url]) => url.includes("/api/files/list"))).toEqual([[
    expect.stringContaining("/api/files/list?path=Projects%2Ffrance"), expect.anything(),
  ]]);
  expect(fetch).toHaveBeenCalledWith(`${window.location.origin}/api/projects/france/files-location?projectId=proj_france`, expect.anything());
});

it("opens the selected skill in the existing file editor", async () => {
  const fetch = vi.fn(async (url: string) => url.endsWith("/agent-context")
    ? Response.json({ instructions: [], skills: [{ name: "release", source: ".agents/skills" }], mcpServers: [], incompleteSources: [] })
    : Response.json({ path: "Projects/france/.agents/skills/release/SKILL.md" }));
  vi.stubGlobal("fetch", fetch);
  const openFiles = vi.fn();
  const openPreview = vi.fn();
  render(<WebProjectAgentContextNavigation.Provider value={{ openFiles, openMcpSettings: vi.fn(), openPreview }}>
    <WebProjectHome project={{ id: "proj_france", slug: "france", name: "France" }} gatewayUrl={window.location.origin} identity="owner" />
  </WebProjectAgentContextNavigation.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Agent configuration" }));
  const open = await screen.findByRole("button", { name: "Open .agents/skills/release/SKILL.md" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(usePreviewWindow.getState().tabs).toHaveLength(0);
  fireEvent.click(open);
  await waitFor(() => expect(openPreview).toHaveBeenCalledOnce());
  expect(usePreviewWindow.getState().tabs).toEqual([expect.objectContaining({ path: "Projects/france/.agents/skills/release/SKILL.md", mode: "source" })]);
  expect(openFiles).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledWith(`${window.location.origin}/api/projects/france/files-location?projectId=proj_france&file=.agents%2Fskills%2Frelease%2FSKILL.md`, expect.anything());
});

it("hands keyboard focus to the requested Preview tab each time a project file is opened", async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/agent-context")) {
      return Response.json({ instructions: ["AGENTS.md"], skills: [], mcpServers: [], incompleteSources: [] });
    }
    if (url.includes("/files-location?")) return Response.json({ path: "Projects/france/AGENTS.md" });
    if (url.includes("/api/files/blob?")) return new Response("# Instructions");
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetch);
  function ShellFixture() {
    const windows = useWindowManager(state => state.windows);
    return <WebProjectAgentContextNavigation.Provider value={{
      openFiles: vi.fn(),
      openMcpSettings: vi.fn(),
      openPreview: () => useWindowManager.getState().openWindow("Preview", "__preview-window__", 0),
    }}>
      <WebProjectHome project={{ id: "proj_france", slug: "france", name: "France" }} gatewayUrl={window.location.origin} identity="owner" />
      {windows.map(window => window.path === "__preview-window__" && <PreviewWindow key={window.id} />)}
    </WebProjectAgentContextNavigation.Provider>;
  }
  render(<ShellFixture />);
  fireEvent.click(screen.getByRole("button", { name: "Agent configuration" }));
  fireEvent.click(await screen.findByRole("button", { name: "Config files" }));
  const open = await screen.findByRole("button", { name: "Open AGENTS.md" });

  for (let attempt = 0; attempt < 2; attempt++) {
    open.focus();
    // A keyboard-activated button emits a click without a pointer event.
    fireEvent.click(open, { detail: 0 });
    const tab = await screen.findByRole("tab", { name: "AGENTS.md" });
    await waitFor(() => expect(document.activeElement).toBe(tab));
  }
  expect(screen.getAllByRole("tab", { name: "AGENTS.md" })).toHaveLength(1);
});

it("creates a project MCP config with an empty server map", async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/agent-context")) return Response.json({ configFiles: [], instructions: [], skills: [], mcpServers: [], incompleteSources: [] });
    if (url.endsWith("/api/files/touch") && init?.method === "POST") return Response.json({ ok: true });
    return Response.json({ path: "Projects/france" });
  });
  vi.stubGlobal("fetch", fetch);
  const openPreview = vi.fn();
  const openMcpSettings = vi.fn();
  render(<WebProjectAgentContextNavigation.Provider value={{ openFiles: vi.fn(), openMcpSettings, openPreview }}>
    <WebProjectHome project={{ id: "proj_france", slug: "france", name: "France" }} gatewayUrl={window.location.origin} identity="owner" />
  </WebProjectAgentContextNavigation.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Agent configuration" }));
  fireEvent.click(await screen.findByRole("button", { name: "MCP" }));
  const create = await screen.findByRole("button", { name: "Create .mcp.json" });
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(create);
  await waitFor(() => expect(openPreview).toHaveBeenCalledOnce());
  expect(usePreviewWindow.getState().tabs).toEqual([expect.objectContaining({ path: "Projects/france/.mcp.json" })]);
  const [lookup, touch] = fetch.mock.calls.slice(1);
  expect(lookup?.[0]).toBe(`${window.location.origin}/api/projects/france/files-location?projectId=proj_france`);
  expect(touch?.[0]).toBe(`${window.location.origin}/api/files/touch`);
  expect(touch?.[1]?.method).toBe("POST");
  const { path, content, projectId, projectFile } = JSON.parse(touch?.[1]?.body as string);
  expect(path).toBe("Projects/france/.mcp.json");
  expect(projectId).toBe("proj_france");
  expect(projectFile).toBe(".mcp.json");
  expect(JSON.parse(content)).toEqual({ mcpServers: {} });
  expect(openMcpSettings).not.toHaveBeenCalled();
});

it.each([false, true])("drops a file action when the project changes before resolution (create=%s)", async (create) => {
  let resolveFile!: (response: Response) => void;
  const fetch = vi.fn((url: string) => url.endsWith("/agent-context")
    ? Promise.resolve(Response.json({ configFiles: [], instructions: create ? [] : ["AGENTS.md"], skills: [], mcpServers: [], incompleteSources: [] }))
    : new Promise<Response>(resolve => { resolveFile = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const openPreview = vi.fn();
  const renderProject = (id: string, slug: string) => (
    <WebProjectAgentContextNavigation.Provider value={{ openFiles: vi.fn(), openMcpSettings: vi.fn(), openPreview }}>
      <WebProjectHome project={{ id, slug, name: slug }} gatewayUrl={window.location.origin} identity="owner" />
    </WebProjectAgentContextNavigation.Provider>
  );
  const { rerender } = render(renderProject("proj_france", "france"));
  fireEvent.click(screen.getByRole("button", { name: "Agent configuration" }));
  fireEvent.click(await screen.findByRole("button", { name: "Config files" }));
  fireEvent.click(await screen.findByRole("button", { name: create ? "Create AGENTS.md" : "Open AGENTS.md" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  rerender(renderProject("proj_japan", "japan"));
  await act(async () => resolveFile(Response.json({ path: create ? "Projects/france" : "Projects/france/AGENTS.md" })));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(openPreview).not.toHaveBeenCalled();
  expect(usePreviewWindow.getState().tabs).toHaveLength(0);
});

it("renders the project and Preview surfaces on a self-hosted shell without Clerk", () => {
  document.documentElement.dataset.matrixSelfHosted = "1";
  render(<>
    <WebProjectHome project={{ id: "proj_france", slug: "france", name: "France" }} gatewayUrl={window.location.origin} identity="owner" />
    <PreviewWindow />
  </>);
  expect(screen.getByRole("button", { name: "Agent configuration" })).toBeTruthy();
  expect(screen.getByText("No files open")).toBeTruthy();
});

it("does not load a project configuration preview from a different browser session", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  usePreviewWindow.getState().openFile("Projects/private/.mcp.json", {
    authority: organizationDriveNavigationIdentity("owner", "previous-session", window.location.origin),
  });
  render(<PreviewWindow />);
  expect(screen.getByText("No files open")).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

it("discards a pending project folder from a prior session and opens Home", async () => {
  const fetch = vi.fn(async () => Response.json({ entries: [{ name: "current-home.md", type: "file" }] }));
  vi.stubGlobal("fetch", fetch);
  useFileBrowser.setState({ currentPath: "Projects/older-folder" });
  useFileBrowser.getState().requestView("files", {
    path: "Projects/private",
    identity: `owner\0previous-session\0${window.location.origin}`,
  });
  useWindowManager.setState({ focusedWindowId: "files" });

  render(<FileBrowser windowId="files" />);

  expect(await screen.findByText("current-home.md")).toBeTruthy();
  expect(useFileBrowser.getState().currentPath).toBe("");
  expect(useFileBrowser.getState().pendingFolder).toBeNull();
  expect(fetch.mock.calls).toEqual([[expect.stringMatching(/\/api\/files\/list\?path=$/), expect.anything()]]);
});

it("keeps the paging-limit notice when every capped row is already listed", () => {
  const chat = { id: "chat_1", title: "Chat 1", preview: "", messageCount: 1, updatedAt: 1 } as RenameableConversation;
  render(<FocusedWebProject project={{ id: "proj_france", slug: "france", name: "France" }} gatewayUrl="https://example.test" chats={[chat]}
    listedChatIds={new Set(["chat_1"])} onSelectChat={vi.fn()} renderRow={item => <p key={item.id}>{item.title}</p>} onBack={vi.fn()}
    mobile={false} unreadOnly={false} sourceFilter="all" searchQuery="" />);
  expect(screen.getByText("Showing the newest 1,000 chats in this project.")).toBeTruthy();
});
