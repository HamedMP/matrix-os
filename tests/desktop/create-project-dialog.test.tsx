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

  it("opens the created project in a project tab", async () => {
    const project = { slug: "desktop", name: "Desktop" };
    const createProject = vi.fn(async () => project);
    const selectProject = vi.fn(async () => undefined);
    const openTab = vi.fn();
    const onClose = vi.fn();
    useBoard.setState({ createProject, selectProject });
    useTabs.setState({ openTab });

    render(<CreateProjectDialog open onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Desktop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(selectProject).toHaveBeenCalledWith(expect.anything(), "desktop"));
    await waitFor(() => expect(openTab).toHaveBeenCalledWith({
      kind: "project",
      projectSlug: "desktop",
      title: "Desktop",
    }));
    expect(onClose).toHaveBeenCalled();
  });

  it("clears the chosen folder when the signed-in session is replaced", async () => {
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
    useConnection.setState({ api: { post: vi.fn(), get } as never, authGeneration: 1 });
    useBoard.setState({ createProject, selectProject: vi.fn(async () => undefined) });
    render(<Tooltip.Provider><CreateProjectDialog open onClose={vi.fn()} /></Tooltip.Provider>);

    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Customer app" } });
    fireEvent.click(screen.getByRole("button", { name: "Use existing folder" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open workspaces" })).not.toBeNull());
    fireEvent.doubleClick(screen.getByRole("button", { name: "Open workspaces" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open customer-app" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open customer-app" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose customer-app" }));
    expect(screen.getByText(/^Selected:/)).toBeTruthy();

    // A replacement signed-in session (same slot, new credential) must drop the
    // folder picked under the previous owner.
    act(() => {
      useConnection.setState({ authGeneration: 2 });
    });

    expect(screen.queryByText(/^Selected:/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(createProject).not.toHaveBeenCalled();
  });

  it("keeps the dialog open with an error when project creation fails", async () => {
    const createProject = vi.fn(async () => null);
    const selectProject = vi.fn(async () => undefined);
    const openTab = vi.fn();
    const onClose = vi.fn();
    useBoard.setState({ createProject, selectProject });
    useTabs.setState({ openTab });

    render(<CreateProjectDialog open onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Desktop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByText(/Couldn't create the project/)).toBeTruthy());
    expect(selectProject).not.toHaveBeenCalled();
    expect(openTab).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
