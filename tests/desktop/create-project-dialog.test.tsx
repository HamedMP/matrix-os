// @vitest-environment jsdom

import React, { useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CreateProjectDialog from "../../desktop/src/renderer/src/features/board/CreateProjectDialog";
import { AppError } from "../../desktop/src/renderer/src/lib/errors";
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
      api: { post: vi.fn(), get: vi.fn(), baseUrl: "https://gateway.test" } as never,
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

    fireEvent.click(screen.getByRole("button", { name: /New folder/ }));
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
    useConnection.setState({ api: { post: vi.fn(), get, baseUrl: "https://gateway.test" } as never });
    useBoard.setState({ createProject, selectProject: vi.fn(async () => undefined) });
    render(<Tooltip.Provider><CreateProjectDialog open onClose={vi.fn()} /></Tooltip.Provider>);

    fireEvent.click(screen.getByRole("button", { name: /Existing folder/ }));
    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Customer app" } });
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

  it("opens a project when the selected folder is already connected", async () => {
    const existingProject = {
      slug: "matrix-os",
      name: "Matrix OS",
      localPath: "/home/matrix/home/apps/matrix-os",
      githubBacked: false,
    };
    const get = vi.fn(async (requestPath: string) => {
      if (requestPath === "/api/files/list?path=") {
        return { entries: [{ name: "apps", type: "directory" }] };
      }
      if (requestPath === "/api/files/list?path=apps") {
        return { entries: [{ name: "matrix-os", type: "directory" }] };
      }
      return { entries: [] };
    });
    const createProject = vi.fn(async () => null);
    const selectProject = vi.fn(async () => undefined);
    const openTab = vi.fn();
    const onClose = vi.fn();
    useConnection.setState({ api: { post: vi.fn(), get, baseUrl: "https://gateway.test" } as never });
    useBoard.setState({ projects: [existingProject], createProject, selectProject });
    useTabs.setState({ openTab });

    render(<Tooltip.Provider><CreateProjectDialog open onClose={onClose} /></Tooltip.Provider>);
    fireEvent.click(screen.getByRole("button", { name: /Existing folder/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open apps" })).not.toBeNull());
    fireEvent.doubleClick(screen.getByRole("button", { name: "Open apps" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open matrix-os" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open matrix-os" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose matrix-os" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(selectProject).toHaveBeenCalledWith(expect.anything(), "matrix-os"));
    expect(createProject).not.toHaveBeenCalled();
    expect(openTab).toHaveBeenCalledWith({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("opens the existing project instead of connecting its Matrix-managed registry folder", async () => {
    const existingProject = {
      slug: "matrix-os",
      name: "Matrix OS",
      localPath: "/home/matrix/home/apps/matrix-os",
      githubBacked: false,
    };
    const get = vi.fn(async (requestPath: string) => {
      if (requestPath === "/api/files/list?path=") {
        return { entries: [{ name: "projects", type: "directory" }] };
      }
      if (requestPath === "/api/files/list?path=projects") {
        return { entries: [{ name: "matrix-os", type: "directory" }] };
      }
      return { entries: [] };
    });
    const createProject = vi.fn(async () => null);
    const selectProject = vi.fn(async () => undefined);
    const openTab = vi.fn();
    const onClose = vi.fn();
    useConnection.setState({ api: { post: vi.fn(), get, baseUrl: "https://gateway.test" } as never });
    useBoard.setState({ projects: [existingProject], createProject, selectProject });
    useTabs.setState({ openTab });

    render(<Tooltip.Provider><CreateProjectDialog open onClose={onClose} /></Tooltip.Provider>);
    fireEvent.click(screen.getByRole("button", { name: /Existing folder/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open projects" })).not.toBeNull());
    fireEvent.doubleClick(screen.getByRole("button", { name: "Open projects" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open matrix-os" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open matrix-os" }));

    expect(screen.getByText("This folder contains Matrix project data, not a workspace.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Matrix OS" }));

    await waitFor(() => expect(selectProject).toHaveBeenCalledWith(expect.anything(), "matrix-os"));
    expect(createProject).not.toHaveBeenCalled();
    expect(openTab).toHaveBeenCalledWith({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("blocks Matrix registry metadata folders while keeping repo workspaces selectable", async () => {
    const get = vi.fn(async (requestPath: string) => {
      if (requestPath === "/api/files/list?path=") {
        return { entries: [{ name: "projects", type: "directory" }] };
      }
      if (requestPath === "/api/files/list?path=projects") {
        return { entries: [{ name: "unregistered", type: "directory" }] };
      }
      if (requestPath === "/api/files/list?path=projects%2Funregistered") {
        return {
          entries: [
            { name: "repo", type: "directory" },
            { name: "worktrees", type: "directory" },
          ],
        };
      }
      return { entries: [] };
    });
    useConnection.setState({ api: { post: vi.fn(), get, baseUrl: "https://gateway.test" } as never });
    useBoard.setState({ projects: [] });

    render(<Tooltip.Provider><CreateProjectDialog open onClose={vi.fn()} /></Tooltip.Provider>);
    fireEvent.click(screen.getByRole("button", { name: /Existing folder/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open projects" })).not.toBeNull());
    fireEvent.doubleClick(screen.getByRole("button", { name: "Open projects" }));
    const registryFolder = await screen.findByRole("button", { name: "Open unregistered" });
    fireEvent.click(registryFolder);

    expect(screen.getByText("This folder is managed by Matrix and can't be used as a workspace.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose unregistered" }).hasAttribute("disabled")).toBe(true);

    fireEvent.doubleClick(registryFolder);
    const worktrees = await screen.findByRole("button", { name: "Open worktrees" });
    fireEvent.click(worktrees);
    expect(screen.getByRole("button", { name: "Choose worktrees" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Open repo" }));
    expect(screen.queryByText("This folder is managed by Matrix and can't be used as a workspace.")).toBeNull();
    expect(screen.getByRole("button", { name: "Choose repo" }).hasAttribute("disabled")).toBe(false);
  });

  it("opens an existing project when its selected repo workspace has a different folder name", async () => {
    const existingProject = {
      slug: "scratch-project",
      name: "Scratch Project",
      localPath: "/home/matrix/home/projects/scratch-project/repo",
      githubBacked: true,
    };
    const get = vi.fn(async (requestPath: string) => {
      if (requestPath === "/api/files/list?path=") {
        return { entries: [{ name: "projects", type: "directory" }] };
      }
      if (requestPath === "/api/files/list?path=projects") {
        return { entries: [{ name: "scratch-project", type: "directory" }] };
      }
      if (requestPath === "/api/files/list?path=projects%2Fscratch-project") {
        return { entries: [{ name: "repo", type: "directory" }] };
      }
      return { entries: [] };
    });
    const createProject = vi.fn(async () => null);
    const selectProject = vi.fn(async () => undefined);
    const openTab = vi.fn();
    const onClose = vi.fn();
    useConnection.setState({ api: { post: vi.fn(), get, baseUrl: "https://gateway.test" } as never });
    useBoard.setState({ projects: [existingProject], createProject, selectProject });
    useTabs.setState({ openTab });

    render(<Tooltip.Provider><CreateProjectDialog open onClose={onClose} /></Tooltip.Provider>);
    fireEvent.click(screen.getByRole("button", { name: /Existing folder/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open projects" })).not.toBeNull());
    fireEvent.doubleClick(screen.getByRole("button", { name: "Open projects" }));
    const registryFolder = await screen.findByRole("button", { name: "Open scratch-project" });
    fireEvent.doubleClick(registryFolder);
    const repo = await screen.findByRole("button", { name: "Open repo" });
    fireEvent.click(repo);
    fireEvent.click(screen.getByRole("button", { name: "Choose repo" }));
    expect(screen.getByPlaceholderText("Project name")).toHaveProperty("value", "repo");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(selectProject).toHaveBeenCalledWith(expect.anything(), "scratch-project"));
    expect(createProject).not.toHaveBeenCalled();
    expect(openTab).toHaveBeenCalledWith({
      kind: "project",
      projectSlug: "scratch-project",
      title: "Scratch Project",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("recovers an already-connected folder after a create conflict", async () => {
    const existingProject = {
      slug: "matrix-os",
      name: "Matrix OS",
      localPath: "/home/matrix/home/apps/matrix-os",
    };
    const post = vi.fn(async (requestPath: string) => {
      if (requestPath === "/api/projects") {
        throw new AppError("server", { detail: "slug_conflict" });
      }
      throw new Error(`unexpected POST ${requestPath}`);
    });
    const get = vi.fn(async (requestPath: string) => {
      if (requestPath === "/api/files/list?path=") {
        return { entries: [{ name: "apps", type: "directory" }] };
      }
      if (requestPath === "/api/files/list?path=apps") {
        return { entries: [{ name: "matrix-os", type: "directory" }] };
      }
      if (requestPath === "/api/workspace/projects") {
        return { projects: [existingProject] };
      }
      return { entries: [] };
    });
    const selectProject = vi.fn(async () => undefined);
    const openTab = vi.fn();
    const onClose = vi.fn();
    useBoard.setState(useBoard.getInitialState(), true);
    useBoard.setState({ selectProject });
    useConnection.setState({ api: { post, get, baseUrl: "https://gateway.test" } as never });
    useTabs.setState({ openTab });

    render(<Tooltip.Provider><CreateProjectDialog open onClose={onClose} /></Tooltip.Provider>);
    fireEvent.click(screen.getByRole("button", { name: /Existing folder/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open apps" })).not.toBeNull());
    fireEvent.doubleClick(screen.getByRole("button", { name: "Open apps" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open matrix-os" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open matrix-os" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose matrix-os" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(selectProject).toHaveBeenCalledWith(expect.anything(), "matrix-os"));
    expect(post).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({ name: "matrix-os", mode: "folder", path: "apps/matrix-os" }),
      { timeoutMs: 30_000 },
    );
    expect(openTab).toHaveBeenCalledWith({
      kind: "project",
      projectSlug: "matrix-os",
      title: "Matrix OS",
    });
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByText(/Check that it exists on this computer/)).toBeNull();
  });

  it("asks for another name when the project slug belongs to a different folder", async () => {
    const existingProject = {
      slug: "matrix-os",
      name: "Matrix OS",
      localPath: "/home/matrix/home/apps/matrix-os",
      githubBacked: false,
    };
    const get = vi.fn(async (requestPath: string) => {
      if (requestPath === "/api/files/list?path=") {
        return { entries: [{ name: "apps", type: "directory" }] };
      }
      if (requestPath === "/api/files/list?path=apps") {
        return { entries: [{ name: "other-app", type: "directory" }] };
      }
      return { entries: [] };
    });
    const createProject = vi.fn(async () => null);
    const selectProject = vi.fn(async () => undefined);
    useConnection.setState({ api: { post: vi.fn(), get, baseUrl: "https://gateway.test" } as never });
    useBoard.setState({ projects: [existingProject], createProject, selectProject });

    render(<Tooltip.Provider><CreateProjectDialog open onClose={vi.fn()} /></Tooltip.Provider>);
    fireEvent.click(screen.getByRole("button", { name: /Existing folder/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open apps" })).not.toBeNull());
    fireEvent.doubleClick(screen.getByRole("button", { name: "Open apps" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open other-app" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open other-app" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose other-app" }));
    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Matrix OS" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByText(
      "A project named “Matrix OS” already exists. Choose another name.",
    )).toBeTruthy());
    expect(createProject).not.toHaveBeenCalled();
    expect(selectProject).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole("button", { name: /New folder/ }));
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
    useConnection.setState({ api: { post: vi.fn(), get, baseUrl: "https://gateway.test" } as never, authGeneration: 1 });
    useBoard.setState({ createProject, selectProject: vi.fn(async () => undefined) });
    render(<Tooltip.Provider><CreateProjectDialog open onClose={vi.fn()} /></Tooltip.Provider>);

    fireEvent.click(screen.getByRole("button", { name: /Existing folder/ }));
    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Customer app" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Open workspaces" })).not.toBeNull());
    fireEvent.doubleClick(screen.getByRole("button", { name: "Open workspaces" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open customer-app" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open customer-app" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose customer-app" }));
    expect(screen.getByText(/^Selected:/)).toBeTruthy();

    // A replacement signed-in session (same slot, new credential) must drop the
    // folder picked under the previous owner.
    await act(async () => {
      useConnection.setState({ authGeneration: 2 });
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByText(/^Selected:/)).toBeNull());
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
    fireEvent.click(screen.getByRole("button", { name: /New folder/ }));
    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Desktop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByText(/Couldn't create the project/)).toBeTruthy());
    expect(selectProject).not.toHaveBeenCalled();
    expect(openTab).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
