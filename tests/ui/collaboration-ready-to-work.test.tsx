// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CollaborationReadiness, CollaborationScope } from "@matrix-os/contracts";
import { ReadinessSummary } from "../../packages/ui/src/collaboration/ReadinessSummary";
import { AudienceGrantPicker } from "../../packages/ui/src/collaboration/AudienceGrantPicker";
import { ResourceSharingButton } from "../../packages/ui/src/collaboration/ResourceSharingButton";
import { ChatCollaboratorsDialog } from "../../packages/ui/src/collaboration/ChatCollaboratorsDialog";
import { ChatCollaboration } from "../../packages/ui/src/collaboration/ChatCollaboration";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});

const scope: CollaborationScope = {
  id: "10000000-0000-4000-8000-000000000401", ownerId: "user_owner", organizationId: "org_matrix_team",
  kind: "project", resourceId: "proj_launch", membershipMode: "direct", lifecycle: "shared",
  revision: "4", authEpoch: "3", authorityGeneration: "1", role: "owner",
  capabilities: { read: true, discuss: true, manageMembers: true, requestAi: true, observeTerminal: false, controlTerminal: false, stopTerminal: false },
};
const projectReady: CollaborationReadiness = {
  resourceKind: "project", state: "ready", missingOwnerSetup: [], sourceKind: "owner_account", effectiveSubmitMode: "owner_only",
  items: [
    { item: "ai_source", status: "ready" }, { item: "submit_mode", status: "ready" },
    { item: "git_identity", status: "ready", identityLabel: "Owner <owner@example.test>" },
    { item: "chat_root_inventory", status: "ready", chatRootCount: 3, dirtyRootCount: 1 },
  ],
};
const pendingGrantId = "20000000-0000-4000-8000-000000000402";
const pendingOrganizationShare = {
  scopeId: scope.id, runtimeId: "vps:owner", ownerId: scope.ownerId, kind: "project" as const,
  authorityGeneration: 1, status: "organization_pending" as const,
  organizationId: scope.organizationId, grantId: pendingGrantId,
};

describe("organization ready-to-work presentation", () => {
  it("activates a pending organization share only on Open and waits for refreshed discovery before navigating", async () => {
    let resolveAccept!: (value: unknown) => void;
    let resolveRefresh!: () => void;
    const accepted = new Promise<unknown>((resolve) => { resolveAccept = resolve; });
    const refreshed = new Promise<void>((resolve) => { resolveRefresh = resolve; });
    let reads = 0;
    const api = { baseUrl: "http://localhost",
      get: vi.fn((path: string) => {
        reads += 1;
        if (reads > 2) return refreshed.then(() => ({ items: [] }));
        return Promise.resolve(path.endsWith("/inbox") ? { items: [pendingOrganizationShare] } : { items: [] });
      }),
      post: vi.fn(async () => accepted), delete: vi.fn(),
    };
    const openProject = vi.fn();
    render(<ChatCollaboration view={{ kind: "home" }} api={api} actorId="user_member" openProject={openProject} />);
    const open = await screen.findByRole("button", { name: "Open" });
    expect(api.post).not.toHaveBeenCalled();
    expect(openProject).not.toHaveBeenCalled();

    fireEvent.click(open);
    expect(api.post).toHaveBeenCalledWith(`/api/collaboration/scopes/${scope.id}/grants/${pendingGrantId}/accept`, {});
    expect(openProject).not.toHaveBeenCalled();
    await act(async () => { resolveAccept({ state: "active" }); });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(4));
    expect(openProject).not.toHaveBeenCalled();
    await act(async () => { resolveRefresh(); });
    await waitFor(() => expect(openProject).toHaveBeenCalledWith(scope.id));
  });

  it("keeps a pending organization share in place when activation fails", async () => {
    const api = { baseUrl: "http://localhost",
      get: vi.fn(async (path: string) => path.endsWith("/inbox")
        ? { items: [pendingOrganizationShare] } : { items: [] }),
      post: vi.fn(async () => { throw new Error("private membership detail"); }), delete: vi.fn(),
    };
    const openProject = vi.fn();
    render(<ChatCollaboration view={{ kind: "home" }} api={api} actorId="user_member" openProject={openProject} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Share could not be opened. Try again.");
    expect(screen.getByText("Shared with your organization")).toBeVisible();
    expect(screen.queryByText("private membership detail")).toBeNull();
    expect(openProject).not.toHaveBeenCalled();
  });

  it("shows server-derived owner source, submit mode, Git identity and Chat roots for a project", () => {
    render(<ReadinessSummary readiness={projectReady} />);
    expect(screen.getByText(/Owner account/)).toBeVisible();
    expect(screen.getByText(/Owner approves AI requests/)).toBeVisible();
    expect(screen.getByText(/Owner <owner@example.test>/)).toBeVisible();
    expect(screen.getByText(/3 Chat roots/)).toBeVisible();
    expect(screen.getByText(/1 with uncommitted changes/)).toBeVisible();
  });

  it("shows a Chat's source and missing owner setup without inventing provider detail", () => {
    render(<ReadinessSummary readiness={{ ...projectReady, resourceKind: "chat", state: "owner_setup_needed",
      sourceKind: undefined, missingOwnerSetup: ["ai_source"], items: projectReady.items.map((item) => item.item === "ai_source" ? { ...item, status: "missing" } : item) }} />);
    expect(screen.getByText(/Owner AI source needs setup/)).toBeVisible();
    expect(screen.queryByText(/Owner account/)).toBeNull();
  });


  it("does not imply an AI source or submit permission when the owner host is offline", () => {
    render(<ReadinessSummary readiness={{ ...projectReady, state: "host_offline", sourceKind: undefined,
      effectiveSubmitMode: undefined, items: projectReady.items.map((item) => ({ ...item, status: "unavailable" })) }} />);
    expect(screen.getByText(/owner computer is offline/i)).toBeVisible();
    expect(screen.queryByText(/Owner approves AI requests/)).toBeNull();
    expect(screen.queryByText(/Owner account/)).toBeNull();
  });

  it("shows canonical owner readiness inside the existing manager", async () => {
    const api = { baseUrl: "http://localhost", get: vi.fn(async (path: string) => path.startsWith("/api/organizations/")
      ? { members: [] } : path.endsWith("/grants") ? [] : scope),
      post: vi.fn(async () => projectReady), delete: vi.fn() };
    render(<ChatCollaboratorsDialog api={api} scope={scope} members={[]} onRefresh={async () => ({ scope, members: [] })} onClose={vi.fn()} />);
    expect(await screen.findByText(/Owner account/)).toBeVisible();
    expect(api.post).toHaveBeenCalledWith(`/api/collaboration/scopes/${scope.id}/policy/preflight`, {});
  });

  it("does not show Git details for an unrooted standalone Chat", () => {
    render(<ReadinessSummary readiness={{ ...projectReady, resourceKind: "chat", items: projectReady.items.map((item) => item.item === "chat_root_inventory"
      ? { ...item, chatRootCount: 0, dirtyRootCount: 0 } : item) }} />);
    expect(screen.getByText(/Owner account/)).toBeVisible();
    expect(screen.queryByText(/Git identity:/)).toBeNull();
    expect(screen.queryByText(/Chat roots/)).toBeNull();
  });

  it("shows no AI or Git readiness for files, folders or apps", () => {
    for (const resourceKind of ["file", "folder", "app_instance"] as const) {
      const { unmount } = render(<ReadinessSummary readiness={{ resourceKind, state: "ready", missingOwnerSetup: [], items: [] }} />);
      expect(screen.queryByText(/AI source/)).toBeNull();
      expect(screen.queryByText(/Git identity/)).toBeNull();
      unmount();
    }
  });

  it("creates only Viewer or Contributor grants for a current organization member or the organization", async () => {
    let revision = "4";
    const api = {
      baseUrl: "http://localhost", get: vi.fn(async (path: string) => path.endsWith("/members")
        ? { members: [{ actorId: "user_ada", role: "member", joinedAt: "2026-01-01T00:00:00.000Z" }] }
        : path.endsWith("/grants") ? [] : { ...scope, revision }),
      post: vi.fn(async (_path: string, body: { audience: unknown; preset: string }) => {
        revision = "5";
        return { id: "20000000-0000-4000-8000-000000000401", scopeId: scope.id,
          organizationId: scope.organizationId, audience: body.audience, preset: body.preset, state: "pending",
          policyVersion: "v1", revision: "1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
      }), delete: vi.fn(async () => null),
    };
    render(<AudienceGrantPicker api={api} scope={scope} />);
    expect(await screen.findByRole("option", { name: /user_ada/ })).toBeVisible();
    expect(screen.queryByPlaceholderText(/email|username/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("Share with"), { target: { value: "user_ada" } });
    fireEvent.change(screen.getByLabelText("Access preset"), { target: { value: "viewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/api/collaboration/scopes/${scope.id}/grants`, expect.objectContaining({
      audience: { kind: "member", actorId: "user_ada" }, preset: "viewer", expectedRevision: "4",
    })));
    fireEvent.change(screen.getByLabelText("Share with"), { target: { value: "organization" } });
    fireEvent.change(screen.getByLabelText("Access preset"), { target: { value: "contributor" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith(`/api/collaboration/scopes/${scope.id}/grants`, expect.objectContaining({
      audience: { kind: "organization" }, preset: "contributor",
    })));
  });

  it("changes and revokes grants with scope and grant revisions", async () => {
    const grant = { id: "20000000-0000-4000-8000-000000000401", scopeId: scope.id,
      organizationId: scope.organizationId!, audience: { kind: "member" as const, actorId: "user_ada" },
      preset: "viewer" as const, state: "active" as const, policyVersion: "v1", revision: "2",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    let currentScope = scope;
    let currentGrants = [grant];
    const api = { baseUrl: "http://localhost",
      get: vi.fn(async (path: string) => path.startsWith("/api/organizations/")
        ? { members: [{ actorId: "user_ada", role: "member", joinedAt: "2026-01-01T00:00:00.000Z" }] }
        : path.endsWith("/grants") ? currentGrants : currentScope),
      post: vi.fn(),
      patch: vi.fn(async () => {
        currentScope = { ...scope, revision: "5" };
        currentGrants = [{ ...grant, preset: "contributor", revision: "3" }];
        return currentGrants[0];
      }),
      delete: vi.fn(async () => {
        currentScope = { ...scope, revision: "6" };
        currentGrants = [];
      }),
    };
    render(<AudienceGrantPicker api={api} scope={scope} />);
    fireEvent.change(await screen.findByLabelText("Preset for user_ada"), { target: { value: "contributor" } });
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(`/api/collaboration/scopes/${scope.id}/grants/${grant.id}`,
      expect.objectContaining({ expectedRevision: "4", expectedGrantRevision: "2", preset: "contributor" })));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`/api/collaboration/scopes/${scope.id}/grants/${grant.id}`,
      expect.objectContaining({ expectedRevision: "5", expectedMemberRevision: "3" })));
  });

  it("resolves an exact file identity before creating a standalone scope", async () => {
    const api = { baseUrl: "http://localhost", get: vi.fn(async (path: string) => path.endsWith("/members") ? { members: [] }
      : path.endsWith("/grants") ? [] : { ...scope, kind: "file", resourceId: "30000000-0000-4000-8000-000000000401" }),
      post: vi.fn(async (path: string) => path.endsWith("/catalog/resolve")
        ? { id: "30000000-0000-4000-8000-000000000401", kind: "file", path: "notes/plan.md", incarnation: "file_v1", revision: "1" }
        : path.endsWith("/scopes/preflight") ? { eligible: true, resourceRevision: "1", confirmationToken: "a".repeat(64) }
        : path.endsWith("/scopes") ? { ...scope, kind: "file", resourceId: "30000000-0000-4000-8000-000000000401" }
        : undefined), delete: vi.fn() };
    render(<ResourceSharingButton api={api} runtimeId="vps:owner" organizationId="org_matrix_team" kind="file" path="notes/plan.md" projectId="proj_launch" />);
    fireEvent.click(screen.getByRole("button", { name: "Share file" }));
    expect(await screen.findByRole("dialog", { name: "Invite collaborators" })).toBeVisible();
    expect(api.post).toHaveBeenCalledWith("/api/collaboration/runtimes/vps%3Aowner/catalog/resolve", {
      kind: "file", path: "notes/plan.md", organizationId: "org_matrix_team",
    });
    expect(api.post).toHaveBeenCalledWith("/api/collaboration/runtimes/vps%3Aowner/scopes/preflight", {
      kind: "file", resourceId: "30000000-0000-4000-8000-000000000401", organizationId: "org_matrix_team",
    });
    expect(api.post).toHaveBeenCalledWith("/api/collaboration/runtimes/vps%3Aowner/scopes", expect.objectContaining({
      kind: "file", resourceId: "30000000-0000-4000-8000-000000000401", organizationId: "org_matrix_team",
      expectedRevision: "1", confirmationToken: "a".repeat(64),
    }));
  });

  it("fails closed when catalog resolves a different folder path", async () => {
    const api = { baseUrl: "http://localhost", get: vi.fn(), post: vi.fn(async () => ({
      id: "30000000-0000-4000-8000-000000000401", kind: "folder", path: "notes", incarnation: "folder_v1", revision: "1",
    })), delete: vi.fn() };
    render(<ResourceSharingButton api={api} runtimeId="vps:owner" organizationId="org_matrix_team" kind="folder" path="notes/private" />);
    fireEvent.click(screen.getByRole("button", { name: "Share folder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Sharing unavailable/);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("places the organization member picker in the existing owner manager", async () => {
    const api = { baseUrl: "http://localhost", get: vi.fn(async (path: string) => path.endsWith("/members") ? { members: [] }
      : path.endsWith("/grants") ? [] : scope), post: vi.fn(async () => undefined), delete: vi.fn() };
    render(<ChatCollaboratorsDialog api={api} scope={scope} members={[]} onRefresh={async () => ({ scope, members: [] })} onClose={vi.fn()} />);
    expect(await screen.findByLabelText("Share with")).toBeVisible();
    expect(screen.queryByLabelText("Member email or username")).toBeNull();
  });
});
