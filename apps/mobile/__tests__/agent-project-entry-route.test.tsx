jest.mock("@/app/_layout", () => ({
  useGateway: jest.fn(),
}));

jest.mock("@/lib/feature-flags", () => ({
  CODING_AGENTS_MOBILE_WORKSPACE: true,
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
  },
}));

const mockRouterPush = jest.fn();

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({}),
  useFocusEffect: (callback: () => void) => {
    const React = require("react");
    React.useEffect(callback, [callback]);
  },
  useRouter: () => ({ push: mockRouterPush }),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { RuntimeSummary } from "@matrix-os/contracts";
import AgentsScreen from "../app/agents";
import { useGateway } from "@/app/_layout";

const summary = {
  runtime: { id: "rt_primary", label: "Primary", status: "available" },
  capabilities: [
    { id: "codingAgentsRuntimeSummary", enabled: true },
    { id: "codingAgentsProjectWorkspace", enabled: true },
    { id: "codingAgentsConversationView", enabled: true },
    { id: "codingAgentsThreadCreate", enabled: true },
  ],
  providers: [],
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
    limit: 50,
  },
  activeThreads: { items: [], hasMore: false, limit: 20 },
  attentionThreads: { items: [], hasMore: false, limit: 20 },
  terminalSessions: { items: [], hasMore: false, limit: 20 },
  previewSessions: { items: [], hasMore: false, limit: 20 },
  recentActivity: { items: [], hasMore: false, limit: 20 },
  limits: {
    maxPromptBytes: 16_384,
    maxAttachmentCount: 8,
    maxTerminalInputBytes: 8_192,
    maxListItems: 20,
  },
  serverTime: "2026-07-10T14:00:00.000Z",
} satisfies RuntimeSummary;

describe("Agents project-first entry route", () => {
  it("opens a selected project from the bounded runtime summary", async () => {
    const client = {
      connect: jest.fn(),
      getCodingAgentRuntimeSummary: jest.fn().mockResolvedValue({ ok: true, summary }),
      getCodingAgentNotificationPreferences: jest.fn().mockResolvedValue({
        ok: true,
        preferences: {
          attentionPush: { approval: true, input: true, failed: true, completed: false },
          updatedAt: "2026-07-10T14:00:00.000Z",
        },
      }),
      updateCodingAgentNotificationPreferences: jest.fn(),
    };
    jest.mocked(useGateway).mockReturnValue({
      client: client as never,
      connectionState: "connected",
      gateway: null,
      setGateway: jest.fn(),
      unreadCount: 0,
      incrementUnread: jest.fn(),
      clearUnread: jest.fn(),
    });

    render(<AgentsScreen />);

    fireEvent.press(await screen.findByLabelText("Open project Matrix OS"));
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/agents/projects/[projectId]",
      params: { projectId: "matrix-os" },
    });

    fireEvent.press(screen.getByLabelText("Start a new agent run"));
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/agents/new",
      params: { projectId: "matrix-os" },
    });
  });
});
