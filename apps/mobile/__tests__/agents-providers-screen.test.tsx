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

const mockRouterPush = jest.fn();
const mockSearchParams: Record<string, string | undefined> = {};

jest.mock("expo-router", () => ({
  Stack: {
    Screen: () => null,
  },
  useLocalSearchParams: () => mockSearchParams,
  useFocusEffect: (callback: () => void) => {
    const React = require("react");
    React.useEffect(callback, [callback]);
  },
  useRouter: () => ({
    push: mockRouterPush,
  }),
}));

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import ProvidersScreen from "../app/agents/providers";
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
      { id: "codingAgentsRuntimeSummary", enabled: true },
      { id: "codingAgentsReview", enabled: true },
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

function providerSetupSummaryFixture() {
  const summary = summaryFixture();
  return {
    ...summary,
    providers: [
      {
        ...summary.providers[0],
        id: "codex",
        displayName: "Codex",
        availability: "auth_required",
        installStatus: "installed",
        authStatus: "missing",
        setupActions: [
          {
            id: "codex",
            kind: "foreground_terminal",
            label: "Sign in from Terminal",
            command: "codex login --api-key ghp_should_not_render_secret",
          },
        ],
      },
      {
        ...summary.providers[0],
        id: "claude",
        kind: "claude",
        displayName: "Claude Code",
        availability: "setup_required",
        installStatus: "missing",
        authStatus: "unknown",
        setupActions: [
          {
            id: "claude",
            kind: "open_settings",
            label: "Open agent settings",
          },
        ],
      },
    ],
  };
}

describe("ProvidersScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(mockSearchParams)) delete mockSearchParams[key];
  });

  it("renders provider summaries from the runtime summary", async () => {
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

    render(<ProvidersScreen />);

    await screen.findByText("Codex");
    expect(screen.getByText("Primary")).toBeTruthy();
    expect(screen.getAllByText("Providers").length).toBeGreaterThan(0);
  });

  it("hydrates and updates notification preferences", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture(),
      }),
      getCodingAgentNotificationPreferences: jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          preferences: { attentionPush: { approval: true, input: true, failed: false, completed: true } },
        })
        .mockResolvedValueOnce({
          ok: true,
          preferences: { attentionPush: { approval: false, input: true, failed: false, completed: true } },
        }),
      updateCodingAgentNotificationPreferences: jest.fn().mockResolvedValue({
        ok: true,
        preferences: { attentionPush: { approval: false, input: true, failed: true, completed: true } },
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<ProvidersScreen />);

    const failedSwitch = await screen.findByRole("switch", { name: "Failed run alerts" });
    expect(failedSwitch.props.value).toBe(false);

    fireEvent(failedSwitch, "valueChange", true);

    await waitFor(() => {
      expect(client.updateCodingAgentNotificationPreferences).toHaveBeenCalledWith({
        attentionPush: { approval: false, input: true, failed: true, completed: true },
      });
    });
    expect((await screen.findByRole("switch", { name: "Failed run alerts" })).props.value).toBe(true);
    expect(screen.queryByText(/token|bearer|secret|\/home\/matrix/i)).toBeNull();
  });

  it("surfaces safe provider setup warnings without rendering setup commands", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: providerSetupSummaryFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<ProvidersScreen />);

    await screen.findByText("Provider Setup");
    expect(screen.getByText("Sign in from Terminal")).toBeTruthy();
    expect(screen.getByText("Open agent settings")).toBeTruthy();
    expect(screen.getByLabelText("Provider setup needed for Codex, auth required")).toBeTruthy();
    expect(screen.getByLabelText("Provider setup needed for Claude Code, setup required")).toBeTruthy();
    expect(screen.queryByText(/codex login|api-key|ghp_should_not_render_secret/i)).toBeNull();
  });

  it("does not show setup warnings for ready or non-actionable provider states", async () => {
    const summary = summaryFixture();
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: {
          ...summary,
          providers: [
            {
              ...summary.providers[0],
              id: "ready-with-action",
              displayName: "Ready Provider",
              availability: "available",
              installStatus: "installed",
              authStatus: "authenticated",
              setupActions: [
                {
                  id: "ready-with-action",
                  kind: "open_settings",
                  label: "Optional settings",
                },
              ],
            },
            {
              ...summary.providers[0],
              id: "unknown-provider",
              displayName: "Unknown Provider",
              availability: "unknown",
              installStatus: "unknown",
              authStatus: "unknown",
              setupActions: [],
            },
          ],
        },
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<ProvidersScreen />);

    await screen.findByText("Ready Provider");
    expect(screen.queryByText("Provider Setup")).toBeNull();
    expect(screen.queryByLabelText(/Provider setup needed for Ready Provider/i)).toBeNull();
    expect(screen.queryByLabelText(/Provider setup needed for Unknown Provider/i)).toBeNull();
    expect(screen.queryByText("Optional settings")).toBeNull();
  });
});
