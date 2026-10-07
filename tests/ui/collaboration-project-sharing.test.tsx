// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    render(<ProjectSharingButton api={api} runtimeId={null} organizationId="org_matrix_team" projectId="proj_launch" projectName="Launch" />);

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
    render(<ProjectSharingButton api={api} runtimeId="vps:runtime" organizationId="org_matrix_team" projectId="proj_launch" projectName="Launch" />);

    fireEvent.click(screen.getByRole("button", { name: "Share project" }));
    expect(await screen.findByRole("heading", { name: "Share the whole Launch project?" })).toBeVisible();
    expect(api.post).toHaveBeenNthCalledWith(1, "/api/collaboration/runtimes/vps%3Aruntime/scopes/preflight", {
      kind: "project",
      resourceId: "proj_launch",
      organizationId: "org_matrix_team",
    });
    expect(api.post).toHaveBeenNthCalledWith(2, "/api/collaboration/runtimes/vps%3Aruntime/scopes", expect.objectContaining({
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
    expect(screen.getAllByText("Launch discussion").length).toBeGreaterThan(0);
    expect(screen.getByText("Roadmap app")).toBeVisible();
    expect(screen.getByText("Shared canvas")).toBeVisible();
    expect(screen.getByText("Release terminal")).toBeVisible();
    expect(screen.getByText("Personal notes")).toBeVisible();
    expect(screen.getByText(/stays outside this project share/i)).toBeVisible();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shows every Chat root and the owner's Git readiness before sharing", () => {
    const inventory = completeInventory();
    inventory.ownedItems[1] = {
      ...inventory.ownedItems[1]!, executionRoot: { kind: "worktree", projectId: "proj_launch", worktreeId: "chat_42" },
      branch: "feature/launch", dirty: true, rootFingerprint: "e".repeat(64),
    };
    inventory.gitSetup = {
      identity: { status: "ready", label: "Project Owner <owner@example.test>" },
      forgeCredential: { status: "missing" },
    };
    renderDialog({ inventory });
    expect(screen.getByText(/Chat worktree chat_42/)).toBeVisible();
    expect(screen.getByText(/feature\/launch/)).toBeVisible();
    expect(screen.getByText(/Uncommitted changes/)).toBeVisible();
    expect(screen.getByText(/Project Owner <owner@example.test>/)).toBeVisible();
    expect(screen.getByText(/GitHub access is missing/)).toBeVisible();
  });

  it("explains item membership effects without silently promoting recipients", () => {
    renderDialog({ inventory: completeInventory() });
    expect(screen.getByText(/Ada joins the whole project as editor/i)).toBeVisible();
    expect(screen.getByText(/Lin's standalone Chat access ends/i)).toBeVisible();
    expect(screen.getByText(/Maya keeps standalone access only to Personal notes/i)).toBeVisible();
    expect(screen.getByText(/Lin is not added to the project/i)).toBeVisible();
  });

  it("lets the owner choose who gets access before sharing the project", async () => {
    // Before confirmation the project is private. The owner picks its audience now (through the
    // owner setup key); the grants are recorded and start when the project is shared.
    const privateScope: CollaborationScope = { ...scope, organizationId: "org_matrix_team" };
    const grant = {
      id: "60000000-0000-4000-8000-000000000401", scopeId: scope.id, organizationId: "org_matrix_team",
      audience: { kind: "member", actorId: "user_ada" }, preset: "viewer", state: "pending", policyVersion: "v1",
      revision: "1", createdAt: "2026-08-22T12:00:00.000Z", updatedAt: "2026-08-22T12:00:00.000Z",
    };
    let grants: unknown[] = [];
    const api = apiFixture();
    api.get.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/organizations/")) return { members: [{
        actorId: "user_ada",
        displayName: "Ada",
        role: "org:member",
        joinedAt: "2026-08-01T00:00:00.000Z",
      }] };
      if (path.endsWith("/grants")) return grants;
      return { ...privateScope, revision: grants.length ? "5" : "4" };
    });
    // An organization grant made earlier is stored active on the home, but nobody has access before the share.
    const organizationGrant = { ...grant, id: "60000000-0000-4000-8000-000000000402", audience: { kind: "organization" }, state: "active" };
    api.post.mockImplementation(async (path: string) => {
      if (!path.endsWith("/grants")) throw new Error("unexpected");
      grants = [grant, organizationGrant];
      return grant;
    });
    render(<ChatCollaboratorsDialog api={api} scope={privateScope} members={[]}
      onRefresh={async () => ({ scope: privateScope, members: [] })} onClose={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Choose who gets access" })).toBeVisible();
    expect(screen.getByText(/if you choose no one, everyone in your organization gets contributor access/i)).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Grant access" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Share with"), { target: { value: "user_ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
    expect(await screen.findByText("Access starts when you share the whole project.")).toBeVisible();
    expect(api.post).toHaveBeenCalledWith(`/api/collaboration/scopes/${scope.id}/grants`, expect.objectContaining({
      expectedRevision: "4", audience: { kind: "member", actorId: "user_ada" }, preset: "viewer",
    }));
    expect(await screen.findByRole("combobox", { name: "Preset for user_ada" })).toBeVisible();
    // Every grant, including an organization grant stored active, reads as starting at share time.
    expect(screen.getAllByText("Starts when shared")).toHaveLength(2);
    expect(screen.queryByText("Active")).toBeNull();
    expect(screen.queryByText(/Share the whole project to manage access/i)).toBeNull();
    // A private project has no readiness to load yet.
    expect(api.post).not.toHaveBeenCalledWith(expect.stringContaining("/policy/preflight"), expect.anything());
  });

  it("asks the owner to wait while a confirmed share is still being published", () => {
    const api = apiFixture();
    const preparing: CollaborationScope = { ...scope, organizationId: "org_matrix_team", lifecycle: "preparing" };
    render(<ChatCollaboratorsDialog api={api} scope={preparing} members={[]}
      onRefresh={async () => ({ scope: preparing, members: [] })} onClose={vi.fn()} />);

    expect(screen.getByText("Access can be changed once sharing finishes.")).toBeVisible();
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining("/grants"));
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
    let confirmations = 0;
    api.post.mockImplementation(async (path: string) => {
      if (path.endsWith("/policy/preflight")) return undefined;
      if (!path.endsWith("/project/confirm")) throw new Error("unexpected route");
      confirmations += 1;
      if (confirmations === 1) throw new Error("conflict");
      return {
      id: "20000000-0000-4000-8000-000000000401",
      scopeId: scope.id,
      status: "prepared",
      inventoryRevision: "8",
      createdAt: "2026-08-22T12:00:00.000Z",
      updatedAt: "2026-08-22T12:00:00.000Z",
      };
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

  it("waits for publication after confirming, then opens collaborators on the shared project", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const shared: CollaborationScope = { ...scope, lifecycle: "shared", revision: "5" };
      const api = apiFixture();
      let published = false;
      let scopeReads = 0;
      api.post.mockImplementation(async (path: string) => {
        if (path.endsWith("/scopes/preflight")) return { eligible: true, resourceRevision: "7", confirmationToken: "p".repeat(64) };
        if (path.endsWith("/scopes")) return scope;
        if (path.endsWith("/policy/preflight")) return undefined;
        if (path.endsWith("/project/confirm")) {
          return { id: "20000000-0000-4000-8000-000000000401", scopeId: scope.id, status: "prepared", inventoryRevision: "7",
            createdAt: "2026-08-22T12:00:00.000Z", updatedAt: "2026-08-22T12:00:00.000Z" };
        }
        throw new Error(`unexpected POST ${path}`);
      });
      api.get.mockImplementation(async (path: string) => {
        if (path.endsWith("/members")) return { members: [] };
        if (path.endsWith("/project/inventory")) return completeInventory();
        if (path.endsWith("/grants")) return { grants: [] };
        if (path.startsWith("/api/organizations/")) return { members: [] };
        scopeReads += 1;
        if (scopeReads === 1) return scope;
        // Until the home publishes the project, the scope is not reachable with the scope key.
        if (!published) throw new Error("CollaborationUnavailable");
        return shared;
      });
      render(<ProjectSharingButton api={api} runtimeId="vps:runtime" organizationId="org_matrix_team" projectId="proj_launch" projectName="Launch" />);
      fireEvent.click(screen.getByRole("button", { name: "Share project" }));
      fireEvent.click(await screen.findByRole("button", { name: "Share whole project" }));
      expect(await screen.findByText(/Preparing the shared project/i)).toBeVisible();

      await vi.advanceTimersByTimeAsync(1_500);
      expect(screen.queryByRole("dialog", { name: "Invite collaborators" })).toBeNull();
      published = true;
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await screen.findByRole("dialog", { name: "Invite collaborators" })).toBeVisible();
      expect(screen.queryByText(/Share the whole project to manage access/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reopens collaborators when a read finishes after the owner closed the dialog", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const shared: CollaborationScope = { ...scope, lifecycle: "shared", revision: "5" };
      const api = apiFixture();
      let scopeReads = 0;
      let finishRead: (value: CollaborationScope) => void = () => undefined;
      api.post.mockImplementation(async (path: string) => {
        if (path.endsWith("/scopes/preflight")) return { eligible: true, resourceRevision: "7", confirmationToken: "p".repeat(64) };
        if (path.endsWith("/scopes")) return scope;
        if (path.endsWith("/policy/preflight")) return undefined;
        return { id: "20000000-0000-4000-8000-000000000401", scopeId: scope.id, status: "prepared", inventoryRevision: "7",
          createdAt: "2026-08-22T12:00:00.000Z", updatedAt: "2026-08-22T12:00:00.000Z" };
      });
      api.get.mockImplementation(async (path: string) => {
        if (path.endsWith("/members")) return { members: [] };
        if (path.endsWith("/project/inventory")) return completeInventory();
        scopeReads += 1;
        if (scopeReads === 1) return scope;
        // The publication read is still in flight when the owner closes the dialog.
        return new Promise<CollaborationScope>((resolve) => { finishRead = resolve; });
      });
      render(<ProjectSharingButton api={api} runtimeId="vps:runtime" organizationId="org_matrix_team" projectId="proj_launch" projectName="Launch" />);
      fireEvent.click(screen.getByRole("button", { name: "Share project" }));
      fireEvent.click(await screen.findByRole("button", { name: "Share whole project" }));
      expect(await screen.findByText(/Preparing the shared project/i)).toBeVisible();
      await vi.advanceTimersByTimeAsync(1_200);
      expect(scopeReads).toBe(2);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await act(async () => { finishRead(shared); });
      await vi.advanceTimersByTimeAsync(2_000);
      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByRole("dialog", { name: "Invite collaborators" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows when publication is taking longer, and checks again on request", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const shared: CollaborationScope = { ...scope, lifecycle: "shared", revision: "5" };
      const api = apiFixture();
      let published = false;
      let scopeReads = 0;
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      api.post.mockImplementation(async (path: string) => {
        if (path.endsWith("/scopes/preflight")) return { eligible: true, resourceRevision: "7", confirmationToken: "p".repeat(64) };
        if (path.endsWith("/scopes")) return scope;
        if (path.endsWith("/policy/preflight")) return undefined;
        return { id: "20000000-0000-4000-8000-000000000401", scopeId: scope.id, status: "prepared", inventoryRevision: "7",
          createdAt: "2026-08-22T12:00:00.000Z", updatedAt: "2026-08-22T12:00:00.000Z" };
      });
      api.get.mockImplementation(async (path: string) => {
        if (path.endsWith("/members")) return { members: [] };
        if (path.endsWith("/project/inventory")) return completeInventory();
        if (path.endsWith("/grants")) return { grants: [] };
        if (path.startsWith("/api/organizations/")) return { members: [] };
        scopeReads += 1;
        if (scopeReads === 1) return scope;
        if (!published) throw new Error("CollaborationUnavailable");
        return shared;
      });
      render(<ProjectSharingButton api={api} runtimeId="vps:runtime" organizationId="org_matrix_team" projectId="proj_launch" projectName="Launch" />);
      fireEvent.click(screen.getByRole("button", { name: "Share project" }));
      fireEvent.click(await screen.findByRole("button", { name: "Share whole project" }));
      await vi.advanceTimersByTimeAsync(61_000);

      expect(await screen.findByText(/Sharing is taking longer than expected/i)).toBeVisible();
      published = true;
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await screen.findByRole("dialog", { name: "Invite collaborators" })).toBeVisible();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("stops waiting for publication once the owner closes the dialog", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const shared: CollaborationScope = { ...scope, lifecycle: "shared", revision: "5" };
      const api = apiFixture();
      let scopeReads = 0;
      api.post.mockImplementation(async (path: string) => {
        if (path.endsWith("/scopes/preflight")) return { eligible: true, resourceRevision: "7", confirmationToken: "p".repeat(64) };
        if (path.endsWith("/scopes")) return scope;
        if (path.endsWith("/policy/preflight")) return undefined;
        return { id: "20000000-0000-4000-8000-000000000401", scopeId: scope.id, status: "prepared", inventoryRevision: "7",
          createdAt: "2026-08-22T12:00:00.000Z", updatedAt: "2026-08-22T12:00:00.000Z" };
      });
      api.get.mockImplementation(async (path: string) => {
        if (path.endsWith("/members")) return { members: [] };
        if (path.endsWith("/project/inventory")) return completeInventory();
        scopeReads += 1;
        return scopeReads === 1 ? scope : shared;
      });
      render(<ProjectSharingButton api={api} runtimeId="vps:runtime" organizationId="org_matrix_team" projectId="proj_launch" projectName="Launch" />);
      fireEvent.click(screen.getByRole("button", { name: "Share project" }));
      fireEvent.click(await screen.findByRole("button", { name: "Share whole project" }));
      expect(await screen.findByText(/Preparing the shared project/i)).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      await vi.advanceTimersByTimeAsync(3_000);
      expect(screen.queryByRole("dialog", { name: "Invite collaborators" })).toBeNull();
      expect(scopeReads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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
