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
  it("opens the shared project workspace in Kanban mode", () => {
    render(<ProjectAgentBoardRoute />);

    expect(screen.getByText("kanban")).toBeTruthy();
  });
});
