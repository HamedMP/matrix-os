jest.mock("@/app/_layout", () => ({
  useGateway: jest.fn(),
}));

const mockRouterPush = jest.fn();
const mockRouterReplace = jest.fn();
let mockWorkspaceEnabled = true;

jest.mock("@/lib/feature-flags", () => ({
  get CODING_AGENTS_MOBILE_WORKSPACE() {
    return mockWorkspaceEnabled;
  },
}));

jest.mock("expo-router", () => ({
  Redirect: ({ href }: { href: string }) => {
    const React = require("react") as typeof import("react");
    const { Text } = require("react-native") as typeof import("react-native");
    return React.createElement(Text, null, `redirect:${href}`);
  },
  useLocalSearchParams: () => ({ projectId: "matrix-os" }),
  useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace }),
}));

jest.mock("../components/agents/agent-project-workspace-screen", () => ({
  AgentProjectWorkspaceScreen: (props: {
    requestedProjectId: string;
    onOpenProject: (projectId: string) => void;
    onOpenThread: (identity: { projectId: string; taskId: string | null; threadId: string }) => void;
    onNewConversation: (identity: { projectId: string; taskId: string | null }) => void;
    onViewModeChange: (viewMode: "conversation" | "kanban") => void;
  }) => {
    const React = require("react") as typeof import("react");
    const { Pressable, Text, View } = require("react-native") as typeof import("react-native");
    return React.createElement(
      View,
      null,
      React.createElement(Text, null, props.requestedProjectId),
      React.createElement(Pressable, {
        accessibilityRole: "button",
        accessibilityLabel: "Select website",
        onPress: () => props.onOpenProject("website"),
      }),
      React.createElement(Pressable, {
        accessibilityRole: "button",
        accessibilityLabel: "Open task conversation",
        onPress: () => props.onOpenThread({
          projectId: "matrix-os",
          taskId: "task_auth",
          threadId: "thread_fix",
        }),
      }),
      React.createElement(Pressable, {
        accessibilityRole: "button",
        accessibilityLabel: "Create task conversation",
        onPress: () => props.onNewConversation({ projectId: "matrix-os", taskId: "task_auth" }),
      }),
      React.createElement(Pressable, {
        accessibilityRole: "button",
        accessibilityLabel: "Show project Kanban",
        onPress: () => props.onViewModeChange("kanban"),
      }),
    );
  },
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import ProjectAgentRoute from "../app/agents/projects/[projectId]";
import { useGateway } from "@/app/_layout";

describe("project coding-agent Expo route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWorkspaceEnabled = true;
    jest.mocked(useGateway).mockReturnValue({
      client: {} as never,
      connectionState: "connected",
      gateway: null,
      setGateway: jest.fn(),
      unreadCount: 0,
      incrementUnread: jest.fn(),
      clearUnread: jest.fn(),
    });
  });

  it("preserves project, task, and conversation identity across route actions", () => {
    render(<ProjectAgentRoute />);

    expect(screen.getByText("matrix-os")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Select website"));
    expect(mockRouterReplace).toHaveBeenCalledWith({
      pathname: "/agents/projects/[projectId]",
      params: { projectId: "website" },
    });

    fireEvent.press(screen.getByLabelText("Open task conversation"));
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/agents/[threadId]",
      params: {
        projectId: "matrix-os",
        taskId: "task_auth",
        threadId: "thread_fix",
      },
    });

    fireEvent.press(screen.getByLabelText("Create task conversation"));
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/agents/new",
      params: { projectId: "matrix-os", taskId: "task_auth" },
    });

    fireEvent.press(screen.getByLabelText("Show project Kanban"));
    expect(mockRouterReplace).toHaveBeenCalledWith({
      pathname: "/agents/projects/[projectId]/board",
      params: { projectId: "matrix-os" },
    });
  });

  it("does not mount a project deep link when the mobile workspace rollout is disabled", () => {
    mockWorkspaceEnabled = false;

    render(<ProjectAgentRoute />);

    expect(screen.getByText("redirect:/agents")).toBeTruthy();
    expect(screen.queryByText("matrix-os")).toBeNull();
  });
});
