const routeParams: Record<string, string | undefined> = {};
const mockRouterBack = jest.fn();

jest.mock("@/app/_layout", () => ({
  useGateway: jest.fn(),
}));

jest.mock("expo-router", () => ({
  Stack: {
    Screen: () => null,
  },
  useLocalSearchParams: () => routeParams,
  useRouter: () => ({ back: mockRouterBack }),
}));

import React from "react";
import { Linking } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import AgentPreviewRoute from "../app/agents/preview";
import { useGateway } from "@/app/_layout";
import {
  latestWebViewSource,
  resetWebViewMock,
} from "../__mocks__/react-native-webview";
import type { GatewayClient } from "../lib/gateway-client";

const useGatewayMock = useGateway as jest.MockedFunction<typeof useGateway>;
type GatewayContextValue = ReturnType<typeof useGateway>;
const openURLMock = jest.spyOn(Linking, "openURL");

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

function summaryFixture(status: "running" | "stopped" = "running") {
  return {
    runtime: {
      id: "rt_primary",
      label: "Primary",
      status: "available",
    },
    capabilities: [
      {
        id: "codingAgentsPreview",
        enabled: true,
      },
    ],
    providers: [],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: [], hasMore: false, limit: 20 },
    previewSessions: {
      items: [
        {
          id: "prev_mobile_secure",
          label: "Secure mobile preview",
          status,
          origin: "https://preview.matrix-os.test",
          updatedAt: "2026-07-06T00:05:00.000Z",
        },
      ],
      hasMore: false,
      limit: 50,
    },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: {
      maxPromptBytes: 16384,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 8192,
      maxListItems: 20,
    },
    serverTime: "2026-07-06T00:06:00.000Z",
  };
}

describe("AgentPreviewRoute", () => {
  beforeEach(() => {
    resetWebViewMock();
    mockRouterBack.mockReset();
    openURLMock.mockReset();
    openURLMock.mockResolvedValue(undefined);
    useGatewayMock.mockReset();
    for (const key of Object.keys(routeParams)) delete routeParams[key];
  });

  it("renders an HTTPS coding-agent preview from the authenticated gateway summary", async () => {
    Object.assign(routeParams, {
      id: "prev_mobile_secure",
    });
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

    render(<AgentPreviewRoute />);

    expect(await screen.findByText("Secure mobile preview")).toBeTruthy();
    expect(client.getCodingAgentRuntimeSummary).toHaveBeenCalledTimes(1);
    expect(latestWebViewSource).toEqual({ uri: "https://preview.matrix-os.test" });
  });

  it("opens the authoritative HTTPS preview origin externally", async () => {
    Object.assign(routeParams, {
      id: "prev_mobile_secure",
    });
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

    render(<AgentPreviewRoute />);

    fireEvent.press(await screen.findByLabelText("Open preview in browser"));

    expect(openURLMock).toHaveBeenCalledWith("https://preview.matrix-os.test");
  });

  it("rejects non-HTTPS preview origins without rendering the raw origin", async () => {
    Object.assign(routeParams, {
      id: "prev_mobile_local",
    });
    const summary = summaryFixture();
    summary.previewSessions.items[0] = {
      ...summary.previewSessions.items[0],
      id: "prev_mobile_local",
      label: "Local preview",
      origin: "http://localhost:8081",
    };
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary,
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentPreviewRoute />);

    expect(await screen.findByText("Preview unavailable")).toBeTruthy();
    expect(screen.queryByText("http://localhost:8081")).toBeNull();
    expect(latestWebViewSource).toBeNull();
  });

  it("rejects stopped previews from the authenticated summary", async () => {
    Object.assign(routeParams, {
      id: "prev_mobile_secure",
    });
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({
        ok: true,
        summary: summaryFixture("stopped"),
      }),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentPreviewRoute />);

    expect(await screen.findByText("Preview unavailable")).toBeTruthy();
    expect(latestWebViewSource).toBeNull();
  });

  it("shows the generic recovery state when preview summary refresh fails", async () => {
    Object.assign(routeParams, {
      id: "prev_mobile_secure",
    });
    const client = {
      getCodingAgentRuntimeSummary: jest.fn().mockRejectedValue(new Error("internal path detail")),
    };
    useGatewayMock.mockReturnValue(gatewayContext({
      client: client as unknown as GatewayClient,
      connectionState: "connected",
    }));

    render(<AgentPreviewRoute />);

    expect(await screen.findByText("Preview unavailable")).toBeTruthy();
    expect(screen.queryByText("internal path detail")).toBeNull();
    expect(latestWebViewSource).toBeNull();
  });
});
