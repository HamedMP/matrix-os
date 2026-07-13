jest.mock("@/app/_layout", () => ({
  useGateway: jest.fn(),
}));

jest.mock("@/lib/feature-flags", () => ({
  CODING_AGENTS_MOBILE_WORKSPACE: true,
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

let mockSafeAreaInsets = { top: 24, right: 0, bottom: 0, left: 0 };

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockSafeAreaInsets,
}));

const mockRouterPush = jest.fn();
let mockSearchParams: Record<string, string | string[] | undefined> = {};

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockSearchParams,
  useRouter: () => ({
    push: mockRouterPush,
    back: jest.fn(),
  }),
}));

import React from "react";
import { KeyboardAvoidingView } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import AgentComposerScreen from "../components/AgentComposerScreen";
import { useGateway } from "@/app/_layout";
import type { GatewayClient } from "../lib/gateway-client";

const useGatewayMock = useGateway as jest.MockedFunction<typeof useGateway>;
type GatewayContextValue = ReturnType<typeof useGateway>;

function gatewayContext(overrides: Partial<GatewayContextValue>): GatewayContextValue {
  return {
    client: null,
    connectionState: "disconnected",
    gateway: null,
    setGateway: jest.fn(),
    unreadCount: 0,
    incrementUnread: jest.fn(),
    clearUnread: jest.fn(),
    ...overrides,
  };
}

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
        enabled: true,
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
        supportedModes: ["default", "review"],
        defaultMode: "default",
        setupActions: [],
      },
      {
        id: "claude",
        kind: "custom",
        displayName: "Claude",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default"],
        defaultMode: "default",
        setupActions: [],
      },
    ],
    projects: {
      items: [{
        id: "matrix-os",
        label: "Matrix OS",
        status: "available",
        taskCount: 2,
        threadCount: 3,
        attentionCount: 0,
      }],
      hasMore: false,
      limit: 20,
    },
    activeThreads: { items: [], hasMore: false, limit: 20 },
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

function reviewHunkRouteParams(): Record<string, string> {
  return {
    reviewId: "rev_mobile_1",
    projectId: "matrix-os",
    pullRequestNumber: "759",
    round: "2",
    maxRounds: "3",
    filePath: "packages/gateway/src/coding-agents/routes.ts",
    hunkId: "hunk_rev_mobile_1_0_1",
    hunkIndex: "1",
    oldStart: "88",
    oldLines: "1",
    newStart: "93",
    newLines: "2",
  };
}

function threadFollowUpRouteParams(): Record<string, string> {
  return {
    sourceThreadId: "thread_mobile",
    sourceThreadTitle: "Repair mobile route",
    sourceProviderId: "codex",
    projectId: "matrix-os",
    taskId: "task_mobile",
  };
}

describe("AgentComposerScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParams = {};
    mockSafeAreaInsets = { top: 24, right: 0, bottom: 0, left: 0 };
  });

  it("requires a prompt before creating a run", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      createCodingAgentThread: jest.fn().mockResolvedValue({
        ok: false,
        error: "Agent run could not be started. Try again.",
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentComposerScreen />);

    await screen.findByLabelText("Agent run prompt");
    fireEvent.press(screen.getByRole("button", { name: "Start run" }));

    expect(await screen.findByText("Enter a prompt before starting an agent run.")).toBeTruthy();
    expect(client.createCodingAgentThread).not.toHaveBeenCalled();
  });

  it("creates a run and navigates to the accepted thread", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      createCodingAgentThread: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: {
          thread: {
            id: "thread_mobile_create",
            providerId: "codex",
            title: "Investigate mobile composer",
            status: "queued",
            attention: "none",
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z",
          },
          events: {
            items: [],
            hasMore: false,
            limit: 200,
          },
        },
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentComposerScreen />);

    fireEvent.changeText(await screen.findByLabelText("Agent run prompt"), "Investigate mobile composer");
    fireEvent.press(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => {
      expect(client.createCodingAgentThread).toHaveBeenCalledWith(expect.objectContaining({
        providerId: "codex",
        projectId: "matrix-os",
        prompt: "Investigate mobile composer",
        clientRequestId: expect.stringMatching(/^req_mobile_/),
      }));
      expect(mockRouterPush).toHaveBeenCalledWith({
        pathname: "/agents/[threadId]",
        params: { threadId: "thread_mobile_create" },
      });
    });
    expect(AsyncStorage.getItem).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it("requires an explicit project selection when several projects are available", async () => {
    const summary = summaryFixture();
    summary.projects.items.push({
      ...summary.projects.items[0],
      id: "mobile-client",
      label: "Mobile Client",
    });
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({ ok: true, summary }),
      createCodingAgentThread: jest.fn().mockResolvedValue({
        ok: false,
        error: "Agent run could not be started. Try again.",
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentComposerScreen />);

    expect(await screen.findByLabelText("Project None")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Project None"));
    fireEvent.press(screen.getByLabelText("Mobile Client"));
    fireEvent.changeText(screen.getByLabelText("Agent run prompt"), "Repair project selection");
    fireEvent.press(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => {
      expect(client.createCodingAgentThread).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "mobile-client",
        taskId: undefined,
      }));
    });
  });

  it("never creates an unassigned chat when no project is selected", async () => {
    const summary = summaryFixture();
    summary.projects.items.push({
      ...summary.projects.items[0],
      id: "mobile-client",
      label: "Mobile Client",
    });
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({ ok: true, summary }),
      createCodingAgentThread: jest.fn(),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentComposerScreen />);

    fireEvent.changeText(await screen.findByLabelText("Agent run prompt"), "Do not create this unassigned");
    fireEvent.press(screen.getByRole("button", { name: "Start run" }));

    expect(await screen.findByText("Choose a project before starting an agent run.")).toBeTruthy();
    expect(client.createCodingAgentThread).not.toHaveBeenCalled();
  });

  it("offers project creation when every summary project is unavailable", async () => {
    const summary = summaryFixture();
    summary.projects.items = [{
      ...summary.projects.items[0],
      status: "stale",
    }];
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({ ok: true, summary }),
      createProject: jest.fn(),
      createCodingAgentThread: jest.fn(),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentComposerScreen />);

    expect(await screen.findByText("Create or import a project first")).toBeTruthy();
    expect(screen.getByLabelText("New project name")).toBeTruthy();
    expect(screen.queryByLabelText("Project Matrix OS")).toBeNull();
  });

  it("does not remap an explicit stale project route to an unrelated project", async () => {
    mockSearchParams = {
      ...reviewHunkRouteParams(),
      projectId: "removed-project",
    };
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({ ok: true, summary: summaryFixture() }),
      createCodingAgentThread: jest.fn(),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentComposerScreen />);

    expect(await screen.findByLabelText("Project None")).toBeTruthy();
    expect(screen.getByLabelText("Agent run prompt").props.value).toContain("Project: removed-project");
    fireEvent.press(screen.getByRole("button", { name: "Start run" }));

    expect(await screen.findByText("Choose a project before starting an agent run.")).toBeTruthy();
    expect(client.createCodingAgentThread).not.toHaveBeenCalled();
  });

  it("covers empty runtime to project creation to canonical thread navigation", async () => {
    const emptySummary = summaryFixture();
    emptySummary.projects.items = [];
    const hydratedSummary = summaryFixture();
    hydratedSummary.projects.items = [{
      ...hydratedSummary.projects.items[0],
      id: "mobile-project",
      label: "Mobile Project",
    }];
    const client = {
      getCodingAgentRuntimeSummary: jest.fn()
        .mockResolvedValueOnce({ ok: true, summary: emptySummary })
        .mockResolvedValueOnce({ ok: true, summary: hydratedSummary }),
      createProject: jest.fn().mockResolvedValue({
        ok: true,
        project: {
          id: "mobile-project",
          label: "Mobile Project",
          status: "available",
          taskCount: 0,
          threadCount: 0,
          attentionCount: 0,
        },
        existing: false,
      }),
      createCodingAgentThread: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: {
          thread: {
            id: "thread_mobile_project",
            providerId: "codex",
            projectId: "mobile-project",
            title: "Build project chat",
            status: "queued",
            attention: "none",
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z",
          },
          events: { items: [], hasMore: false, limit: 200 },
        },
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentComposerScreen />);

    expect(await screen.findByText("Create or import a project first")).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText("New project name"), "Mobile Project");
    fireEvent.press(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByLabelText("Project Mobile Project")).toBeTruthy();
    expect(client.createProject).toHaveBeenCalledWith({
      mode: "scratch",
      name: "Mobile Project",
      clientRequestId: expect.stringMatching(/^req_mobile_/),
    });
    fireEvent.changeText(screen.getByLabelText("Agent run prompt"), "Build project chat");
    fireEvent.press(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => {
      expect(client.createCodingAgentThread).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "mobile-project",
        prompt: "Build project chat",
      }));
      expect(mockRouterPush).toHaveBeenCalledWith({
        pathname: "/agents/[threadId]",
        params: { threadId: "thread_mobile_project" },
      });
    });
    expect(AsyncStorage.getItem).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it("imports a GitHub project through the same empty state", async () => {
    const summary = summaryFixture();
    summary.projects.items = [];
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({ ok: true, summary }),
      createProject: jest.fn().mockResolvedValue({
        ok: false,
        error: "Project could not be created. Try again.",
      }),
      createCodingAgentThread: jest.fn(),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentComposerScreen />);

    await screen.findByText("Create or import a project first");
    fireEvent.press(screen.getByRole("button", { name: "Import GitHub project" }));
    fireEvent.changeText(screen.getByLabelText("GitHub repository URL"), "https://github.com/acme/mobile");
    fireEvent.press(screen.getByRole("button", { name: "Import project" }));

    await waitFor(() => {
      expect(client.createProject).toHaveBeenCalledWith({
        mode: "github",
        repositoryUrl: "https://github.com/acme/mobile",
        clientRequestId: expect.stringMatching(/^req_mobile_/),
      });
    });
  });

  it("reuses the project request id when the user retries the same create", async () => {
    const summary = summaryFixture();
    summary.projects.items = [];
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({ ok: true, summary }),
      createProject: jest.fn()
        .mockResolvedValueOnce({ ok: false, error: "Project could not be created. Try again." })
        .mockResolvedValueOnce({ ok: false, error: "Project could not be created. Try again." }),
      createCodingAgentThread: jest.fn(),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentComposerScreen />);

    await screen.findByText("Create or import a project first");
    fireEvent.changeText(screen.getByLabelText("New project name"), "Retry Project");
    fireEvent.press(screen.getByRole("button", { name: "Create project" }));
    await screen.findByText("Project could not be created. Try again.");
    fireEvent.press(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(client.createProject).toHaveBeenCalledTimes(2));
    const firstRequest = client.createProject.mock.calls[0]?.[0];
    const secondRequest = client.createProject.mock.calls[1]?.[0];
    expect(firstRequest.clientRequestId).toMatch(/^req_mobile_/);
    expect(secondRequest.clientRequestId).toBe(firstRequest.clientRequestId);
  });

  it("seeds and submits a selected review hunk follow-up from route params", async () => {
    mockSearchParams = reviewHunkRouteParams();
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      createCodingAgentThread: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: {
          thread: {
            id: "thread_mobile_review_followup",
            providerId: "codex",
            title: "Follow up on review hunk",
            status: "queued",
            attention: "none",
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z",
          },
          events: {
            items: [],
            hasMore: false,
            limit: 200,
          },
        },
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentComposerScreen />);

    const prompt = await screen.findByLabelText("Agent run prompt");
    expect(prompt.props.value).toContain("PR #759");
    expect(prompt.props.value).toContain("packages/gateway/src/coding-agents/routes.ts");
    expect(prompt.props.value).toContain("@@ -88,1 +93,2 @@");
    expect(prompt.props.value).not.toMatch(/export const|function create|raw diff/i);

    fireEvent.press(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => {
      expect(client.createCodingAgentThread).toHaveBeenCalledWith(expect.objectContaining({
        providerId: "codex",
        projectId: "matrix-os",
        prompt: expect.stringContaining("Please follow up on this review hunk."),
        attachments: [
          expect.objectContaining({
            id: "review:rev_mobile_1:hunk:hunk_rev_mobile_1_0_1",
            kind: "structured_ref",
            label: "Review hunk 2",
            path: "packages/gateway/src/coding-agents/routes.ts",
          }),
        ],
      }));
      expect(mockRouterPush).toHaveBeenCalledWith({
        pathname: "/agents/[threadId]",
        params: { threadId: "thread_mobile_review_followup" },
      });
    });
  });

  it("seeds and submits a bounded source-thread follow-up from route params", async () => {
    mockSearchParams = threadFollowUpRouteParams();
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      createCodingAgentThread: jest.fn().mockResolvedValue({
        ok: true,
        snapshot: {
          thread: {
            id: "thread_mobile_followup",
            providerId: "codex",
            title: "Follow up on thread",
            status: "queued",
            attention: "none",
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z",
          },
          events: {
            items: [],
            hasMore: false,
            limit: 200,
          },
        },
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentComposerScreen />);

    const prompt = await screen.findByLabelText("Agent run prompt");
    expect(prompt.props.value).toContain("Please follow up on this agent run.");
    expect(prompt.props.value).toContain("Thread: thread_mobile");
    expect(prompt.props.value).toContain("Title: Repair mobile route");
    expect(prompt.props.value).not.toMatch(/evt_mobile|matrix-abc1234|home\/matrix|token|secret/i);

    fireEvent.press(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => {
      expect(client.createCodingAgentThread).toHaveBeenCalledWith(expect.objectContaining({
        providerId: "codex",
        projectId: "matrix-os",
        taskId: "task_mobile",
        prompt: expect.stringContaining("Please follow up on this agent run."),
        attachments: [
          expect.objectContaining({
            id: "thread:thread_mobile",
            kind: "structured_ref",
            label: "Source thread",
          }),
        ],
      }));
      expect(mockRouterPush).toHaveBeenCalledWith({
        pathname: "/agents/[threadId]",
        params: { threadId: "thread_mobile_followup" },
      });
    });
  });

  it("applies review hunk route params that arrive after the initial draft", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      createCodingAgentThread: jest.fn(),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    const view = render(<AgentComposerScreen />);

    const prompt = await screen.findByLabelText("Agent run prompt");
    expect(prompt.props.value).toBe("");

    mockSearchParams = reviewHunkRouteParams();
    view.rerender(<AgentComposerScreen />);

    await waitFor(() => {
      expect(screen.getByLabelText("Agent run prompt").props.value).toContain("PR #759");
      expect(screen.getByLabelText("Agent run prompt").props.value).toContain("@@ -88,1 +93,2 @@");
    });
  });

  it("applies source-thread route params that arrive after a provider change", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      createCodingAgentThread: jest.fn(),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    const view = render(<AgentComposerScreen />);

    const prompt = await screen.findByLabelText("Agent run prompt");
    expect(prompt.props.value).toBe("");

    fireEvent.press(screen.getByLabelText("Provider Codex"));
    fireEvent.press(screen.getByLabelText("Claude"));
    expect(screen.getByLabelText("Provider Claude")).toBeTruthy();

    mockSearchParams = threadFollowUpRouteParams();
    view.rerender(<AgentComposerScreen />);

    await waitFor(() => {
      expect(screen.getByLabelText("Agent run prompt").props.value).toContain("Thread: thread_mobile");
      expect(screen.getByLabelText("Agent run prompt").props.value).toContain("Title: Repair mobile route");
      expect(screen.getByLabelText("Provider Claude")).toBeTruthy();
    });
  });

  it("shows a safe create failure message", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      createCodingAgentThread: jest.fn().mockResolvedValue({
        ok: false,
        error: "Agent run could not be started. Try again.",
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentComposerScreen />);

    fireEvent.changeText(await screen.findByLabelText("Agent run prompt"), "Investigate mobile composer");
    fireEvent.press(screen.getByRole("button", { name: "Start run" }));

    expect(await screen.findByText("Agent run could not be started. Try again.")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("does not create duplicate runs from rapid repeated submit presses", async () => {
    let resolveCreate: (value: unknown) => void = () => undefined;
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      createCodingAgentThread: jest.fn(() => new Promise((resolve) => {
        resolveCreate = resolve;
      })),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentComposerScreen />);

    fireEvent.changeText(await screen.findByLabelText("Agent run prompt"), "Investigate duplicate submits");
    const startButton = screen.getByRole("button", { name: "Start run" });
    act(() => {
      fireEvent.press(startButton);
      fireEvent.press(startButton);
    });

    expect(client.createCodingAgentThread).toHaveBeenCalledTimes(1);
    resolveCreate({
      ok: true,
      snapshot: {
        thread: {
          id: "thread_mobile_duplicate",
          providerId: "codex",
          title: "Investigate duplicate submits",
          status: "queued",
          attention: "none",
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
        },
        events: {
          items: [],
          hasMore: false,
          limit: 200,
        },
      },
    });
    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/agents/[threadId]",
      params: { threadId: "thread_mobile_duplicate" },
    }));
  });

  it("preserves typed prompt when choosing another provider", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      createCodingAgentThread: jest.fn(),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentComposerScreen />);

    const prompt = await screen.findByLabelText("Agent run prompt");
    fireEvent.changeText(prompt, "Keep this prompt");
    fireEvent.press(screen.getByRole("button", { name: "Provider Codex" }));
    fireEvent.press(screen.getByRole("button", { name: "Claude" }));

    expect(screen.getByLabelText("Agent run prompt").props.value).toBe("Keep this prompt");
  });

  it("keeps the composer inside a keyboard-aware layout", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      createCodingAgentThread: jest.fn(),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    const view = render(<AgentComposerScreen />);

    expect(await screen.findByLabelText("Agent composer keyboard area")).toBeTruthy();
    expect(view.UNSAFE_getByType(KeyboardAvoidingView).props.keyboardVerticalOffset).toBe(24);
    expect(screen.getByLabelText("Agent run prompt")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start run" })).toBeTruthy();
  });
});
