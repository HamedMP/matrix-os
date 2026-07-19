// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CreateProjectDialog from "../../desktop/src/renderer/src/features/board/CreateProjectDialog";
import { AppError } from "../../desktop/src/renderer/src/lib/errors";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("CreateProjectDialog add-project flows", () => {
  beforeEach(() => {
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      authGeneration: 1,
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
    vi.unstubAllGlobals();
  });

  it("starts on three mode cards and navigates back", async () => {
    render(<CreateProjectDialog open onClose={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Existing folder/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Clone from GitHub/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /New folder/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Clone from GitHub/ }));
    expect(screen.getByPlaceholderText("https://github.com/owner/repo")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: /Clone from GitHub/ })).toBeTruthy();
    expect(screen.queryByPlaceholderText("https://github.com/owner/repo")).toBeNull();
  });

  describe("clone from GitHub", () => {
    function openCloneStep() {
      render(<Tooltip.Provider><CreateProjectDialog open onClose={vi.fn()} /></Tooltip.Provider>);
      fireEvent.click(screen.getByRole("button", { name: /Clone from GitHub/ }));
    }

    it.each([
      "http://github.com/owner/repo",
      "https://user:secret@github.com/owner/repo",
      "https://gitlab.com/owner/repo",
      "git@github.com:owner/repo.git",
      "https://github.com/owner",
    ])("rejects an invalid repository URL client-side: %s", async (url) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      openCloneStep();

      fireEvent.change(screen.getByPlaceholderText("https://github.com/owner/repo"), { target: { value: url } });
      fireEvent.click(screen.getByRole("button", { name: "Clone" }));

      expect(screen.getByText(/Enter a GitHub URL/)).toBeTruthy();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("derives the folder name from the repository and posts url, name, and branch", async () => {
      const fetchMock = vi.fn(async () => jsonResponse(201, { project: { slug: "repo", name: "repo" } }));
      vi.stubGlobal("fetch", fetchMock);
      const selectProject = vi.fn(async () => undefined);
      const loadProjects = vi.fn(async () => true);
      const openTab = vi.fn();
      const onClose = vi.fn();
      useBoard.setState({ selectProject, loadProjects });
      useTabs.setState({ openTab });

      render(<CreateProjectDialog open onClose={onClose} />);
      fireEvent.click(screen.getByRole("button", { name: /Clone from GitHub/ }));

      fireEvent.change(screen.getByPlaceholderText("https://github.com/owner/repo"), {
        target: { value: "https://github.com/owner/repo.git" },
      });
      await waitFor(() => expect(screen.getByPlaceholderText("Folder name")).toHaveProperty("value", "repo"));

      fireEvent.change(screen.getByPlaceholderText("Default branch"), { target: { value: "main" } });
      fireEvent.click(screen.getByRole("button", { name: "Clone" }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const [requestUrl, init] = fetchMock.mock.calls[0]!;
      expect(requestUrl).toBe("https://gateway.test/api/projects/clone");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        url: "https://github.com/owner/repo.git",
        name: "repo",
        branch: "main",
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);

      await waitFor(() => expect(selectProject).toHaveBeenCalledWith(expect.anything(), "repo"));
      expect(loadProjects).toHaveBeenCalled();
      expect(openTab).toHaveBeenCalledWith({ kind: "project", projectSlug: "repo", title: "repo" });
      expect(onClose).toHaveBeenCalled();
    });

    it("shows a progress state while the clone runs", async () => {
      let resolveClone!: (response: Response) => void;
      const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveClone = resolve; }));
      vi.stubGlobal("fetch", fetchMock);
      useBoard.setState({ selectProject: vi.fn(async () => undefined), loadProjects: vi.fn(async () => true) });

      render(<CreateProjectDialog open onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /Clone from GitHub/ }));
      fireEvent.change(screen.getByPlaceholderText("https://github.com/owner/repo"), {
        target: { value: "https://github.com/owner/big-repo" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Clone" }));

      await waitFor(() => expect(screen.getByText(/Cloning the repository/)).toBeTruthy());

      await act(async () => {
        resolveClone(jsonResponse(201, { project: { slug: "big-repo", name: "big-repo" } }));
      });
    });

    it("maps a slug conflict to a friendly message without raw git output", async () => {
      const fetchMock = vi.fn(async () => jsonResponse(409, { error: { code: "slug_conflict", message: "Project slug already exists" } }));
      vi.stubGlobal("fetch", fetchMock);
      const selectProject = vi.fn(async () => undefined);
      const openTab = vi.fn();
      useBoard.setState({ selectProject, loadProjects: vi.fn(async () => true) });
      useTabs.setState({ openTab });

      render(<CreateProjectDialog open onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /Clone from GitHub/ }));
      fireEvent.change(screen.getByPlaceholderText("https://github.com/owner/repo"), {
        target: { value: "https://github.com/owner/repo" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Clone" }));

      await waitFor(() => expect(screen.getByText(/already exists/)).toBeTruthy());
      expect(screen.queryByText(/stderr|fatal:/i)).toBeNull();
      expect(selectProject).not.toHaveBeenCalled();
      expect(openTab).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    it("shows a generic message when the clone fails", async () => {
      const fetchMock = vi.fn(async () => jsonResponse(502, { error: { code: "clone_failed", message: "Repository clone failed" } }));
      vi.stubGlobal("fetch", fetchMock);
      useBoard.setState({ selectProject: vi.fn(async () => undefined), loadProjects: vi.fn(async () => true) });

      render(<CreateProjectDialog open onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /Clone from GitHub/ }));
      fireEvent.change(screen.getByPlaceholderText("https://github.com/owner/repo"), {
        target: { value: "https://github.com/owner/repo" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Clone" }));

      await waitFor(() => expect(screen.getByText(/Couldn't clone the repository/)).toBeTruthy());
    });

    it("blocks an unsafe branch name client-side", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      openCloneStep();

      fireEvent.change(screen.getByPlaceholderText("https://github.com/owner/repo"), {
        target: { value: "https://github.com/owner/repo" },
      });
      fireEvent.change(screen.getByPlaceholderText("Default branch"), { target: { value: "a..b" } });
      fireEvent.click(screen.getByRole("button", { name: "Clone" }));

      expect(screen.getByText(/branch name/i)).toBeTruthy();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("new folder", () => {
    it("creates a scratch project in the projects root by default", async () => {
      const createProject = vi.fn(async () => ({ slug: "notes", name: "Notes" }));
      const selectProject = vi.fn(async () => undefined);
      const openTab = vi.fn();
      useBoard.setState({ createProject, selectProject });
      useTabs.setState({ openTab });

      render(<CreateProjectDialog open onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /New folder/ }));
      fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Notes" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => expect(createProject).toHaveBeenCalledWith(expect.anything(), {
        name: "Notes",
        mode: "scratch",
      }));
      await waitFor(() => expect(selectProject).toHaveBeenCalledWith(expect.anything(), "notes"));
    });

    it("creates the folder via the mkdir route under a chosen parent, then binds it", async () => {
      const get = vi.fn(async (requestPath: string) => {
        if (requestPath === "/api/files/list?path=") {
          return { entries: [{ name: "code", type: "directory" }, { name: "readme.md", type: "file" }] };
        }
        return { entries: [] };
      });
      const post = vi.fn(async (requestPath: string, body: unknown) => {
        if (requestPath === "/api/projects/mkdir") {
          expect(body).toEqual({ name: "side-project", parent: "code" });
          return { path: "code/side-project" };
        }
        throw new Error(`unexpected POST ${requestPath}`);
      });
      useConnection.setState({ api: { post, get, baseUrl: "https://gateway.test" } as never });
      const createProject = vi.fn(async () => ({ slug: "side-project", name: "Side Project" }));
      const selectProject = vi.fn(async () => undefined);
      useBoard.setState({ createProject, selectProject });
      useTabs.setState({ openTab: vi.fn() });

      render(<Tooltip.Provider><CreateProjectDialog open onClose={vi.fn()} /></Tooltip.Provider>);
      fireEvent.click(screen.getByRole("button", { name: /New folder/ }));
      fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Side Project" } });

      fireEvent.click(screen.getByRole("button", { name: "Choose a different folder…" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Open code" })).not.toBeNull());
      // Files are not selectable targets in the folder picker.
      expect(screen.queryByRole("button", { name: "Open readme.md" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Open code" }));
      fireEvent.click(screen.getByRole("button", { name: "Choose code" }));

      fireEvent.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => expect(post).toHaveBeenCalledWith("/api/projects/mkdir", { name: "side-project", parent: "code" }));
      await waitFor(() => expect(createProject).toHaveBeenCalledWith(expect.anything(), {
        name: "Side Project",
        mode: "folder",
        path: "code/side-project",
      }));
      await waitFor(() => expect(selectProject).toHaveBeenCalledWith(expect.anything(), "side-project"));
    });

    it("surfaces a folder conflict from the mkdir route without creating the project", async () => {
      const get = vi.fn(async () => ({ entries: [{ name: "code", type: "directory" }] }));
      const post = vi.fn(async () => {
        throw new AppError("server", { detail: "folder_conflict" });
      });
      useConnection.setState({ api: { post, get, baseUrl: "https://gateway.test" } as never });
      const createProject = vi.fn();
      useBoard.setState({ createProject, selectProject: vi.fn(async () => undefined) });

      render(<Tooltip.Provider><CreateProjectDialog open onClose={vi.fn()} /></Tooltip.Provider>);
      fireEvent.click(screen.getByRole("button", { name: /New folder/ }));
      fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "Side Project" } });
      fireEvent.click(screen.getByRole("button", { name: "Choose a different folder…" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Open code" })).not.toBeNull());
      fireEvent.click(screen.getByRole("button", { name: "Open code" }));
      fireEvent.click(screen.getByRole("button", { name: "Choose code" }));
      fireEvent.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => expect(screen.getByText(/already exists there/)).toBeTruthy());
      expect(createProject).not.toHaveBeenCalled();
    });

    it("requires a name that yields a usable folder slug", async () => {
      const createProject = vi.fn();
      useBoard.setState({ createProject, selectProject: vi.fn(async () => undefined) });

      render(<CreateProjectDialog open onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /New folder/ }));
      fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "!!!" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));

      expect(screen.getByText(/at least one letter or number/)).toBeTruthy();
      expect(createProject).not.toHaveBeenCalled();
    });
  });
});
