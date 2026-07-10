jest.mock("@/app/_layout", () => ({
  useGateway: jest.fn(),
}));

jest.mock("@/lib/feature-flags", () => ({
  CODING_AGENTS_MOBILE_WORKSPACE: true,
}));

const mockRouterPush = jest.fn();
const mockRouterReplace = jest.fn();
const mockSearchParams: { reviewId?: string | string[] } = {};

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockSearchParams,
  useFocusEffect: (callback: () => void) => {
    const React = require("react");
    React.useEffect(callback, [callback]);
  },
  useRouter: () => ({
    push: mockRouterPush,
    replace: mockRouterReplace,
  }),
  Stack: { Screen: () => null },
}));

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import AgentsScreen from "../app/agents";
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

function summaryFixture({
  threadCreate = false,
}: { threadCreate?: boolean } = {}) {
  return {
    runtime: {
      id: "rt_primary",
      label: "Primary",
      status: "available",
    },
    capabilities: [
      { id: "codingAgentsRuntimeSummary", enabled: true },
      { id: "codingAgentsReview", enabled: true },
      ...(threadCreate ? [{ id: "codingAgentsThreadCreate", enabled: true }] : []),
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
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: {
      items: [
        {
          id: "thread_mobile",
          providerId: "codex",
          title: "Repair mobile route",
          status: "running",
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:01:00.000Z",
        },
      ],
      hasMore: false,
      limit: 20,
    },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: {
      items: [
        {
          id: "matrix-abc1234",
          name: "matrix-abc1234",
          status: "running",
          attachable: true,
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:01:00.000Z",
        },
      ],
      hasMore: false,
      limit: 20,
    },
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

function attentionSummaryFixture() {
  const summary = summaryFixture();
  return {
    ...summary,
    activeThreads: {
      ...summary.activeThreads,
      items: [
        {
          ...summary.activeThreads.items[0],
          id: "thread_approval",
          title: "Approve deployment",
          status: "waiting_for_approval",
          attention: "approval_required",
        },
        {
          ...summary.activeThreads.items[0],
          id: "thread_input",
          title: "Clarify test target",
          status: "waiting_for_input",
          attention: "input_required",
        },
        {
          ...summary.activeThreads.items[0],
          id: "thread_failed",
          title: "Repair failing run",
          status: "failed",
          attention: "failed",
        },
      ],
    },
  };
}

function attentionOnlySummaryFixture() {
  const summary = summaryFixture();
  return {
    ...summary,
    activeThreads: {
      ...summary.activeThreads,
      items: [],
    },
    attentionThreads: {
      items: [
        {
          ...summary.activeThreads.items[0],
          id: "thread_approval",
          title: "Approve deployment",
          status: "waiting_for_approval",
          attention: "approval_required",
        },
        {
          ...summary.activeThreads.items[0],
          id: "thread_failed",
          title: "Repair failed run",
          status: "failed",
          attention: "failed",
        },
      ],
      hasMore: false,
      limit: 20,
    },
  };
}

function recentWorkSummaryFixture() {
  const summary = summaryFixture({ threadCreate: true });
  const approvalThread = {
    ...summary.activeThreads.items[0],
    id: "thread_approval",
    title: "Approve deploy plan",
    status: "waiting_for_approval",
    attention: "approval_required",
    updatedAt: "2026-07-06T00:02:00.000Z",
  };

  return {
    ...summary,
    projects: {
      items: [{
        id: "matrix-os",
        label: "Matrix OS",
        status: "available",
        taskCount: 1,
        threadCount: 3,
        attentionCount: 1,
      }],
      hasMore: false,
      limit: 20,
    },
    activeThreads: {
      ...summary.activeThreads,
      items: [
        {
          ...summary.activeThreads.items[0],
          id: "thread_newer_running",
          title: "Newer running task",
          status: "running",
          updatedAt: "2026-07-06T00:10:00.000Z",
        },
        {
          ...summary.activeThreads.items[0],
          id: "thread_completed",
          title: "Completed mobile run",
          status: "completed",
          attention: "completed",
          updatedAt: "2026-07-06T00:09:00.000Z",
        },
        {
          ...summary.activeThreads.items[0],
          id: "thread_stale",
          title: "Recover stale mobile run",
          status: "stale",
          attention: "none",
          updatedAt: "2026-07-06T00:08:00.000Z",
        },
      ],
    },
    attentionThreads: {
      items: [approvalThread],
      hasMore: false,
      limit: 20,
    },
    terminalSessions: {
      ...summary.terminalSessions,
      items: [
        {
          ...summary.terminalSessions.items[0],
          id: "matrix-newer",
          name: "matrix-newer",
          status: "running",
          attachable: true,
          updatedAt: "2026-07-06T00:11:00.000Z",
        },
      ],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("AgentsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete mockSearchParams.reviewId;
  });

  it("renders the cockpit summary and workspace navigation cards", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    expect(screen.getByText("Loading workspace...")).toBeTruthy();
    expect(await screen.findByText("Agent workspace")).toBeTruthy();
    expect(screen.getAllByText("Repair mobile route").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Open providers")).toBeTruthy();
    expect(screen.getByLabelText("Open reviews")).toBeTruthy();
    expect(screen.getByLabelText("Open terminals")).toBeTruthy();
  });

  it("navigates to the provider, review, and terminal workspace screens", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByLabelText("Open providers");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open providers"));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open reviews"));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open terminals"));
    });

    expect(mockRouterPush).toHaveBeenCalledWith("/agents/providers");
    expect(mockRouterPush).toHaveBeenCalledWith("/agents/reviews");
    expect(mockRouterPush).toHaveBeenCalledWith("/agents/terminals");
  });

  it("forwards a valid review deep link to the reviews screen", async () => {
    mockSearchParams.reviewId = "review_abc123";
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await act(async () => {});

    expect(mockRouterReplace).toHaveBeenCalledWith({
      pathname: "/agents/reviews",
      params: { reviewId: "review_abc123" },
    });
  });

  it("ignores an invalid review deep link without redirecting", async () => {
    mockSearchParams.reviewId = "../etc/passwd";
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("Agent workspace");

    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it("shows an agent workspace offline banner without hiding the hydrated summary", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "disconnected",
    }));

    render(<AgentsScreen />);

    expect(await screen.findByText("Agent workspace offline")).toBeTruthy();
    expect(screen.getAllByText("Repair mobile route").length).toBeGreaterThan(0);
    expect(screen.getByTestId("agent-thread-status-thread_mobile")).toBeTruthy();
    expect(screen.queryByText(/token|bearer|secret|\/home\/matrix/i)).toBeNull();
  });

  it("offers a safe reconnect action from the agent workspace banner", async () => {
    const connect = jest.fn();
    const client = {
      connect,
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "error",
    }));

    render(<AgentsScreen />);

    expect(await screen.findByText("Agent workspace reconnecting")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText("Retry"));
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/token|bearer|secret|\/home\/matrix/i)).toBeNull();
  });

  it("opens a mobile thread detail route from active threads", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findAllByText("Repair mobile route");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open thread Repair mobile route"));
    });

    expect(mockRouterPush).toHaveBeenCalledWith("/agents/thread_mobile");
  });

  it("renders reachable in-app attention badges for active coding-agent threads", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: attentionSummaryFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    expect((await screen.findAllByText("Approve deployment")).length).toBeGreaterThan(0);
    expect(screen.getByText(/codex · Approval needed/)).toBeTruthy();
    expect(screen.getByText(/codex · Input needed/)).toBeTruthy();
    expect(screen.getByLabelText("Open thread Approve deployment, Approval needed")).toBeTruthy();
    expect(screen.getByLabelText("Open thread Clarify test target, Input needed")).toBeTruthy();
    expect(screen.getByLabelText("Open thread Repair failing run, Failed")).toBeTruthy();
    expect(screen.queryByText("Run failed")).toBeNull();
    expect(screen.queryByText(/home\/matrix|token|secret|stack trace/i)).toBeNull();
  });

  it("merges gateway-owned attention threads into the primary cockpit", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: attentionOnlySummaryFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    expect(await screen.findByText("Needs attention")).toBeTruthy();
    expect(screen.getAllByText("Approve deployment")).toHaveLength(1);
    expect(screen.getAllByText("Repair failed run")).toHaveLength(1);
    expect(screen.getByText(/codex · Approval needed/)).toBeTruthy();
    expect(screen.getByText(/codex · Failed/)).toBeTruthy();
    expect(screen.queryByText("No projects or agent runs yet.")).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open thread Repair failed run, Failed"));
    });
    expect(mockRouterPush).toHaveBeenCalledWith("/agents/thread_failed");
  });

  it("prioritizes pending approval work before active runs", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: recentWorkSummaryFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("Needs attention");
    expect(screen.getByLabelText("Open thread Approve deploy plan, Approval needed")).toBeTruthy();
    expect(screen.getByLabelText("Open thread Newer running task")).toBeTruthy();

    const buttonOrder = screen.getAllByRole("button").map((node) => node.props.accessibilityLabel);
    expect(buttonOrder.indexOf("Open thread Approve deploy plan, Approval needed"))
      .toBeLessThan(buttonOrder.indexOf("Open thread Newer running task"));

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Start a new agent run"));
    });
    expect(mockRouterPush).toHaveBeenCalledWith("/agents/new");
  });

  it("presents a deduplicated attention-first mobile cockpit", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: recentWorkSummaryFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    expect(await screen.findByText("What do you want Matrix to build?")).toBeTruthy();
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("No project")).toBeTruthy();
    expect(screen.getAllByText("Approve deploy plan")).toHaveLength(1);
    expect(screen.getAllByText("Newer running task")).toHaveLength(1);
    expect(screen.getAllByText("Completed mobile run")).toHaveLength(1);
    expect(screen.getAllByText("Recover stale mobile run")).toHaveLength(1);
    expect(screen.queryByText("Active Threads")).toBeNull();

    const buttonOrder = screen.getAllByRole("button").map((node) => node.props.accessibilityLabel);
    expect(buttonOrder.indexOf("Open thread Approve deploy plan, Approval needed"))
      .toBeLessThan(buttonOrder.indexOf("Open thread Newer running task"));

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Start a new agent run"));
    });
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/agents/new",
      params: { projectId: "matrix-os" },
    });
  });

  it("keeps completed and recoverable stale threads reachable", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: recentWorkSummaryFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("No project");
    fireEvent.press(screen.getByLabelText("Open thread Completed mobile run"));
    fireEvent.press(screen.getByLabelText("Open thread Recover stale mobile run"));

    expect(mockRouterPush).toHaveBeenCalledWith("/agents/thread_completed");
    expect(mockRouterPush).toHaveBeenCalledWith("/agents/thread_stale");
  });

  it("renders long thread titles on multiple lines with a static status", async () => {
    const longTitle = "Investigate the mobile runtime reconciliation failure after reconnecting to a remote computer";
    const summary = summaryFixture();
    summary.activeThreads.items[0] = { ...summary.activeThreads.items[0], title: longTitle };
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({ ok: true, summary }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    const title = await screen.findByText(longTitle);
    expect(title.props.numberOfLines).toBe(2);
    expect(screen.getByTestId("agent-thread-status-thread_mobile")).toBeTruthy();
  });

  it("lets iOS own automatic safe-area adjustment without manual inset padding", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({ ok: true, summary: summaryFixture() }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    const scroll = await screen.findByLabelText("Refresh agent workspace");
    expect(scroll.props.contentInsetAdjustmentBehavior).toBe("automatic");
    expect(scroll.props.contentContainerStyle).toEqual(expect.objectContaining({
      paddingTop: 24,
      paddingBottom: 32,
    }));
  });

  it("keeps many working agent runs reachable in the cockpit", async () => {
    const summary = summaryFixture();
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: {
          ...summary,
          activeThreads: {
            ...summary.activeThreads,
            items: Array.from({ length: 7 }, (_, index) => ({
              ...summary.activeThreads.items[0],
              id: `thread_recent_${index}`,
              title: `Active task ${index}`,
              status: "running",
              updatedAt: `2026-07-06T00:0${index}:00.000Z`,
            })),
          },
        },
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("No project");
    expect(screen.getByLabelText("Open thread Active task 1")).toBeTruthy();
    expect(screen.getByLabelText("Open thread Active task 6")).toBeTruthy();
  });

  it("renders a safe error when the runtime summary is unavailable", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: false,
        error: "Runtime summary unavailable",
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    expect(await screen.findByText("Runtime summary unavailable")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix/)).toBeNull();
  });

  it("ignores a delayed summary from a previous gateway client", async () => {
    const oldRequest = deferred<{ ok: true; summary: ReturnType<typeof summaryFixture> }>();
    const oldClient = {
      getCodingAgentRuntimeSummary: jest.fn(() => oldRequest.promise),
    };
    const newClient = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: {
          ...summaryFixture(),
          runtime: {
            id: "rt_new",
            label: "New runtime",
            status: "available",
          },
        },
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: oldClient as unknown as GatewayClient,
      connectionState: "connected",
    }));

    const view = render(<AgentsScreen />);

    useGatewayMock.mockReturnValue(gatewayContext({
      client: newClient as unknown as GatewayClient,
      connectionState: "connected",
    }));
    view.rerender(<AgentsScreen />);
    await screen.findByText("New runtime");

    await act(async () => {
      oldRequest.resolve({
        ok: true,
        summary: {
          ...summaryFixture(),
          runtime: {
            id: "rt_old",
            label: "Old runtime",
            status: "available",
          },
        },
      });
      await oldRequest.promise;
    });

    expect(screen.getByText("New runtime")).toBeTruthy();
    expect(screen.queryByText("Old runtime")).toBeNull();
  });
});
