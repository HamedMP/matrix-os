// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectsIndex from "../../desktop/src/renderer/src/features/project/ProjectsIndex";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useProjectView } from "../../desktop/src/renderer/src/stores/project-view";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

describe("ProjectsIndex", () => {
  beforeEach(() => {
    useBoard.setState({
      projectsStatus: "ready",
      projectsError: null,
      projects: [
        {
          slug: "portfolio",
          name: "Portfolio",
          description: "Build my portfolio and case study",
          kind: "github",
          localPath: "/Users/test/portfolio",
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
    useConnection.setState({ api: null });
    useProjectView.setState({ entries: {}, runtimeScope: null });
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

  it("reopens a project on its sessions overview instead of the previously selected thread", () => {
    useProjectView.setState({
      entries: {
        portfolio: { view: "chats", selectedThreadId: "thread_portfolio", touchedAt: Date.now() },
      },
    });
    render(<ProjectsIndex />);

    fireEvent.click(screen.getByRole("button", { name: "Open project Portfolio" }));

    expect(useProjectView.getState().viewFor("portfolio")).toBe("overview");
    expect(useProjectView.getState().selectedThreadFor("portfolio")).toBe("thread_portfolio");
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

  it("distinguishes the initial project-list load from a genuinely empty account", () => {
    useBoard.setState({ projects: [], projectsStatus: "loading", projectsError: null } as never);

    render(<ProjectsIndex />);

    expect(screen.getByText("Loading projects…")).toBeTruthy();
    expect(screen.queryByText("Create your first project to get started.")).toBeNull();
  });

  it("shows a bounded project-list error with a retry action", () => {
    const loadProjects = vi.fn(async () => true);
    useBoard.setState({
      projects: [],
      projectsStatus: "error",
      projectsError: "offline",
      loadProjects,
    } as never);
    useConnection.setState({ api: { get: vi.fn(), baseUrl: "https://gateway.test" } as never });

    render(<ProjectsIndex />);

    expect(screen.getByText("Can't load projects")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(loadProjects).toHaveBeenCalledWith(useConnection.getState().api);
  });

  it("bounds project metadata work instead of starting one request per card", async () => {
    const projects = Array.from({ length: 30 }, (_, index) => ({
      slug: `project-${index}`,
      name: `Project ${index}`,
      kind: "scratch" as const,
    }));
    const firstBatchResolvers: Array<(value: unknown) => void> = [];
    const metadata = {
      path: "/Users/test/project",
      repository: null,
      isGitRepository: false,
      branch: null,
      clean: null,
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      worktreeCount: 0,
    };
    const get = vi.fn(() => {
      if (firstBatchResolvers.length < 4 && get.mock.calls.length <= 4) {
        return new Promise((resolve) => firstBatchResolvers.push(resolve));
      }
      return Promise.resolve(metadata);
    });
    useBoard.setState({ projects, projectsStatus: "ready", projectsError: null } as never);
    useConnection.setState({ api: { get, baseUrl: "https://gateway.test" } as never });

    render(<ProjectsIndex />);

    await waitFor(() => expect(get).toHaveBeenCalledTimes(4));
    expect(screen.getByRole("button", { name: "Next projects page" })).toBeTruthy();
    await act(async () => {
      for (const resolve of firstBatchResolvers) resolve(metadata);
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(24));
  });

  it("shows local path, git state, and worktree visibility for coding projects", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/projects/portfolio/code-metadata") {
        return {
          path: "/Users/test/portfolio",
          repository: "Matrix-OS/portfolio",
          isGitRepository: true,
          branch: "feature/project-cards",
          clean: false,
          ahead: 2,
          behind: 1,
          hasUpstream: true,
          worktreeCount: 3,
        };
      }
      return {
        path: "/Users/test/campaigns",
        repository: null,
        isGitRepository: false,
        branch: null,
        clean: null,
        ahead: 0,
        behind: 0,
        hasUpstream: false,
        worktreeCount: 0,
      };
    });
    useConnection.setState({ api: { get, baseUrl: "https://gateway.test" } as never });

    render(<ProjectsIndex />);

    await waitFor(() => expect(screen.getByText("Matrix-OS/portfolio")).toBeTruthy());
    expect(screen.getByText("/Users/test/portfolio")).toBeTruthy();
    expect(screen.getByText("feature/project-cards")).toBeTruthy();
    expect(screen.getByText("Changes")).toBeTruthy();
    expect(screen.getByText("2 ahead")).toBeTruthy();
    expect(screen.getByText("1 behind")).toBeTruthy();
    expect(screen.getByText("3 worktrees")).toBeTruthy();
  });
});
