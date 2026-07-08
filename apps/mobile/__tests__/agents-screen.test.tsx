jest.mock("@/app/_layout", () => ({
  useGateway: jest.fn(),
}));

jest.mock("@/lib/feature-flags", () => ({
  CODING_AGENTS_MOBILE_WORKSPACE: true,
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: jest.fn(),
  }),
}));

import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react-native";
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
        id: "codingAgentsReview",
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

function reviewsFixture() {
  return {
    items: [
      {
        id: "rev_mobile_1",
        projectId: "matrix-os",
        worktreeId: "wt_mobile_1",
        status: "reviewing",
        pullRequestNumber: 759,
        round: 2,
        maxRounds: 3,
        reviewer: "matrix-reviewer",
        implementer: "matrix-implementer",
        findings: {
          total: 2,
          high: 1,
          medium: 1,
          low: 0,
        },
        updatedAt: "2026-07-06T00:02:00.000Z",
      },
    ],
    hasMore: false,
    limit: 50,
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
  });

  it("renders provider, thread, and terminal summaries", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    expect(screen.getByText("Loading workspace...")).toBeTruthy();
    await screen.findByText("Codex");
    expect(screen.getByText("Repair mobile route")).toBeTruthy();
    expect(screen.getByText("matrix-abc1234")).toBeTruthy();
  });

  it("renders read-only review summaries", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("Review");
    expect(screen.getByText("matrix-os")).toBeTruthy();
    expect(screen.getByText(/PR #759/)).toBeTruthy();
    expect(screen.getByText(/Round 2 of 3/)).toBeTruthy();
    expect(screen.getByText("1 high")).toBeTruthy();
    expect(client.getCodingAgentReviews).toHaveBeenCalledWith();
  });

  it("renders a generic review error without dropping the runtime summary", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: false,
        error: "review store failed at /home/matrix/private token secret",
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await screen.findByText("Primary");
    expect(await screen.findByText("Review state unavailable")).toBeTruthy();
    expect(screen.queryByText(/home\/matrix|token|secret/i)).toBeNull();
  });

  it("renders a safe error when the runtime summary is unavailable", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: false,
        error: "Runtime summary unavailable",
      }),
      getCodingAgentReviews: jest.fn(),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentsScreen />);

    await waitFor(() => expect(screen.getByText("Runtime summary unavailable")).toBeTruthy());
    expect(screen.queryByText(/home\/matrix/)).toBeNull();
  });

  it("ignores a delayed summary from a previous gateway client", async () => {
    const oldRequest = deferred<{ ok: true; summary: ReturnType<typeof summaryFixture> }>();
    const oldClient = {
      getCodingAgentRuntimeSummary: jest.fn(() => oldRequest.promise),
      getCodingAgentReviews: jest.fn(),
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
      getCodingAgentReviews: jest.fn().mockResolvedValue({
        ok: true,
        reviews: reviewsFixture(),
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

    await waitFor(() => {
      expect(screen.queryByText("Old runtime")).toBeNull();
      expect(screen.getByText("New runtime")).toBeTruthy();
    });
  });
});
