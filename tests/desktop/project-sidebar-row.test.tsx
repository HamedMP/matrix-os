// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { AppError } from "@desktop/shared/app-error";
import ProjectSidebarRow from "@desktop/renderer/src/features/mission-control/ProjectSidebarRow";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useProjectLifecycle } from "@desktop/renderer/src/stores/project-lifecycle";
import { useUi } from "@desktop/renderer/src/stores/ui";

beforeEach(() => {
  useUi.setState(useUi.getInitialState(), true);
  useProjectLifecycle.setState(useProjectLifecycle.getInitialState(), true);
  useConnection.setState({ status: "signed-in", api: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProjectSidebarRow", () => {
  it("keeps the project open target separate from the lifecycle overflow menu", async () => {
    const onOpen = vi.fn();
    render(<ProjectSidebarRow
      project={{ slug: "repo", name: "Repo", kind: "scratch" }}
      active={false}
      attention={0}
      onOpen={onOpen}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Open Repo" }));
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Project actions for Repo" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await screen.findByText("Archive project")).not.toBeNull();
    expect(await screen.findByText("Delete project")).not.toBeNull();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("marks the renderer overlay while the project action menu is open", async () => {
    render(<ProjectSidebarRow
      project={{ slug: "repo", name: "Repo", kind: "scratch" }}
      active={false}
      attention={0}
      onOpen={vi.fn()}
    />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Project actions for Repo" }), {
      button: 0,
      ctrlKey: false,
    });

    await waitFor(() => expect(useUi.getState().rendererOverlayCount).toBe(1));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(useUi.getState().rendererOverlayCount).toBe(0));
  });

  it("archives immediately from the menu without opening a confirmation dialog", async () => {
    const post = vi.fn(() => new Promise<never>(() => undefined));
    useConnection.setState({
      status: "signed-in",
      api: {
        baseUrl: "https://matrix.test",
        get: vi.fn(),
        post,
        patch: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        getText: vi.fn(),
        getBlob: vi.fn(),
        putText: vi.fn(),
      } as ApiClient,
    });
    render(<ProjectSidebarRow
      project={{ slug: "repo", name: "Repo", kind: "scratch" }}
      active={false}
      attention={0}
      onOpen={vi.fn()}
    />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Project actions for Repo" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByText("Archive project"));

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      "/api/projects/repo/actions",
      { type: "archive" },
    ));
    expect(screen.queryByRole("heading", { name: "Archive project?" })).toBeNull();
  });

  it("keeps the native embed detached while showing an archive failure", async () => {
    useConnection.setState({
      status: "signed-in",
      api: {
        baseUrl: "https://matrix.test",
        get: vi.fn(),
        post: vi.fn(async () => { throw new AppError("notFound"); }),
        patch: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        getText: vi.fn(),
        getBlob: vi.fn(),
        putText: vi.fn(),
      } as ApiClient,
    });
    render(<ProjectSidebarRow
      project={{ slug: "repo", name: "Repo", kind: "scratch" }}
      active={false}
      attention={0}
      onOpen={vi.fn()}
    />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Project actions for Repo" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByText("Archive project"));

    await screen.findByRole("heading", { name: "Project couldn't be archived" });
    expect(screen.getByText("Update this Matrix computer before managing projects.")).not.toBeNull();
    expect(useUi.getState().rendererOverlayCount).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(useUi.getState().rendererOverlayCount).toBe(0));
  });
});
