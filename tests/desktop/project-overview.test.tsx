// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentThreadSummary, RuntimeSummary } from "@matrix-os/contracts";
import ProjectOverview from "../../desktop/src/renderer/src/features/project/ProjectOverview";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useHermesChat } from "../../desktop/src/renderer/src/stores/hermes-chat";
import { useProjectView } from "../../desktop/src/renderer/src/stores/project-view";
import { useProjectWorkspaces } from "../../desktop/src/renderer/src/stores/project-workspaces";

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

describe("ProjectOverview", () => {
  beforeEach(() => {
    useProjectWorkspaces.setState({ entries: {}, runtimeScope: null });
    useHermesChat.setState(useHermesChat.getInitialState(), true);
    useConnection.setState({ api: null });
    useProjectView.setState({ entries: {}, selectionRevisions: {}, runtimeScope: null });
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
});
