// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sharingController = vi.hoisted(() => ({
  start: vi.fn(),
  lastOptions: null as null | Record<string, unknown>,
}));

vi.mock("@matrix-os/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@matrix-os/ui")>();
  return {
    ...actual,
    useProjectSharing: (options: Record<string, unknown>) => {
      sharingController.lastOptions = options;
      return {
        pending: false,
        open: false,
        error: false,
        start: sharingController.start,
        close: vi.fn(),
        dialogs: <div data-testid="project-sharing-dialogs" />,
      };
    },
  };
});

vi.mock("@desktop/renderer/src/features/project/DesktopProjectSharing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@desktop/renderer/src/features/project/DesktopProjectSharing")>();
  return {
    ...actual,
    useDesktopProjectSharingContext: () => ({
      api: { baseUrl: "https://app.matrix-os.com", get: vi.fn(), post: vi.fn(), delete: vi.fn() },
      runtimeId: "vps:10000000-0000-4000-8000-000000000001",
      organizationId: "org_matrix_team",
    }),
  };
});

import CreateProjectDialog from "@desktop/renderer/src/features/board/CreateProjectDialog";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useTabs } from "@desktop/renderer/src/stores/tabs";

describe("project creation sharing", () => {
  beforeEach(() => {
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      organizationId: "org_matrix_team",
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
      createProject: vi.fn(async () => ({ id: "proj_alpha", slug: "alpha", name: "Alpha", kind: "scratch" as const })),
      selectProject: vi.fn(async () => undefined),
    });
    useTabs.setState({ tabs: [], activeTabId: null });
  });

  afterEach(() => {
    cleanup();
    sharingController.start.mockReset();
    sharingController.lastOptions = null;
    vi.restoreAllMocks();
  });

  it("offers whole-project sharing during creation and opens the existing share flow after success", async () => {
    render(<Tooltip.Provider><CreateProjectDialog open onClose={vi.fn()} /></Tooltip.Provider>);

    fireEvent.change(screen.getByLabelText("What are you working on?"), { target: { value: "Alpha" } });
    fireEvent.click(screen.getByRole("button", { name: /New folder/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Share project after creating" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(sharingController.start).toHaveBeenCalledTimes(1));
    expect(sharingController.lastOptions).toMatchObject({
      runtimeId: "vps:10000000-0000-4000-8000-000000000001",
      organizationId: "org_matrix_team",
      projectId: "proj_alpha",
      projectName: "Alpha",
    });
    expect(screen.getByTestId("project-sharing-dialogs")).toBeTruthy();
  });
});
