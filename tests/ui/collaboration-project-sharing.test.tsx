// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CollaborationProjectInventory, CollaborationScope } from "@matrix-os/contracts";
import { ProjectSharingDialog } from "../../packages/ui/src/collaboration/ProjectSharingDialog";
import { ProjectSharingButton } from "../../packages/ui/src/collaboration/ProjectSharingButton";
import { ChatCollaboratorsDialog } from "../../packages/ui/src/collaboration/ChatCollaboratorsDialog";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});

const scope: CollaborationScope = {
  id: "10000000-0000-4000-8000-000000000401",
  ownerId: "user_owner",
  kind: "project",
  resourceId: "proj_launch",
  membershipMode: "direct",
  lifecycle: "private",
  revision: "4",
  authEpoch: "3",
  authorityGeneration: "1",
  role: "owner",
  capabilities: {
    read: false,
    discuss: false,
    manageMembers: true,
    requestAi: false,
    observeTerminal: false,
    controlTerminal: false,
    stopTerminal: false,
  },
};

describe("whole-project sharing confirmation", () => {
  it("keeps the share action disabled until runtime identity is ready", () => {
    const api = apiFixture();
    render(<ProjectSharingButton api={api} runtimeId={null} projectId="proj_launch" projectName="Launch" />);

    expect(screen.getByRole("button", { name: "Share project" })).toBeDisabled();
    expect(screen.getByText("Loading share…")).toBeVisible();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("creates one private project scope before showing the complete inventory", async () => {
    const api = apiFixture();
    api.post
      .mockResolvedValueOnce({ eligible: true, resourceRevision: "7", confirmationToken: "p".repeat(64) })
      .mockResolvedValueOnce(scope);
    api.get
      .mockResolvedValueOnce(scope)
      .mockResolvedValueOnce({ members: [] })
      .mockResolvedValueOnce(completeInventory());
    render(<ProjectSharingButton api={api} runtimeId="vps:runtime" projectId="proj_launch" projectName="Launch" />);

    fireEvent.click(screen.getByRole("button", { name: "Share project" }));
    expect(await screen.findByRole("heading", { name: "Share the whole Launch project?" })).toBeVisible();
    expect(api.post).toHaveBeenNthCalledWith(1, "/api/collaboration/runtimes/vps:runtime/scopes/preflight", {
      kind: "project",
      resourceId: "proj_launch",
    });
    expect(api.post).toHaveBeenNthCalledWith(2, "/api/collaboration/runtimes/vps:runtime/scopes", expect.objectContaining({
      kind: "project",
      resourceId: "proj_launch",
      expectedRevision: "7",
      confirmationToken: "p".repeat(64),
    }));
  });

  it("shows one complete no-exclusions inventory and separates external references", () => {
    renderDialog({ inventory: completeInventory() });
    expect(screen.getByRole("heading", { name: "Share the whole Launch project?" })).toBeVisible();
    expect(screen.getByText(/Everything owned by this project shares together/i)).toBeVisible();
    expect(screen.getByText(/You can't exclude individual files, Chats, apps, layout, or terminals/i)).toBeVisible();
    expect(screen.getByText("README.md")).toBeVisible();
    expect(screen.getByText("Launch discussion")).toBeVisible();
    expect(screen.getByText("Roadmap app")).toBeVisible();
    expect(screen.getByText("Shared canvas")).toBeVisible();
    expect(screen.getByText("Release terminal")).toBeVisible();
    expect(screen.getByText("Personal notes")).toBeVisible();
    expect(screen.getByText(/stays outside this project share/i)).toBeVisible();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("explains item membership effects without silently promoting recipients", () => {
    renderDialog({ inventory: completeInventory() });
    expect(screen.getByText(/Ada joins the whole project as editor/i)).toBeVisible();
    expect(screen.getByText(/Lin's standalone Chat access ends/i)).toBeVisible();
    expect(screen.getByText(/Maya keeps standalone access only to Personal notes/i)).toBeVisible();
    expect(screen.getByText(/Lin is not added to the project/i)).toBeVisible();
  });

  it("describes project invitations as whole-project access", () => {
    render(<ChatCollaboratorsDialog api={apiFixture()} scope={scope} members={[]}
      onRefresh={async () => ({ scope, members: [] })} onClose={vi.fn()} />);

    expect(screen.getByText(/applies to this whole project and its future project-owned contents/i)).toBeVisible();
    expect(screen.getByText(/External references and unrelated resources stay outside the share/i)).toBeVisible();
    expect(screen.queryByText(/does not grant access to its project/i)).toBeNull();
  });

  it("blocks confirmation when any owned resource cannot cross the authority boundary", () => {
    const inventory = completeInventory();
    inventory.ownedItems[4] = {
      ...inventory.ownedItems[4]!,
      compatibility: "blocked",
      blocker: "terminal_incarnation_unavailable",
    };
    inventory.blockers = [{
      kind: "terminal",
      id: "Release terminal",
      code: "terminal_incarnation_unavailable",
    }];
    renderDialog({ inventory });
    expect(screen.getByRole("alert")).toHaveTextContent(/Release terminal must be made shareable/i);
    expect(screen.getByRole("button", { name: "Share whole project" })).toBeDisabled();
  });

  it("requires review of a changed inventory before a second confirmation", async () => {
    const first = completeInventory();
    const changed = {
      ...completeInventory(),
      projectRevision: "8",
      scopeRevision: "5",
      inventoryHash: "d".repeat(64),
      inventoryToken: "z".repeat(64),
      ownedItems: [...completeInventory().ownedItems, {
        kind: "file" as const,
        id: "new-plan.md",
        revision: "1",
        compatibility: "ready" as const,
      }],
    };
    const api = apiFixture();
    api.post.mockRejectedValueOnce(new Error("conflict")).mockResolvedValueOnce({
      id: "20000000-0000-4000-8000-000000000401",
      scopeId: scope.id,
      status: "prepared",
      inventoryRevision: "8",
      createdAt: "2026-08-22T12:00:00.000Z",
      updatedAt: "2026-08-22T12:00:00.000Z",
    });
    const refreshInventory = vi.fn(async () => changed);
    render(<ProjectSharingDialog api={api} scope={scope} projectName="Launch" inventory={first}
      refreshInventory={refreshInventory} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Share whole project" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Project contents changed/i);
    expect(refreshInventory).toHaveBeenCalledTimes(1);
    expect(screen.getByText("new-plan.md")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Share whole project" }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith(
      `/api/collaboration/scopes/${scope.id}/project/confirm`,
      expect.objectContaining({
        expectedScopeRevision: "5",
        expectedProjectRevision: "8",
        inventoryHash: "d".repeat(64),
        inventoryToken: "z".repeat(64),
      }),
    ));
    expect(await screen.findByText(/Preparing the shared project/i)).toBeVisible();
  });
});

function renderDialog({ inventory }: { inventory: CollaborationProjectInventory }) {
  return render(<ProjectSharingDialog api={apiFixture()} scope={scope} projectName="Launch"
    inventory={inventory} refreshInventory={async () => inventory} onClose={vi.fn()} />);
}

function apiFixture() {
  return {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(),
    post: vi.fn(async () => ({
      id: "20000000-0000-4000-8000-000000000401",
      scopeId: scope.id,
      status: "prepared",
      inventoryRevision: "7",
      createdAt: "2026-08-22T12:00:00.000Z",
      updatedAt: "2026-08-22T12:00:00.000Z",
    })),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

function completeInventory(): CollaborationProjectInventory {
  return {
    scopeId: scope.id,
    projectId: "proj_launch",
    projectRevision: "7",
    scopeRevision: "4",
    ownedItems: [
      { kind: "file", id: "README.md", revision: "1", compatibility: "ready" },
      { kind: "chat", id: "Launch discussion", revision: "2", compatibility: "ready" },
      { kind: "app", id: "Roadmap app", revision: "3", compatibility: "ready" },
      { kind: "layout", id: "Shared canvas", revision: "4", compatibility: "ready" },
      { kind: "terminal", id: "Release terminal", revision: "5", compatibility: "ready", incarnation: "terminal_release" },
    ],
    externalReferences: [{ kind: "chat", id: "Personal notes", revision: "1" }],
    blockers: [],
    membershipEffects: [
      { actor: { actorId: "user_ada", displayName: "Ada" }, role: "editor", effect: "join_project" },
      { actor: { actorId: "user_lin", displayName: "Lin" }, role: "viewer", effect: "end_item_grant", resourceKind: "chat", resourceId: "Launch discussion" },
      { actor: { actorId: "user_maya", displayName: "Maya" }, role: "viewer", effect: "retain_item_only", resourceKind: "chat", resourceId: "Personal notes" },
    ],
    inventoryHash: "a".repeat(64),
    membershipHash: "b".repeat(64),
    inventoryToken: "c".repeat(64),
    expiresAt: "2026-08-22T12:10:00.000Z",
  };
}
