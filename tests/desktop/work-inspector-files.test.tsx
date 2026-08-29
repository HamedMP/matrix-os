// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import WorkTab from "@desktop/renderer/src/features/work/WorkTab";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { useBoard, type Project } from "@desktop/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "@desktop/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useProjectView } from "@desktop/renderer/src/stores/project-view";
import { useProjectWorkspaces } from "@desktop/renderer/src/stores/project-workspaces";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useUi } from "@desktop/renderer/src/stores/ui";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

class NoopResizeObserver implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

const project: Project = {
  id: "project_stable",
  slug: "matrix-os",
  name: "Matrix OS",
  kind: "github",
};
const { snapshot, providerCatalog } = createCanonicalChatFixture("completed");

function detail(projectId?: string): CanonicalChatDetailResponse {
  return {
    record: {
      chat: {
        id: snapshot.chat.id,
        ownerScope: snapshot.chat.ownerScope,
        title: snapshot.chat.title,
        lifecycle: snapshot.chat.lifecycle,
        attention: snapshot.chat.attention,
        revision: snapshot.chat.revision,
        messageCount: snapshot.chat.messageCount,
        currentSelection: snapshot.chat.currentSelection,
        createdAt: snapshot.chat.createdAt,
        updatedAt: snapshot.chat.updatedAt,
      },
      ...(projectId ? { projectId } : {}),
    },
    messages: snapshot.messages,
    turns: snapshot.turns,
    runs: projectId
      ? snapshot.runs.map((run) => ({
          ...run,
          executionRoot: { kind: "worktree" as const, projectId, worktreeId: "wt_selected" },
        }))
      : snapshot.runs,
    activities: snapshot.activities,
  };
}

function apiFor(chatDetail: CanonicalChatDetailResponse): ApiClient {
  const get = vi.fn(async (path: string) => {
    if (path === "/api/chat-providers" || path === "/api/chat-providers?refresh=true") {
      return providerCatalog;
    }
    if (path.startsWith(`/api/chats/${chatDetail.record.chat.id}`)) return chatDetail;
    if (path.startsWith("/api/chats")) return { items: [chatDetail.record] };
    if (path.startsWith("/api/files/list?path=")) return { entries: [] };
    if (path.startsWith("/api/projects/matrix-os/tasks?")) return { tasks: [], nextCursor: null };
    throw new Error(`Unexpected Work composition request: ${path}`);
  });
  return {
    baseUrl: "https://matrix.test",
    get,
    getText: vi.fn(),
    getBlob: vi.fn(),
    post: vi.fn(),
    postBytes: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    putBytes: vi.fn(),
    delete: vi.fn(),
    putText: vi.fn(),
  } as ApiClient;
}

function connect(chatDetail: CanonicalChatDetailResponse) {
  useConnection.setState({
    ...useConnection.getInitialState(),
    status: "signed-in",
    runtimeSlot: "primary",
    authGeneration: 1,
    api: apiFor(chatDetail),
  }, true);
}

describe("Work Files inspector composition", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = NoopResizeObserver;
  });

  beforeEach(() => {
    useBoard.setState({ ...useBoard.getInitialState(), projects: [project] }, true);
    useCodingAgentWorkspace.setState({
      ...useCodingAgentWorkspace.getInitialState(),
      status: "ready",
    }, true);
    useProjectView.setState(useProjectView.getInitialState(), true);
    useProjectWorkspaces.setState(useProjectWorkspaces.getInitialState(), true);
    useTabs.setState(useTabs.getInitialState(), true);
    useUi.setState(useUi.getInitialState(), true);
    Object.defineProperty(window, "operator", {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === "state:get") return { value: null };
          if (channel === "runtime:browse-files") {
            return { directory: { kind: "directory" }, entries: { items: [] } };
          }
          return { ok: true };
        }),
        on: vi.fn(() => () => undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("forwards the selected Global Chat detail through the actual Work composition", async () => {
    const chatDetail = detail();
    connect(chatDetail);

    render(
      <WorkTab
        route="chat"
        active
        initialChatId={chatDetail.record.chat.id}
        initialChatView="conversation"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Show inspector" }));
    expect(await screen.findByRole("complementary", { name: "Chat inspector" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Files" })).toBeTruthy();
    expect(screen.getByText("Matrix Home")).toBeTruthy();
  });

  it("forwards the selected Project Chat detail and worktree through the actual Work composition", async () => {
    const chatDetail = detail("project_stable");
    connect(chatDetail);
    useProjectView.getState().setView("matrix-os", "chats");

    render(
      <WorkTab
        route="project"
        projectSlug="matrix-os"
        active
        initialChatId={chatDetail.record.chat.id}
        initialChatView="conversation"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Show inspector" }));
    expect(await screen.findByText("Matrix OS worktree")).toBeTruthy();
    await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledWith("runtime:browse-files", {
      projectId: "matrix-os",
      worktreeId: "wt_selected",
      limit: 100,
    }));
  });

  it.each(["draft", "index"] as const)("does not render an inspector for the Global Chat %s view", async (view) => {
    connect(detail());

    render(<WorkTab route="chat" active initialChatView={view} />);

    if (view === "draft") await screen.findByRole("textbox", { name: "Start a chat" });
    else await screen.findByText("Recents");
    expect(screen.queryByRole("complementary", { name: "Chat inspector" })).toBeNull();
  });
});
