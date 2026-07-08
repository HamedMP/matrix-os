jest.mock("@/app/_layout", () => ({
  useGateway: jest.fn(),
}));

jest.mock("@/lib/feature-flags", () => ({
  CODING_AGENTS_MOBILE_WORKSPACE: true,
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

    await waitFor(() => expect(screen.getByText("Runtime summary unavailable")).toBeTruthy());
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

    await waitFor(() => {
      expect(screen.queryByText("Old runtime")).toBeNull();
      expect(screen.getByText("New runtime")).toBeTruthy();
    });
  });
});
