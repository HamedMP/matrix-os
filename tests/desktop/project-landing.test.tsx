// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectLanding } from "@desktop/renderer/src/features/project/ProjectLanding";
import { CanonicalNewChatContent } from "@desktop/renderer/src/features/chat/CanonicalNewChatContent";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { Project } from "@desktop/renderer/src/stores/board";
import { createApiClient } from "@desktop/renderer/src/lib/api";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useUi } from "@desktop/renderer/src/stores/ui";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useDesktopEditor } from "@desktop/renderer/src/features/editor/desktop-editor-store";
const actions = vi.hoisted(() => ({ showInFiles: vi.fn(), setDialog: vi.fn(), update: vi.fn(), dialog: null as null | "edit", pending: false, error: null, available: true }));
vi.mock("@desktop/renderer/src/features/work/work-rail/use-project-actions", () => ({ useProjectActions: () => actions }));
vi.mock("@desktop/renderer/src/features/chat/ChatProviderOnboarding", () => ({
  ChatProviderOnboarding: () => <button type="button">Connect provider</button>,
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const project: Project = { id: "project_alpha_id", slug: "alpha", name: "Alpha", kind: "folder", description: "Build the customer portal" };
describe("ProjectLanding", () => {
  it("opens the owner project context and uses the existing Files and MCP destinations", async () => {
    const previous = useConnection.getState().api;
    const previousTabs = useTabs.getState();
    const request = vi.fn(async () => Response.json({
      instructions: ["AGENTS.md"],
      skills: [{ name: "release-check", source: ".agents/skills" }],
      mcpServers: [{ name: "docs", source: ".codex/config.toml" }],
      incompleteSources: [],
    }));
    const api = createApiClient({ baseUrl: "https://fixture.test", getRuntimeSlot: () => "primary", fetchFn: request });
    useConnection.setState({ api });
    try {
      render(<ProjectLanding project={project}><textarea aria-label="Project draft" /></ProjectLanding>);
      expect(request).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Agent configuration" }));
      expect(await screen.findByText("release-check")).toBeTruthy();
      expect(request).toHaveBeenCalledWith("https://fixture.test/api/projects/project_alpha_id/agent-context", expect.objectContaining({ method: "GET" }));
      fireEvent.click(screen.getByRole("button", { name: "Config files" }));
      expect(screen.getByRole("button", { name: "Open AGENTS.md" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Open project files" }));
      expect(actions.showInFiles).toHaveBeenCalledExactlyOnceWith(true);
      fireEvent.click(screen.getByRole("button", { name: "MCP" }));
      expect(screen.getByRole("button", { name: "Open .codex/config.toml" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Open MCP settings" }));
      expect(useUi.getState().requestedSettingsSection).toBe("mcps");
      expect(useTabs.getState().tabs.some(tab => tab.kind === "settings")).toBe(true);
    } finally {
      cleanup();
      useUi.getState().clearRequestedSettingsSection();
      useTabs.setState(previousTabs);
      useConnection.setState({ api: previous });
    }
  });

  it("opens the selected project configuration file in the existing Editor", async () => {
    const connection = useConnection.getState();
    const editor = useDesktopEditor.getState();
    const tabs = useTabs.getState();
    const exactPath = "Projects/alpha%2Farchive/AGENTS.md";
    const request = vi.fn(async (url: string) => url.endsWith("/agent-context")
      ? Response.json({ instructions: ["AGENTS.md"], skills: [], mcpServers: [], incompleteSources: [] })
      : Response.json({ path: exactPath }));
    const api = createApiClient({ baseUrl: "https://fixture.test", getRuntimeSlot: () => "primary", fetchFn: request });
    useConnection.setState({ api });
    try {
      render(<ProjectLanding project={project}><textarea aria-label="Project draft" /></ProjectLanding>);
      fireEvent.click(screen.getByRole("button", { name: "Agent configuration" }));
      fireEvent.click(await screen.findByRole("button", { name: "Config files" }));
      const edit = await screen.findByRole("button", { name: "Open AGENTS.md" });
      expect(request).toHaveBeenCalledTimes(1);
      expect(useDesktopEditor.getState().paths).toEqual(editor.paths);
      fireEvent.click(edit);
      await waitFor(() => expect(useDesktopEditor.getState().activePath).toBe(exactPath));
      expect(useTabs.getState().tabs.some(tab => tab.kind === "editor")).toBe(true);
      expect(request).toHaveBeenCalledWith("https://fixture.test/api/projects/alpha/files-location?projectId=project_alpha_id&file=AGENTS.md", expect.anything());
    } finally {
      cleanup();
      useDesktopEditor.setState(editor);
      useTabs.setState(tabs);
      useConnection.setState(connection);
    }
  });

  it("creates an instruction file through the existing exclusive Files route", async () => {
    const connection = useConnection.getState();
    const editor = useDesktopEditor.getState();
    const tabs = useTabs.getState();
    const emptyContext = { configFiles: [], instructions: [], skills: [], mcpServers: [], incompleteSources: [] };
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/agent-context")) return Response.json(emptyContext);
      if (url.endsWith("/api/files/touch") && init?.method === "POST") return Response.json({ ok: true });
      return Response.json({ path: "Projects/alpha" });
    });
    const api = createApiClient({ baseUrl: "https://fixture.test", getRuntimeSlot: () => "primary", fetchFn: request });
    useConnection.setState({ api });
    try {
      render(<ProjectLanding project={project}><textarea aria-label="Project draft" /></ProjectLanding>);
      fireEvent.click(screen.getByRole("button", { name: "Agent configuration" }));
      fireEvent.click(await screen.findByRole("button", { name: "Config files" }));
      const create = await screen.findByRole("button", { name: "Create AGENTS.md" });
      expect(request).toHaveBeenCalledTimes(1);
      fireEvent.click(create);
      await waitFor(() => expect(useDesktopEditor.getState().activePath).toBe("Projects/alpha/AGENTS.md"));
      const [lookup, touch] = request.mock.calls.slice(1);
      expect(lookup?.[0]).toBe("https://fixture.test/api/projects/alpha/files-location?projectId=project_alpha_id");
      expect(touch?.[0]).toBe("https://fixture.test/api/files/touch");
      expect(touch?.[1]?.method).toBe("POST");
      expect(JSON.parse(touch?.[1]?.body as string)).toEqual({
        path: "Projects/alpha/AGENTS.md", content: "# Project instructions\n",
        projectId: "project_alpha_id", projectFile: "AGENTS.md",
      });
    } finally {
      cleanup();
      useDesktopEditor.setState(editor);
      useTabs.setState(tabs);
      useConnection.setState(connection);
    }
  });

  it.each([true, false])("bounds the canonical workspace with metadata visible=%s", (showMetadata) => {
    const { container } = render(<ProjectLanding project={project} showMetadata={showMetadata}>
      <section aria-label="Canonical workspace" className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">Connection guidance</div>
        <textarea aria-label="Bottom composer" className="shrink-0" />
      </section>
    </ProjectLanding>);
    const workspace = screen.getByRole("region", { name: "Canonical workspace" });
    const remainingSpace = workspace.parentElement!;
    // flex-1 on the canonical route is effective only when its immediate
    // Project parent participates in the same bounded flex-height chain.
    expect(remainingSpace.classList.contains("flex")).toBe(true);
    expect(remainingSpace.classList.contains("flex-col")).toBe(true);
    expect(remainingSpace.classList.contains("min-h-0")).toBe(true);
    expect(remainingSpace.classList.contains("flex-1")).toBe(!showMetadata);
    expect(remainingSpace.classList.contains("shrink")).toBe(showMetadata);
    expect(remainingSpace.classList.contains("overflow-hidden")).toBe(true);
    expect(container.firstElementChild?.classList.contains("overflow-hidden")).toBe(true);
  });

  it("scrolls metadata and Chat cards within a bounded area so short windows keep room for the composer", () => {
    const records = Array.from({ length: 12 }, (_, index) => ({
      chat: { id: `chat_${index}`, title: `Plan ${index}`, attention: "none" }, projectId: project.id,
    } as CanonicalChatRecord));
    const { container } = render(<ProjectLanding project={project} records={records} onSelectChat={vi.fn()}><textarea aria-label="Bottom composer" /></ProjectLanding>);
    const metadata = container.querySelector("header")!;
    expect(metadata.classList.contains("min-h-0")).toBe(true);
    expect(metadata.classList.contains("flex-1")).toBe(true);
    expect(metadata.classList.contains("max-h-[60%]")).toBe(false);
    expect(metadata.classList.contains("overflow-y-auto")).toBe(true);
    // One metadata scroll surface contains both description/files and cards.
    expect(screen.getByLabelText("Alpha chats").classList.contains("overflow-y-auto")).toBe(false);
    expect(screen.getAllByRole("button", { name: /^Open Plan / })).toHaveLength(12);
  });

  it("shows ordinary Project chats including pinned chats as metadata-style cards and opens their stable identity", () => {
    const record = {chat:{id:"chat_alpha",title:"Implementation plan",userState:{pinned:true},attention:"none"},projectId:project.id} as CanonicalChatRecord;
    const onSelectChat=vi.fn();
    render(<ProjectLanding project={project} records={[record]} onSelectChat={onSelectChat}><textarea aria-label="Draft" /></ProjectLanding>);
    fireEvent.click(screen.getByRole("button",{name:"Open Implementation plan"}));
    expect(onSelectChat).toHaveBeenCalledWith(record);
  });

  it("retains provider recovery and the unsent Project input while metadata changes", () => {
    const content = <CanonicalNewChatContent projectId={project.id} workspaceLayout="wide" onSelect={vi.fn()}
      composer={<textarea aria-label="Project draft" defaultValue="Unsaved Project draft" />} />;
    const { rerender } = render(<ProjectLanding project={project}>{content}</ProjectLanding>);
    const draft = screen.getByRole("textbox", { name: "Project draft" });
    expect(screen.getByRole("button", { name: "Connect provider" }).closest('[data-slot="chat-project-draft-scroll"]')).toBeTruthy();
    rerender(<ProjectLanding project={project} showMetadata={false}>{content}</ProjectLanding>);
    expect(screen.queryByRole("heading", { name: "Alpha" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Project draft" })).toBe(draft);
    expect((draft as HTMLTextAreaElement).value).toBe("Unsaved Project draft");
    expect(screen.getByRole("button", { name: "Connect provider" })).toBeTruthy();
  });

  it("shows real Project metadata and keeps the existing composer mounted", () => {
    const { rerender } = render(<ProjectLanding project={project}><textarea aria-label="Existing project composer" defaultValue="Unsaved draft" /></ProjectLanding>);
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByText("Build the customer portal")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Existing project composer" }) as HTMLTextAreaElement).value).toBe("Unsaved draft");
    expect(screen.queryByText("Instructions")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Alpha files" }));
    expect(actions.showInFiles).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Edit Alpha description" }));
    expect(actions.setDialog).toHaveBeenCalledWith("edit");
    const composer = screen.getByRole("textbox", { name: "Existing project composer" });
    rerender(<ProjectLanding project={project} showMetadata={false}><textarea aria-label="Existing project composer" defaultValue="Other text" /></ProjectLanding>);
    expect(screen.queryByRole("heading", { name: "Alpha" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Existing project composer" })).toBe(composer);
    expect((composer as HTMLTextAreaElement).value).toBe("Unsaved draft");
  });
});
