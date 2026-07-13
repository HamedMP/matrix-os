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
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import TerminalsScreen from "../app/agents/terminals";
import { useGateway } from "@/app/_layout";
import { MOBILE_SHELL_STATE_STORAGE_KEY } from "../lib/mobile-shell-state";
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

function previewSummaryFixture() {
  const summary = summaryFixture();
  return {
    ...summary,
    capabilities: [
      ...summary.capabilities,
      { id: "codingAgentsPreview", enabled: true },
    ],
    previewSessions: {
      items: [
        {
          id: "prev_mobile_local",
          label: "Mobile app preview",
          status: "running",
          origin: "http://localhost:8081",
          updatedAt: "2026-07-06T00:04:00.000Z",
        },
        {
          id: "prev_mobile_internal",
          label: "Internal preview",
          status: "starting",
          updatedAt: "2026-07-06T00:03:00.000Z",
        },
        {
          id: "prev_mobile_secure",
          label: "Secure mobile preview",
          status: "running",
          origin: "https://preview.matrix-os.test",
          updatedAt: "2026-07-06T00:05:00.000Z",
        },
      ],
      hasMore: false,
      limit: 50,
    },
  };
}

describe("TerminalsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(mockSearchParams)) delete mockSearchParams[key];
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    jest.mocked(AsyncStorage.setItem).mockResolvedValue();
  });

  it("opens terminal summary rows through the existing mobile Terminal tab", async () => {
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

    render(<TerminalsScreen />);

    await screen.findByLabelText("Open terminal session matrix-abc1234");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Open terminal session matrix-abc1234"));
    });

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      MOBILE_SHELL_STATE_STORAGE_KEY,
      expect.stringContaining("\"lastActiveTerminalSessionId\":\"matrix-abc1234\""),
    );
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      MOBILE_SHELL_STATE_STORAGE_KEY,
      expect.stringContaining("\"terminalHandoffSessionId\":\"matrix-abc1234\""),
    );
    expect(mockRouterPush).toHaveBeenCalledWith("/terminal");
  });

  it("keeps non-running attachable terminal summary rows disabled", async () => {
    const summary = summaryFixture();
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: {
          ...summary,
          terminalSessions: {
            ...summary.terminalSessions,
            items: [
              {
                ...summary.terminalSessions.items[0],
                id: "matrix-idle",
                name: "matrix-idle",
                status: "idle",
                attachable: true,
              },
            ],
          },
        },
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<TerminalsScreen />);

    const row = await screen.findByLabelText("Terminal session matrix-idle unavailable");
    expect(row.props.accessibilityState?.disabled).toBe(true);
    expect(screen.queryByLabelText("Open terminal session matrix-idle")).toBeNull();

    fireEvent.press(row);

    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
      MOBILE_SHELL_STATE_STORAGE_KEY,
      expect.stringContaining("matrix-idle"),
    );
    expect(mockRouterPush).not.toHaveBeenCalledWith("/terminal");
  });

  it("renders read-only preview summaries without unsafe origin details", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: previewSummaryFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<TerminalsScreen />);

    expect(await screen.findByText("Previews")).toBeTruthy();
    expect(screen.getByText("Mobile app preview")).toBeTruthy();
    expect(screen.getByText("http://localhost:8081")).toBeTruthy();
    expect(screen.getByText("Internal preview")).toBeTruthy();
    expect(screen.getByText("No local origin")).toBeTruthy();
    expect(screen.queryByText(/internal\.preview|token=secret|\/home\/matrix/i)).toBeNull();
  });

  it("opens mobile preview rows through a bounded preview route", async () => {
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: previewSummaryFixture(),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<TerminalsScreen />);

    const previewButton = await screen.findByLabelText("Open preview Secure mobile preview");
    await act(async () => {
      fireEvent.press(previewButton);
    });

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/agents/preview",
      params: {
        id: "prev_mobile_secure",
      },
    });
  });
});
