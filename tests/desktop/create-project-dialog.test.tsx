// @vitest-environment jsdom

import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CreateProjectDialog from "../../desktop/src/renderer/src/features/board/CreateProjectDialog";
import type { Project } from "../../desktop/src/renderer/src/stores/board";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";
import { useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";

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
    useBoard.setState({ createProject, selectProject: vi.fn(async () => undefined) });
    render(<CreateProjectDialog open onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Customer app" } });
    fireEvent.click(screen.getByRole("button", { name: "Use existing folder" }));
    fireEvent.change(screen.getByPlaceholderText("workspaces/customer-app"), {
      target: { value: "workspaces/customer-app" },
    });
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
});
