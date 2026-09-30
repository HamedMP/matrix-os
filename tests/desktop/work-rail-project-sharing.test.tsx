// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const controller = vi.hoisted(() => ({
  start: vi.fn(),
  close: vi.fn(),
  error: false,
  lastOptions: null as null | Record<string, unknown>,
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

import { WorkRailProjectGroup } from "@desktop/renderer/src/features/work/work-rail/WorkRailProjectGroup";
import { useConnection } from "@desktop/renderer/src/stores/connection";

const alpha = { id: "proj_alpha", slug: "alpha", name: "Alpha", kind: "folder" as const };
const api = { baseUrl: "https://app.matrix-os.com", get: vi.fn(), post: vi.fn(), delete: vi.fn() };

function setup(sharing: { organizationId: string | null } | null) {
  useConnection.setState({ api: { patch: vi.fn() } as never });
  render(<WorkRailProjectGroup group={{ id: alpha.id, slug: alpha.slug, name: alpha.name, project: alpha, chats: [] }}
    expanded={false} pinning={{}} onToggle={vi.fn()} onNewChat={vi.fn()} onDeleteProject={vi.fn()}
    onSelectChat={vi.fn()} renamingChatId={null} renamePending={false} onRenameChat={vi.fn()}
    onRenameCommit={vi.fn()} onRenameCancel={vi.fn()} onPinChat={vi.fn()} onDeleteChat={vi.fn()}
    sharing={sharing ? { api: api as never, runtimeId: "vps:10000000-0000-4000-8000-000000000001", organizationId: sharing.organizationId } : null} />);
}

function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for Alpha" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
}

afterEach(() => {
  cleanup();
  controller.start.mockReset();
  controller.error = false;
  controller.lastOptions = null;
  useConnection.setState({ api: null });
});

describe("Electron Work rail project sharing (#1798)", () => {
  it("offers Share project in the project actions and starts the shared flow for the project", () => {
    setup({ organizationId: "org_matrix_team" });
    openMenu();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["Pin", "Edit", "Show in Files", "Share project", "Delete project"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Share project" }));

    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(controller.lastOptions).toMatchObject({
      runtimeId: "vps:10000000-0000-4000-8000-000000000001",
      organizationId: "org_matrix_team",
      projectId: "proj_alpha",
      projectName: "Alpha",
    });
    expect(screen.getByTestId("project-sharing-dialogs")).toBeTruthy();
  });

  it("names the missing organization instead of offering a silent disabled action", () => {
    setup({ organizationId: null });
    openMenu();
    const item = screen.getByRole("menuitem", { name: "Join an organization to share" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item);
    expect(controller.start).not.toHaveBeenCalled();
  });

  it("does not offer sharing when the computer cannot collaborate", () => {
    setup(null);
    openMenu();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["Pin", "Edit", "Show in Files", "Delete project"]);
  });

  it("does not offer sharing for a project without a canonical id", () => {
    useConnection.setState({ api: { patch: vi.fn() } as never });
    render(<WorkRailProjectGroup group={{ id: "legacy", slug: "legacy", name: "Legacy", project: { slug: "legacy", name: "Legacy", kind: "folder" }, chats: [] }}
      expanded={false} pinning={{}} onToggle={vi.fn()} onNewChat={vi.fn()} onDeleteProject={vi.fn()}
      onSelectChat={vi.fn()} renamingChatId={null} renamePending={false} onRenameChat={vi.fn()}
      onRenameCommit={vi.fn()} onRenameCancel={vi.fn()} onPinChat={vi.fn()} onDeleteChat={vi.fn()}
      sharing={{ api: api as never, runtimeId: "vps:10000000-0000-4000-8000-000000000001", organizationId: "org_matrix_team" }} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for Legacy" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    expect(screen.queryByRole("menuitem", { name: "Share project" })).toBeNull();
  });

  it("reports a failed share without changing the project", () => {
    controller.error = true;
    setup({ organizationId: "org_matrix_team" });
    expect(screen.getByRole("alert").textContent).toBe("Project sharing is unavailable. The project remains private and unchanged.");
  });
});
