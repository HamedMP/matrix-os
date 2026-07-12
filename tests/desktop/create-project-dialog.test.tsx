// @vitest-environment jsdom

import React, { useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CreateProjectDialog from "../../desktop/src/renderer/src/features/board/CreateProjectDialog";
import type { Project } from "../../desktop/src/renderer/src/stores/board";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";
import { useCodingAgentProjectWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-project-workspace";

describe("CreateProjectDialog", () => {
  beforeEach(() => {
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: { post: vi.fn(), get: vi.fn() } as never,
    });
    useBoard.setState({
      projects: [],
      activeProjectSlug: null,
      cardsByProject: {},
      firstLoadByProject: {},
      refreshing: false,
      error: null,
    });
    useTabs.setState({ tabs: [], activeTabId: null });
    useUi.setState({ createProjectDestination: "board" });
    useCodingAgentWorkspace.setState({ summary: null, status: "idle" });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not select or open a project after Cancel closes an in-flight create", async () => {
    let resolveCreate!: (project: Project) => void;
    const createProject = vi.fn(
      () => new Promise<Project>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const selectProject = vi.fn(async () => undefined);
    const openTab = vi.fn();
    useBoard.setState({ createProject, selectProject });
    useTabs.setState({ openTab });

    function Harness() {
      const [open, setOpen] = useState(true);
      return <CreateProjectDialog open={open} onClose={() => setOpen(false)} />;
    }

    render(<Harness />);

    fireEvent.change(screen.getByPlaceholderText("Project name"), {
      target: { value: "Desktop" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => {
      expect(createProject).toHaveBeenCalledOnce();
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    await act(async () => {
      resolveCreate({ slug: "desktop", name: "Desktop" });
    });

    expect(selectProject).not.toHaveBeenCalled();
    expect(openTab).not.toHaveBeenCalled();
  });

  it("connects an existing computer folder without requiring GitHub", async () => {
    const createProject = vi.fn(async () => ({
      slug: "customer-app",
      name: "Customer app",
      localPath: "/home/matrix/home/workspaces/customer-app",
      githubBacked: false,
    }));
    const get = vi.fn(async (requestPath: string) => {
      if (requestPath === "/api/files/list?path=") {
        return { entries: [{ name: "workspaces", type: "directory" }] };
      }
      if (requestPath === "/api/files/list?path=workspaces") {
        return { entries: [{ name: "customer-app", type: "directory" }] };
      }
      return { entries: [] };
    });
    useConnection.setState({ api: { post: vi.fn(), get } as never });
    useBoard.setState({ createProject, selectProject: vi.fn(async () => undefined) });
    render(<Tooltip.Provider><CreateProjectDialog open onClose={vi.fn()} /></Tooltip.Provider>);

    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Customer app" } });
    fireEvent.click(screen.getByRole("button", { name: "Use existing folder" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open workspaces" })).not.toBeNull());
    fireEvent.doubleClick(screen.getByRole("button", { name: "Open workspaces" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open customer-app" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open customer-app" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose customer-app" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createProject).toHaveBeenCalledWith(expect.anything(), {
      name: "Customer app",
      mode: "folder",
      path: "workspaces/customer-app",
    }));
  });

  it("returns an Agents-created project to chats without opening a board tab", async () => {
    const project = { slug: "desktop", name: "Desktop" };
    const createProject = vi.fn(async () => project);
    const selectProject = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => undefined);
    const openTab = vi.fn();
    useUi.setState({ createProjectDestination: "agents" });
    useBoard.setState({ createProject, selectProject });
    useCodingAgentWorkspace.setState({ refresh });
    useTabs.setState({ openTab });

    render(<CreateProjectDialog open onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Desktop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(selectProject).not.toHaveBeenCalled();
    expect(openTab).not.toHaveBeenCalled();
  });

  it("keeps the dialog open with an error when the Agents workspace refresh fails after create", async () => {
    const project = { slug: "desktop", name: "Desktop" };
    const createProject = vi.fn(async () => project);
    // The workspace store catches refresh failures internally and clears the
    // summary, so the dialog observes a resolved refresh with a null summary.
    const refresh = vi.fn(async () => {
      useCodingAgentWorkspace.setState({ summary: null });
    });
    const openCreatedProject = vi.fn(async () => undefined);
    const openTab = vi.fn();
    const onClose = vi.fn();
    useUi.setState({ createProjectDestination: "agents" });
    useBoard.setState({ createProject, selectProject: vi.fn(async () => undefined) });
    useCodingAgentWorkspace.setState({ refresh });
    useCodingAgentProjectWorkspace.setState({ openCreatedProject });
    useTabs.setState({ openTab });

    render(<CreateProjectDialog open onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Desktop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByText(/project was created/i)).toBeTruthy());
    expect(openCreatedProject).not.toHaveBeenCalled();
    expect(openTab).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("treats a failed refresh with a stale summary like a missing one", async () => {
    const project = { slug: "desktop", name: "Desktop" };
    const staleSummary = { runtime: { id: "rt_primary" } } as never;
    const createProject = vi.fn(async () => project);
    // A failed refresh records status "error" but keeps the previous summary;
    // the dialog must not treat that as success and select against stale data.
    const refresh = vi.fn(async () => {
      useCodingAgentWorkspace.setState({ status: "error", summary: staleSummary });
    });
    const openCreatedProject = vi.fn(async () => undefined);
    const onClose = vi.fn();
    useUi.setState({ createProjectDestination: "agents" });
    useBoard.setState({ createProject, selectProject: vi.fn(async () => undefined) });
    useCodingAgentWorkspace.setState({ refresh, summary: staleSummary, status: "ready" });
    useCodingAgentProjectWorkspace.setState({ openCreatedProject });

    render(<CreateProjectDialog open onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Desktop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByText(/project was created/i)).toBeTruthy());
    expect(openCreatedProject).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("lands the coding-agent navigator on the project created from the Agents empty state", async () => {
    const project = { slug: "desktop", name: "Desktop" };
    const summary = { runtime: { id: "rt_primary" } } as never;
    const createProject = vi.fn(async () => project);
    const refresh = vi.fn(async () => undefined);
    const openCreatedProject = vi.fn(async () => undefined);
    const openTab = vi.fn();
    useUi.setState({ createProjectDestination: "agents" });
    useBoard.setState({ createProject, selectProject: vi.fn(async () => undefined) });
    useCodingAgentWorkspace.setState({ refresh, summary });
    useCodingAgentProjectWorkspace.setState({ openCreatedProject });
    useTabs.setState({ openTab });

    render(<CreateProjectDialog open onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Desktop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(openCreatedProject).toHaveBeenCalledWith(
      summary,
      "desktop",
      "operator|https://platform.test|primary",
    ));
    expect(openTab).not.toHaveBeenCalled();
  });
});
