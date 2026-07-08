// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentWorkspace from "../../desktop/src/renderer/src/features/coding-agents/AgentWorkspace";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

function summaryFixture() {
  return {
    runtime: {
      id: "rt_primary",
      label: "Primary",
      status: "available",
    },
    capabilities: [
      {
        id: "codingAgentsRuntimeSummary",
        enabled: true,
      },
      {
        id: "codingAgentsThreadCreate",
        enabled: false,
        reason: "Not enabled yet",
      },
    ],
    providers: [
      {
        id: "codex",
        kind: "codex",
        displayName: "Codex",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default"],
        defaultMode: "default",
        setupActions: [],
      },
    ],
    projects: {
      items: [],
      hasMore: false,
      limit: 20,
    },
    activeThreads: {
      items: [
        {
          id: "thread_alpha",
          providerId: "codex",
          title: "Fix settings route",
          status: "running",
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:01:00.000Z",
        },
      ],
      hasMore: false,
      limit: 20,
    },
    terminalSessions: {
      items: [
        {
          id: "matrix-abc1234",
          name: "matrix-abc1234",
          status: "running",
          attachable: true,
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:02:00.000Z",
        },
      ],
      hasMore: false,
      limit: 20,
    },
    recentActivity: {
      items: [],
      hasMore: false,
      limit: 20,
    },
    limits: {
      maxPromptBytes: 16384,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 8192,
      maxListItems: 20,
    },
    serverTime: "2026-07-06T00:03:00.000Z",
  };
}

describe("AgentWorkspace", () => {
  beforeEach(() => {
    useCodingAgentWorkspace.setState({ status: "idle", summary: null, error: null });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: null,
    });
    window.operator = {
      invoke: vi.fn().mockResolvedValue(summaryFixture()),
      on: vi.fn(() => () => undefined),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders provider, thread, and terminal summaries from trusted IPC", async () => {
    render(<AgentWorkspace />);

    expect(screen.getByText("Loading workspace...")).toBeTruthy();
    await screen.findByText("Primary");
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Fix settings route")).toBeTruthy();
    expect(screen.getByText("matrix-abc1234")).toBeTruthy();
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:get-summary", {});
  });

  it("shows a generic safe error when summary refresh fails", async () => {
    window.operator.invoke = vi.fn().mockRejectedValue(
      new Error("connect ECONNREFUSED /home/matrix/private"),
    );

    render(<AgentWorkspace />);

    await screen.findByText("Runtime summary unavailable");
    expect(screen.queryByText(/home\/matrix/)).toBeNull();
  });
});
