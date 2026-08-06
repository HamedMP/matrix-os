// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import ProjectLifecycleDialog from "@desktop/renderer/src/features/mission-control/ProjectLifecycleDialog";
import { useBoard, type Project } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useProjectLifecycle } from "@desktop/renderer/src/stores/project-lifecycle";

const folderProject: Project = {
  slug: "customer-app",
  name: "Customer app",
  kind: "folder",
  localPath: "/home/matrix/home/workspaces/customer-app",
};

function api(post = vi.fn(async () => ({ ok: true }))): ApiClient {
  return {
    baseUrl: "https://matrix.test",
    get: vi.fn(async (path: string) => path.includes("archived") ? { projects: [] } : { projects: [] }),
    post,
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getText: vi.fn(),
    getBlob: vi.fn(),
    putText: vi.fn(),
  } as ApiClient;
}

beforeEach(() => {
  useBoard.setState(useBoard.getInitialState(), true);
  useProjectLifecycle.setState(useProjectLifecycle.getInitialState(), true);
  useConnection.setState({ api: api(), status: "signed-in" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProjectLifecycleDialog", () => {
  it("clears an error left by a previous lifecycle action when opened", async () => {
    useProjectLifecycle.setState({ error: "Stop active project work before continuing." });

    render(<ProjectLifecycleDialog open project={folderProject} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("explains external-folder preservation and requires the exact project name", async () => {
    const post = vi.fn(async () => ({ ok: true, action: "delete", projectSlug: "customer-app" }));
    useConnection.setState({ api: api(post) });
    const onClose = vi.fn();

    render(<ProjectLifecycleDialog open project={folderProject} onClose={onClose} />);

    expect(screen.getByText(/original folder and files will stay untouched/i)).not.toBeNull();
    const submit = screen.getByRole("button", { name: "Delete project" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText(/type Customer app to confirm/i), { target: { value: "customer-app" } });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText(/type Customer app to confirm/i), { target: { value: "Customer app" } });
    fireEvent.click(submit);

    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/projects/customer-app/actions", {
      type: "delete",
      confirmation: "Customer app",
    }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
