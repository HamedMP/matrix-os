// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ProjectsIndex from "../../desktop/src/renderer/src/features/project/ProjectsIndex";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

describe("ProjectsIndex", () => {
  beforeEach(() => {
    useBoard.setState({
      projects: [
        {
          slug: "portfolio",
          name: "Portfolio",
          description: "Build my portfolio and case study",
          kind: "scratch",
          updatedAt: "2026-08-19T10:00:00.000Z",
        },
        {
          slug: "campaigns",
          name: "Campaigns",
          kind: "github",
          updatedAt: "2026-08-18T10:00:00.000Z",
        },
      ],
    });
    useCodingAgentWorkspace.setState({ summary: null });
    useTabs.setState({ tabs: [], activeTabId: null });
    useUi.setState({ createProjectOpen: false });
  });

  afterEach(cleanup);

  it("opens a project card in the canonical project tab", () => {
    render(<ProjectsIndex />);

    expect(screen.getByText("Build my portfolio and case study")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open project Portfolio" }));

    expect(useTabs.getState().tabs).toEqual([
      expect.objectContaining({ kind: "project", projectSlug: "portfolio", title: "Portfolio" }),
    ]);
  });

  it("filters the project cards from the Figma search control", () => {
    render(<ProjectsIndex />);

    fireEvent.click(screen.getByRole("button", { name: "Search projects" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search projects" }), {
      target: { value: "campaign" },
    });

    expect(screen.getByRole("button", { name: "Open project Campaigns" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open project Portfolio" })).toBeNull();
  });

  it("opens the canonical create-project dialog state", () => {
    render(<ProjectsIndex />);

    fireEvent.click(screen.getByRole("button", { name: "New" }));

    expect(useUi.getState().createProjectOpen).toBe(true);
  });
});
