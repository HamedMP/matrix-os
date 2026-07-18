jest.mock("@/components/agents/agent-project-route", () => ({
  AgentProjectRoute: ({ routeViewMode }: { routeViewMode: string }) => {
    const React = require("react") as typeof import("react");
    const { Text } = require("react-native") as typeof import("react-native");
    return React.createElement(Text, null, routeViewMode);
  },
}));

import React from "react";
import { render, screen } from "@testing-library/react-native";
import ProjectAgentBoardRoute from "../app/agents/projects/[projectId]/board";

describe("project coding-agent Kanban Expo route", () => {
  beforeEach(() => {
    mockWorkspaceEnabled = true;
  });

  it("opens the shared project workspace in Kanban mode", () => {
    render(<ProjectAgentBoardRoute />);

    expect(screen.getByText("kanban")).toBeTruthy();
  });

  it("does not mount a board deep link when the mobile workspace rollout is disabled", () => {
    mockWorkspaceEnabled = false;

    render(<ProjectAgentBoardRoute />);

    expect(screen.getByText("redirect:/agents")).toBeTruthy();
    expect(screen.queryByText("kanban")).toBeNull();
  });
});
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
}));
