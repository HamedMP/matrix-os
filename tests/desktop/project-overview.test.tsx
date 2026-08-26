// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentThreadSummary, RuntimeSummary } from "@matrix-os/contracts";
import ProjectOverview from "../../desktop/src/renderer/src/features/project/ProjectOverview";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useHermesChat } from "../../desktop/src/renderer/src/stores/hermes-chat";
import { useProjectView } from "../../desktop/src/renderer/src/stores/project-view";
import { useProjectWorkspaces } from "../../desktop/src/renderer/src/stores/project-workspaces";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

function thread(index: number): AgentThreadSummary {
  return {
    id: `thread-${index}`,
    providerId: "codex",
    title: `Session ${index}`,
    status: "completed",
    attention: "none",
    projectId: "matrix-os",
    createdAt: new Date(Date.UTC(2026, 7, 20, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 7, 20, 0, index)).toISOString(),
  };
}

function summaryWithThreads(items: AgentThreadSummary[]): RuntimeSummary {
  return {
    capabilities: [],
    providers: [{ id: "codex", kind: "codex", displayName: "Codex" }],
    activeThreads: { items, hasMore: false, limit: 50 },
    attentionThreads: { items: [], hasMore: false, limit: 50 },
  } as RuntimeSummary;
}

function summaryWithProjectComposer(): RuntimeSummary {
  return {
    runtime: { id: "rt_test", label: "Test", status: "available" },
    capabilities: [
      { id: "codingAgentsThreadCreate", enabled: true },
      { id: "codingAgentsProjectWorkspace", enabled: true },
    ],
    providers: [{
      id: "codex",
      kind: "codex",
      displayName: "Codex",
      availability: "available",
      installStatus: "installed",
      authStatus: "authenticated",
      supportedModes: ["default", "plan"],
      defaultMode: "default",
      setupActions: [],
    }],
    projects: {
      items: [{ id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 0, threadCount: 0, attentionCount: 0 }],
      hasMore: false,
      limit: 20,
    },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: { maxPromptBytes: 16_384, maxAttachmentCount: 8, maxTerminalInputBytes: 8_192, maxListItems: 20 },
    serverTime: "2026-08-26T00:00:00.000Z",
  };
}

describe("ProjectOverview", () => {
  beforeEach(() => {
    useCodingAgentWorkspace.setState({ createdThreadHandles: [] });
    useProjectWorkspaces.setState({ entries: {}, runtimeScope: null });
    useHermesChat.setState(useHermesChat.getInitialState(), true);
    useConnection.setState({ api: null });
    useProjectView.setState({ entries: {}, selectionRevisions: {}, runtimeScope: null });
    useTabs.setState(useTabs.getInitialState(), true);
  });

  afterEach(cleanup);

  it("shows an explicit loading state while the runtime summary is unresolved", () => {
    render(
      <ProjectOverview
        projectId="matrix-os"
        projectLabel="Matrix OS"
        summary={null}
        active
        viewSwitch={null}
      />,
    );

    expect(screen.getByText("Loading project workspace…")).toBeTruthy();
    expect(screen.getByText("Fetching chat and workspace capabilities from this Matrix computer.")).toBeTruthy();
  });

  it("shows application-owned copy instead of a raw workspace error", () => {
    useProjectWorkspaces.setState({
      entries: {
        "matrix-os": {
          status: "error",
          workspace: null,
          error: "postgres failed at /home/matrix with sk-secret",
          fetchedAt: 0,
        },
      },
    });

    render(
      <ProjectOverview
        projectId="matrix-os"
        projectLabel="Matrix OS"
        summary={null}
        active={false}
        viewSwitch={null}
      />,
    );

    expect(screen.getByText("Project sessions are unavailable.")).toBeTruthy();
    expect(screen.queryByText(/postgres failed/)).toBeNull();
  });

  it("bounds the rendered recent-session collection", () => {
    render(
      <ProjectOverview
        projectId="matrix-os"
        projectLabel="Matrix OS"
        summary={summaryWithThreads(Array.from({ length: 120 }, (_, index) => thread(index)))}
        active={false}
        viewSwitch={null}
      />,
    );

    expect(screen.getAllByRole("button", { name: /Open session/ })).toHaveLength(100);
    expect(screen.getByRole("button", { name: "Open session Session 119" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open session Session 0" })).toBeNull();
  });

  it("shows canonical Chats that were moved into the Project", () => {
    useHermesChat.setState({
      indexStatus: "ready",
      conversations: [{
        id: "conversation-project",
        title: "Project launch plan",
        preview: "Project launch plan",
        messageCount: 2,
        createdAt: Date.UTC(2026, 7, 20, 0, 0),
        updatedAt: Date.UTC(2026, 7, 20, 1, 0),
        context: {
          projectId: "matrix-os",
          primaryWorkspaceRoot: "/home/matrix/home/projects/matrix-os/repo",
        },
      }],
    });

    render(
      <ProjectOverview
        projectId="matrix-os"
        projectLabel="Matrix OS"
        summary={summaryWithThreads([])}
        active={false}
        viewSwitch={null}
      />,
    );

    expect(screen.getByRole("button", { name: "Open chat Project launch plan" })).toBeTruthy();
    expect(screen.queryByText("No sessions yet. Start one above.")).toBeNull();
  });

  it("keeps a newly created Project Chat visible while server projections catch up", () => {
    const created = thread(121);
    created.title = "New project chat";
    useCodingAgentWorkspace.setState({ createdThreadHandles: [created] });

    render(
      <ProjectOverview
        projectId="matrix-os"
        projectLabel="Matrix OS"
        summary={summaryWithThreads([])}
        active={false}
        viewSwitch={null}
      />,
    );

    expect(screen.getByRole("button", { name: "Open session New project chat" })).toBeTruthy();
    expect(screen.queryByText("No sessions yet. Start one above.")).toBeNull();
  });

  it("opens a moved Chat in the shared Project Chats surface", async () => {
    const projectContext = {
      projectId: "matrix-os",
      projectName: "Matrix OS",
      projectKind: "github" as const,
      status: "ready" as const,
    };
    const get = vi.fn(async (path: string) => {
      if (path === "/api/conversations/conversation-project?limit=50") {
        return {
          id: "conversation-project",
          createdAt: 10,
          updatedAt: 20,
          context: projectContext,
          totalCount: 1,
          messages: [{ index: 0, role: "user", content: "Project launch plan", contentTruncated: false, timestamp: 10 }],
          hasMore: false,
          limit: 50,
        };
      }
      throw new Error(`unexpected api path ${path}`);
    });
    useConnection.setState({ api: { get } as never });
    useHermesChat.setState({
      indexStatus: "ready",
      conversations: [{
        id: "conversation-project",
        title: "Project launch plan",
        preview: "Project launch plan",
        messageCount: 1,
        createdAt: 10,
        updatedAt: 20,
        context: projectContext,
      }],
    });

    render(
      <ProjectOverview
        projectId="matrix-os"
        projectLabel="Matrix OS"
        summary={summaryWithThreads([])}
        active={false}
        viewSwitch={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open chat Project launch plan" }));

    await waitFor(() => expect(useHermesChat.getState().sessionId).toBe("conversation-project"));
    expect(useHermesChat.getState().conversationContext).toEqual(projectContext);
    expect(useProjectView.getState().viewFor("matrix-os")).toBe("chats");
    expect(useProjectView.getState().selectedThreadFor("matrix-os")).toBeNull();
  });

  it("creates the first Project message through canonical Chat and opens that exact Chat", async () => {
    const { snapshot, providerCatalog } = createCanonicalChatFixture("accepted");
    const createdRecord = {
      chat: {
        id: snapshot.chat.id,
        ownerScope: snapshot.chat.ownerScope,
        title: "Inspect the project",
        lifecycle: snapshot.chat.lifecycle,
        attention: snapshot.chat.attention,
        revision: 0,
        messageCount: 0,
        currentSelection: snapshot.chat.currentSelection,
        createdAt: snapshot.chat.createdAt,
        updatedAt: snapshot.chat.updatedAt,
      },
      projectId: "matrix-os",
    };
    const admittedRecord = {
      chat: {
        ...createdRecord.chat,
        revision: snapshot.chat.revision,
        messageCount: snapshot.chat.messageCount,
        lastMessagePreview: snapshot.chat.lastMessagePreview,
      },
      projectId: "matrix-os",
      providerBinding: snapshot.chat.providerBinding,
      activeRun: snapshot.chat.activeRun,
    };
    const get = vi.fn(async (path: string) => {
      if (path === "/api/chats?limit=1&projectId=matrix-os") return { items: [] };
      if (path === "/api/chat-providers") return providerCatalog;
      if (path === "/api/conversations") return { conversations: [] };
      throw new Error(`unexpected api path ${path}`);
    });
    const post = vi.fn(async (path: string) => {
      if (path === "/api/chats") return createdRecord;
      if (path === `/api/chats/${snapshot.chat.id}/turns`) {
        return {
          record: admittedRecord,
          message: snapshot.messages[0],
          turn: snapshot.turns[0],
          run: snapshot.runs[0],
          admission: "accepted",
        };
      }
      throw new Error(`unexpected api path ${path}`);
    });
    const runtimeScope = "operator|https://platform.test|primary";
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: { baseUrl: "https://matrix.test", get, post } as never,
    });
    useProjectWorkspaces.setState({
      runtimeScope,
      entries: {
        "matrix-os": {
          status: "ready",
          workspace: {
            project: { id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 0, threadCount: 0, attentionCount: 0 },
            tasks: { items: [], hasMore: false, limit: 100 },
            projectThreads: { items: [], hasMore: false, limit: 100 },
            taskThreads: { items: [], hasMore: false, limit: 100 },
            updatedAt: "2026-08-26T00:00:00.000Z",
          },
          error: null,
          fetchedAt: Date.now(),
        },
      },
    });
    useTabs.getState().openTab({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
    });
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === "state:get") return { value: null };
          if (channel === "state:set") return { ok: true };
          throw new Error(`unexpected operator channel ${channel}`);
        }),
        on: vi.fn(() => () => undefined),
      },
    });
    render(
      <ProjectOverview
        projectId="matrix-os"
        projectLabel="Matrix OS"
        summary={summaryWithProjectComposer()}
        active
        viewSwitch={null}
      />,
    );

    const picker = await screen.findByRole("button", { name: "Choose model and provider" });
    await waitFor(() => expect(picker.textContent).toContain("GPT-5.6-Sol"));
    expect(picker.textContent).not.toContain("Provider default");
    const composer = screen.getByLabelText("Message new chat");
    for (const key of "Inspect the project") fireEvent.keyDown(window, { key });
    await waitFor(() => expect(composer.textContent).toBe("Inspect the project"));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      "/api/chats",
      expect.objectContaining({
        projectId: "matrix-os",
        title: "Inspect the project",
        currentSelection: expect.objectContaining({
          instanceId: "codex_fixture",
          model: "gpt-5.6-sol",
        }),
      }),
    ));
    expect(post).toHaveBeenCalledWith(
      `/api/chats/${snapshot.chat.id}/turns`,
      expect.objectContaining({
        baseRevision: 0,
        parts: [{ type: "text", text: "Inspect the project" }],
        selection: expect.objectContaining({
          instanceId: "codex_fixture",
          model: "gpt-5.6-sol",
        }),
      }),
    );
    expect(useProjectView.getState().viewFor("matrix-os")).toBe("chats");
    expect(useTabs.getState().tabs.find((tab) => tab.projectSlug === "matrix-os")?.chatId)
      .toBe(snapshot.chat.id);
  });
});
