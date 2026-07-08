jest.mock("@/app/_layout", () => ({
  useGateway: jest.fn(),
}));

jest.mock("@/lib/feature-flags", () => ({
  CODING_AGENTS_MOBILE_WORKSPACE: true,
}));

const mockRouterPush = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: mockRouterPush,
    back: jest.fn(),
  }),
}));

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
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
    projects: { items: [], hasMore: false, limit: 20 },
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

describe("AgentComposerScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requires a prompt before creating a run", async () => {
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
        prompt: "Investigate mobile composer",
        clientRequestId: expect.stringMatching(/^req_mobile_/),
      }));
      expect(mockRouterPush).toHaveBeenCalledWith({
        pathname: "/agents/[threadId]",
        params: { threadId: "thread_mobile_create" },
      });
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
});
