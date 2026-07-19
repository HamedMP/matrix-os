jest.mock("@/app/_layout", () => ({
  useGateway: () => ({ client: {}, connectionState: "connected" }),
}));

jest.mock("@/lib/feature-flags", () => ({
  CODING_AGENTS_MOBILE_WORKSPACE: true,
}));

const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  Redirect: () => null,
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@/components/agents/agent-project-workspace-screen", () => ({
  AgentProjectWorkspaceScreen: (props: {
    onOpenThread: (identity: { projectId: string; taskId: string | null; threadId: string }) => void;
    onNewConversation: (identity: { projectId: string; taskId: string | null }) => void;
  }) => {
    const React = require("react");
    const { Pressable, Text, View } = require("react-native");
    return React.createElement(View, null,
      React.createElement(Pressable, {
        accessibilityRole: "button",
        accessibilityLabel: "Open fixture conversation",
        onPress: () => props.onOpenThread({
          projectId: "matrix-os",
          taskId: "task-mobile",
          threadId: "thread-mobile",
        }),
      }, React.createElement(Text, null, "Conversation")),
      React.createElement(Pressable, {
        accessibilityRole: "button",
        accessibilityLabel: "New fixture conversation",
        onPress: () => props.onNewConversation({ projectId: "matrix-os", taskId: null }),
      }, React.createElement(Text, null, "New")),
    );
  },
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import ProjectChatsTab from "../app/(tabs)/workspaces";

describe("project chats tab", () => {
  beforeEach(() => mockPush.mockReset());

  it("opens exact project/task/thread identity from the dedicated tab", () => {
    render(<ProjectChatsTab />);

    fireEvent.press(screen.getByLabelText("Open fixture conversation"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/agents/[threadId]",
      params: {
        projectId: "matrix-os",
        taskId: "task-mobile",
        threadId: "thread-mobile",
      },
    });
  });

  it("starts a project-level chat from the dedicated tab", () => {
    render(<ProjectChatsTab />);

    fireEvent.press(screen.getByLabelText("New fixture conversation"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/agents/new",
      params: { projectId: "matrix-os" },
    });
  });
});
