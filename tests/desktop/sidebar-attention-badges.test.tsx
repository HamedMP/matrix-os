// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Sidebar from "../../desktop/src/renderer/src/features/mission-control/Sidebar";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useThreads, type AgentThread } from "../../desktop/src/renderer/src/stores/threads";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

function kernelThread(id: string, overrides: Partial<AgentThread> = {}): AgentThread {
  return {
    id,
    requestId: `request-${id}`,
    sessionId: null,
    taskId: null,
    title: `Run ${id}`,
    status: "running",
    transcript: [],
    unread: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function summaryWithProjectAttention(attentionCount: number) {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [],
    providers: [],
    projects: {
      items: [{
        id: "matrix-os",
        label: "Matrix OS",
        status: "available",
        taskCount: 1,
        threadCount: 2,
        attentionCount,
      }],
      hasMore: false,
      limit: 20,
    },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: {
      maxPromptBytes: 16384,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 8192,
      maxListItems: 20,
    },
    serverTime: "2026-07-06T00:03:00.000Z",
  };
}

describe("Sidebar attention badges", () => {
  beforeEach(() => {
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      displayName: null,
      imageUrl: null,
      platformHost: "https://platform.test",
    });
    useBoard.setState({ projects: [{ slug: "matrix-os", name: "Matrix OS" }] });
    useTabs.setState({ tabs: [], activeTabId: null });
    useThreads.setState({ threads: [], activeThreadId: null });
    useCodingAgentWorkspace.setState({ summary: null, activeThreadId: null });
    useUi.setState({ sidebarCollapsed: false });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the kernel attention count on the Chat row", () => {
    useThreads.setState({
      threads: [
        kernelThread("thread-1-1", { unread: true }),
        kernelThread("thread-1-2", { status: "needs-attention" }),
        kernelThread("thread-1-3"),
      ],
      activeThreadId: null,
    });

    render(
      <Tooltip.Provider>
        <Sidebar />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole("button", { name: /^Chat\s*2$/ })).toBeTruthy();
  });

  it("shows the coding-agent attention count on the project row", () => {
    useCodingAgentWorkspace.setState({ summary: summaryWithProjectAttention(3) });

    render(
      <Tooltip.Provider>
        <Sidebar />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole("button", { name: /Matrix OS\s*3$/ })).toBeTruthy();
  });

  it("no longer offers the retired Agents workspace row", () => {
    useCodingAgentWorkspace.setState({ summary: summaryWithProjectAttention(3) });

    render(
      <Tooltip.Provider>
        <Sidebar />
      </Tooltip.Provider>,
    );

    expect(screen.queryByRole("button", { name: "Agents" })).toBeNull();
  });

  it("shows no badges when nothing needs attention", () => {
    useCodingAgentWorkspace.setState({ summary: summaryWithProjectAttention(0) });

    render(
      <Tooltip.Provider>
        <Sidebar />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole("button", { name: "Chat" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Matrix OS$/ })).toBeTruthy();
  });
});
