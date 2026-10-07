// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const controller = vi.hoisted(() => ({
  start: vi.fn(),
  close: vi.fn(),
  error: false,
  lastOptions: null as null | Record<string, unknown>,
}));
const sharingState = vi.hoisted(() => ({
  organizationId: "org_matrix_team" as string | null,
  available: true,
}));

vi.mock("@matrix-os/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@matrix-os/ui")>();
  return {
    ...actual,
    useProjectSharing: (options: Record<string, unknown>) => {
      controller.lastOptions = options;
      return {
        pending: false,
        open: false,
        error: controller.error,
        start: controller.start,
        close: controller.close,
        dialogs: <div data-testid="project-sharing-dialogs" />,
      };
    },
  };
});

vi.mock("@desktop/renderer/src/features/project/DesktopProjectSharing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@desktop/renderer/src/features/project/DesktopProjectSharing")>();
  return {
    ...actual,
    useDesktopProjectSharingContext: () => sharingState.available ? ({
      api: { baseUrl: "https://app.matrix-os.com", get: vi.fn(), post: vi.fn(), delete: vi.fn() },
      runtimeId: "vps:10000000-0000-4000-8000-000000000001",
      organizationId: sharingState.organizationId,
    }) : null,
  };
});

import { WorkRail } from "@desktop/renderer/src/features/work/WorkRail";
import { useConnection } from "@desktop/renderer/src/stores/connection";

const alpha = { id: "proj_alpha", slug: "alpha", name: "Alpha", kind: "folder" as const };

function rail() {
  return <WorkRail client={null} projects={[alpha]} active activeProjectSlug={alpha.slug}
    onNewGlobalChat={vi.fn()} onCreateProject={vi.fn()} onNewProjectChat={vi.fn()}
    onSelectChat={vi.fn()} onCollapse={vi.fn()} />;
}

function setup(sharing: { organizationId: string | null } | null) {
  sharingState.available = sharing !== null;
  sharingState.organizationId = sharing?.organizationId ?? null;
  useConnection.setState({ api: { patch: vi.fn() } as never, userId: null });
  return render(rail());
}

function openMenu() {
  fireEvent.contextMenu(screen.getByRole("button", { name: "Alpha" }));
}

afterEach(() => {
  cleanup();
  controller.start.mockReset();
  controller.error = false;
  controller.lastOptions = null;
  sharingState.available = true;
  sharingState.organizationId = "org_matrix_team";
  useConnection.setState({ api: null });
});

describe("Chats project sharing", () => {
  it("starts whole-project sharing from the project menu and survives section collapse", async () => {
    const view = setup({ organizationId: "org_matrix_team" });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Share project" }));

    await waitFor(() => expect(controller.start).toHaveBeenCalledTimes(1));
    expect(controller.lastOptions).toMatchObject({
      runtimeId: "vps:10000000-0000-4000-8000-000000000001",
      organizationId: "org_matrix_team",
      projectId: "proj_alpha",
      projectName: "Alpha",
    });
    expect(screen.getByTestId("project-sharing-dialogs")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(screen.getByTestId("project-sharing-dialogs")).toBeTruthy();

    sharingState.organizationId = "org_other";
    view.rerender(rail());
    await waitFor(() => expect(screen.queryByTestId("project-sharing-dialogs")).toBeNull());
  });

  it("keeps the project action visible but disabled while organization access is unresolved", () => {
    setup({ organizationId: null });
    openMenu();
    const item = screen.getByRole("menuitem", { name: "Loading sharing…" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item);
    expect(controller.start).not.toHaveBeenCalled();
  });

  it("does not show a dead Share action without collaboration support", () => {
    setup(null);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: /share/i })).toBeNull();
  });
});
