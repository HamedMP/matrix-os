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

describe("project sharing organization selection", () => {
  it("explains an existing organization binding before reading a scope or changing access", async () => {
    const api = { get: vi.fn(), post: vi.fn(async () => ({ eligible: false, reason: "organization_mismatch", resourceRevision: "7" })),
      delete: vi.fn() };
    const rendered = render(<ProjectSharingButton api={api} runtimeId="vps:runtime" organizationId="org_selected"
      projectId="proj_launch" projectName="Launch" />);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Share project" }));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(
        "This project is associated with another organization. Select that organization to manage sharing. Access has not changed.",
      ));
      expect(api.get).not.toHaveBeenCalled();
      expect(api.post).toHaveBeenCalledOnce();
      expect(api.delete).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally { rendered.unmount(); }
  });
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
    api.post.mockImplementation(async (path: string) => {
      if (path.endsWith("/scopes/preflight")) return { eligible: true, resourceRevision: "7", confirmationToken: "p".repeat(64) };
      if (path.endsWith("/scopes")) return scope;
      if (path.endsWith("/grants")) return defaultOrganizationGrant();
      throw new Error(`unexpected POST ${path}`);
    });
    api.get.mockImplementation(async (path: string) => path.endsWith("/project/inventory") ? completeInventory()
      : path.endsWith("/grants") ? [] : scope);
    render(<ProjectSharingButton api={api} runtimeId="vps:runtime" organizationId="org_matrix_team" projectId="proj_launch" projectName="Launch" />);

    fireEvent.click(screen.getByRole("button", { name: "Share project" }));
    expect(await screen.findByRole("heading", { name: "Share “Launch”" })).toBeVisible();
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
    expect(screen.getByRole("heading", { name: "Share “Launch”" })).toBeVisible();
    expect(screen.getByText(/All current and future project contents share together/i)).toBeVisible();
    expect(screen.getByText(/every project Chat and its history/i)).toBeVisible();
    expect(screen.getByText("README.md")).toBeVisible();
    expect(screen.getAllByText("Launch discussion").length).toBeGreaterThan(0);
    expect(screen.getByText("Roadmap app")).toBeVisible();
    expect(screen.getByText("Shared canvas")).toBeVisible();
    expect(screen.getByText("Release terminal")).toBeVisible();
    expect(screen.getByText("Personal notes")).toBeVisible();
    expect(screen.getByText(/stays outside this project share/i)).toBeVisible();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("offers one organization-wide confirmation without role, people, activation, or AI policy controls", () => {
    const privateScope: CollaborationScope = { ...scope, organizationId: "org_matrix_team" };
    render(<ProjectSharingDialog api={apiFixture()} scope={privateScope} projectName="Launch"
      organizationName="Matrix Team" inventory={completeInventory()}
      refreshInventory={async () => completeInventory()} onClose={vi.fn()} />);

    expect(screen.getByText(/Every active current and future member of Matrix Team can work in this project immediately/i)).toBeVisible();
    expect(screen.getByText(/AI work uses the owner's current Provider Settings and is billed to the owner/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Share whole project" })).toBeEnabled();
    expect(screen.queryByLabelText("Share with")).toBeNull();
    expect(screen.queryByRole("button", { name: /General access/i })).toBeNull();
    expect(screen.queryByText(/activate access/i)).toBeNull();
    expect(screen.queryByText(/choose a model|provider terms|acknowledge/i)).toBeNull();
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

  it("does not present legacy role and per-person membership effects", () => {
    renderDialog({ inventory: completeInventory() });
    expect(screen.queryByText(/Ada joins the whole project as editor/i)).toBeNull();
    expect(screen.queryByText(/Membership changes|Editor|Viewer/i)).toBeNull();
  });

  it("does not let the owner configure a private project's audience before sharing", () => {
    const privateScope: CollaborationScope = { ...scope, organizationId: "org_matrix_team" };
    const api = apiFixture();
    render(<ChatCollaboratorsDialog api={api} scope={privateScope} members={[]}
      onRefresh={async () => ({ scope: privateScope, members: [] })} onClose={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Project access" })).toBeVisible();
    expect(screen.queryByLabelText(/Share with|Access preset/i)).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("keeps the same role-free rule while a confirmed share is being published", () => {
    const api = apiFixture();
    const preparing: CollaborationScope = { ...scope, organizationId: "org_matrix_team", lifecycle: "preparing" };
    render(<ChatCollaboratorsDialog api={api} scope={preparing} members={[]}
      onRefresh={async () => ({ scope: preparing, members: [] })} onClose={vi.fn()} />);

    expect(screen.getByText(/every active organization member can work in this whole project/i)).toBeVisible();
    expect(screen.queryByText(/Editor|Viewer|People with access/i)).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("keeps legacy collaborator controls out of the organization-wide project flow", () => {
    const api = apiFixture();
    render(<ChatCollaboratorsDialog api={api} scope={scope} members={[]}
      onRefresh={async () => ({ scope, members: [] })} onClose={vi.fn()} />);

    expect(screen.getByText(/every active organization member can work in this whole project/i)).toBeVisible();
    expect(screen.getByText(/External references and unrelated resources stay outside the share/i)).toBeVisible();
    expect(screen.queryByLabelText(/Share with|Access preset|Owner AI source|Allowed model/i)).toBeNull();
    expect(screen.queryByText(/People with access|Editor|Viewer|acknowledg/i)).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
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

  it("confirms the reviewed inventory without a grant or access-policy mutation", async () => {
    const privateScope: CollaborationScope = { ...scope, organizationId: "org_matrix_team" };
    const first = completeInventory();
    const api = apiFixture();
    api.post.mockImplementation(async (path: string) => {
      if (path.endsWith("/project/confirm")) return {
        id: "20000000-0000-4000-8000-000000000401", scopeId: scope.id, status: "prepared", inventoryRevision: "7",
        createdAt: "2026-08-22T12:00:00.000Z", updatedAt: "2026-08-22T12:00:00.000Z",
      };
      throw new Error("unexpected route");
    });
    render(<ProjectSharingDialog api={api} scope={privateScope} projectName="Launch"
      organizationName="Matrix Team" inventory={first}
      refreshInventory={async () => first} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Share whole project" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      `/api/collaboration/scopes/${scope.id}/project/confirm`,
      expect.objectContaining({ expectedScopeRevision: "4", inventoryToken: "c".repeat(64) }),
    ));
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
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
        if (path.endsWith("/grants")) return defaultOrganizationGrant();
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
        if (path.endsWith("/grants")) return [];
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
      expect(screen.queryByRole("dialog", { name: "Manage access" })).toBeNull();
      published = true;
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await screen.findByRole("heading", { name: "Share “Launch”" })).toBeVisible();
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
        if (path.endsWith("/grants")) return defaultOrganizationGrant();
        if (path.endsWith("/policy/preflight")) return undefined;
        return { id: "20000000-0000-4000-8000-000000000401", scopeId: scope.id, status: "prepared", inventoryRevision: "7",
          createdAt: "2026-08-22T12:00:00.000Z", updatedAt: "2026-08-22T12:00:00.000Z" };
      });
      api.get.mockImplementation(async (path: string) => {
        if (path.endsWith("/members")) return { members: [] };
        if (path.endsWith("/project/inventory")) return completeInventory();
        if (path.endsWith("/grants")) return [];
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
      fireEvent.click(screen.getByRole("button", { name: "Close share dialog" }));
      await act(async () => { finishRead(shared); });
      await vi.advanceTimersByTimeAsync(2_000);
      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByRole("dialog", { name: "Share Launch" })).toBeNull();
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
        if (path.endsWith("/grants")) return defaultOrganizationGrant();
        if (path.endsWith("/policy/preflight")) return undefined;
        return { id: "20000000-0000-4000-8000-000000000401", scopeId: scope.id, status: "prepared", inventoryRevision: "7",
          createdAt: "2026-08-22T12:00:00.000Z", updatedAt: "2026-08-22T12:00:00.000Z" };
      });
      api.get.mockImplementation(async (path: string) => {
        if (path.endsWith("/members")) return { members: [] };
        if (path.endsWith("/project/inventory")) return completeInventory();
        if (path.endsWith("/grants")) return [];
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
      expect(await screen.findByRole("heading", { name: "Share “Launch”" })).toBeVisible();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("refreshes a cancelled publication and lets the owner confirm the updated inventory again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const updatedInventory = {
        ...completeInventory(),
        scopeRevision: "8",
        projectRevision: "9",
        inventoryHash: "e".repeat(64),
        membershipHash: "f".repeat(64),
        inventoryToken: "a".repeat(64),
        ownedItems: [
          ...completeInventory().ownedItems,
          { kind: "file" as const, id: "release-notes.md", revision: "6", compatibility: "ready" as const },
        ],
      };
      const api = apiFixture();
      let scopeReads = 0;
      let inventoryReads = 0;
      api.post.mockImplementation(async (path: string) => {
        if (path.endsWith("/scopes/preflight")) return { eligible: true, resourceRevision: "7", confirmationToken: "p".repeat(64) };
        if (path.endsWith("/scopes")) return scope;
        if (path.endsWith("/grants")) return defaultOrganizationGrant();
        if (path.endsWith("/policy/preflight")) return undefined;
        if (path.endsWith("/project/confirm")) return {
          id: "20000000-0000-4000-8000-000000000401", scopeId: scope.id, status: "prepared", inventoryRevision: "7",
          createdAt: "2026-08-22T12:00:00.000Z", updatedAt: "2026-08-22T12:00:00.000Z",
        };
        throw new Error(`unexpected POST ${path}`);
      });
      api.get.mockImplementation(async (path: string) => {
        if (path.endsWith("/members")) return { members: [] };
        if (path.endsWith("/project/inventory")) return inventoryReads++ === 0 ? completeInventory() : updatedInventory;
        if (path.endsWith("/grants")) return [];
        if (path.startsWith("/api/organizations/")) return { members: [] };
        scopeReads += 1;
        return scope;
      });

      render(<ProjectSharingButton api={api} runtimeId="vps:runtime" organizationId="org_matrix_team"
        projectId="proj_launch" projectName="Launch" />);
      fireEvent.click(screen.getByRole("button", { name: "Share project" }));
      fireEvent.click(await screen.findByRole("button", { name: "Share whole project" }));
      expect(await screen.findByText(/Preparing the shared project/i)).toBeVisible();

      await vi.advanceTimersByTimeAsync(1_500);

      expect(await screen.findByText(/Project contents changed.*confirm again/i)).toBeVisible();
      expect(screen.getByText("release-notes.md")).toBeVisible();
      const retry = screen.getByRole("button", { name: "Share whole project" });
      expect(retry).toBeEnabled();
      fireEvent.click(retry);

      await waitFor(() => expect(api.post).toHaveBeenLastCalledWith(
        `/api/collaboration/scopes/${scope.id}/project/confirm`,
        expect.objectContaining({ expectedScopeRevision: "8", expectedProjectRevision: "9", inventoryToken: "a".repeat(64) }),
      ));
      expect(scopeReads).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
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
        if (path.endsWith("/grants")) return defaultOrganizationGrant();
        if (path.endsWith("/policy/preflight")) return undefined;
        return { id: "20000000-0000-4000-8000-000000000401", scopeId: scope.id, status: "prepared", inventoryRevision: "7",
          createdAt: "2026-08-22T12:00:00.000Z", updatedAt: "2026-08-22T12:00:00.000Z" };
      });
      api.get.mockImplementation(async (path: string) => {
        if (path.endsWith("/members")) return { members: [] };
        if (path.endsWith("/project/inventory")) return completeInventory();
        if (path.endsWith("/grants")) return [];
        scopeReads += 1;
        return scopeReads === 1 ? scope : shared;
      });
      render(<ProjectSharingButton api={api} runtimeId="vps:runtime" organizationId="org_matrix_team" projectId="proj_launch" projectName="Launch" />);
      fireEvent.click(screen.getByRole("button", { name: "Share project" }));
      fireEvent.click(await screen.findByRole("button", { name: "Share whole project" }));
      expect(await screen.findByText(/Preparing the shared project/i)).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Close share dialog" }));

      await vi.advanceTimersByTimeAsync(3_000);
      expect(screen.queryByRole("dialog", { name: "Share Launch" })).toBeNull();
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

function defaultOrganizationGrant() {
  return {
    id: "60000000-0000-4000-8000-000000000499", scopeId: scope.id,
    organizationId: "org_matrix_team", audience: { kind: "organization" as const },
    preset: "contributor" as const, state: "active" as const, policyVersion: "v1", revision: "1",
    createdAt: "2026-08-22T12:00:00.000Z", updatedAt: "2026-08-22T12:00:00.000Z",
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
