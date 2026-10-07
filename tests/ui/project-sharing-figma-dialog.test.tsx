// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CollaborationProjectInventory, CollaborationScope } from "@matrix-os/contracts";
import { ProjectAccessManager } from "../../packages/ui/src/collaboration/ProjectAccessManager";
import { ProjectSharingButton } from "../../packages/ui/src/collaboration/ProjectSharingButton";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});

const scope: CollaborationScope = {
  id: "10000000-0000-4000-8000-000000000601",
  ownerId: "user_owner",
  organizationId: "org_acme",
  kind: "project",
  resourceId: "proj_launch",
  membershipMode: "direct",
  lifecycle: "private",
  revision: "1",
  authEpoch: "1",
  authorityGeneration: "1",
  role: "owner",
  capabilities: { read: false, discuss: false, manageMembers: true, requestAi: false,
    observeTerminal: false, controlTerminal: false, stopTerminal: false },
};

const inventory: CollaborationProjectInventory = {
  scopeId: scope.id,
  projectId: "proj_launch",
  projectRevision: "3",
  scopeRevision: "1",
  ownedItems: [{ kind: "chat", id: "Launch Chat", revision: "1", compatibility: "ready" }],
  externalReferences: [],
  blockers: [],
  membershipEffects: [],
  inventoryHash: "a".repeat(64),
  membershipHash: "b".repeat(64),
  inventoryToken: "c".repeat(64),
  expiresAt: "2026-10-07T13:00:00.000Z",
};

describe("Figma-aligned project access dialog", () => {
  it("uses the selected organization's real name and defaults first sharing to Everyone · Editor", async () => {
    let grants: unknown[] = [];
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/members")) return { members: [] };
        if (path.endsWith("/project/inventory")) return inventory;
        if (path.endsWith("/grants")) return grants;
        return scope;
      }),
      post: vi.fn(async (path: string, body: Record<string, unknown>) => {
        if (path.endsWith("/scopes/preflight")) return { eligible: true, resourceRevision: "3", confirmationToken: "p".repeat(64) };
        if (path.endsWith("/scopes")) return scope;
        if (path.endsWith("/grants")) {
          const grant = {
          id: "40000000-0000-4000-8000-000000000601", scopeId: scope.id, organizationId: "org_acme",
          audience: body.audience, preset: body.preset, state: "active", policyVersion: "v1", revision: "1",
          createdAt: "2026-10-07T12:00:00.000Z", updatedAt: "2026-10-07T12:00:00.000Z",
          };
          grants = [...grants, grant];
          return grant;
        }
        if (path.endsWith("/policy/preflight")) return undefined;
        throw new Error(`unexpected POST ${path}`);
      }),
      patch: vi.fn(),
      delete: vi.fn(),
    };
    render(<ProjectSharingButton api={api} runtimeId="vps:owner" organizationId="org_acme" organizationName="Acme Research"
      projectId="proj_launch" projectName="Launch plan" />);

    fireEvent.click(screen.getByRole("button", { name: "Share project" }));

    expect(await screen.findByRole("dialog", { name: "Share Launch plan" })).toBeVisible();
    expect(await screen.findByText("Everyone in Acme Research")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "General access" })).toHaveValue("contributor");
    expect(screen.getByText(/all current and future project contents share together/i)).toBeVisible();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      `/api/collaboration/scopes/${scope.id}/grants`,
      expect.objectContaining({ audience: { kind: "organization" }, preset: "contributor" }),
    ));
  });

  it("preserves a selected audience when reopening an unpublished project", async () => {
    const directGrant = {
      id: "40000000-0000-4000-8000-000000000600", scopeId: scope.id, organizationId: "org_acme",
      audience: { kind: "member", actorId: "user_ada" }, preset: "viewer", state: "pending",
      policyVersion: "v1", revision: "1", createdAt: "2026-10-07T12:00:00.000Z",
      updatedAt: "2026-10-07T12:00:00.000Z",
    };
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/members")) return { members: [{
          actorId: "user_ada", displayName: "Ada", role: "org:member", joinedAt: "2026-01-01T00:00:00.000Z",
        }] };
        if (path.endsWith("/project/inventory")) return inventory;
        if (path.endsWith("/grants")) return [directGrant];
        return scope;
      }),
      post: vi.fn(async (path: string) => {
        if (path.endsWith("/scopes/preflight")) return {
          eligible: true, resourceRevision: "3", confirmationToken: "p".repeat(64),
          existingScopeId: scope.id, existingLifecycle: "private",
        };
        if (path.endsWith("/policy/preflight")) return undefined;
        throw new Error(`unexpected POST ${path}`);
      }),
      patch: vi.fn(),
      delete: vi.fn(),
    };
    render(<ProjectSharingButton api={api} runtimeId="vps:owner" organizationId="org_acme" organizationName="Acme Research"
      projectId="proj_launch" projectName="Launch plan" />);

    fireEvent.click(screen.getByRole("button", { name: "Share project" }));

    expect(await screen.findByRole("dialog", { name: "Share Launch plan" })).toBeVisible();
    expect(await screen.findByText("Ada")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "General access" })).toHaveValue("restricted");
    expect(api.post).not.toHaveBeenCalledWith(
      `/api/collaboration/scopes/${scope.id}/grants`,
      expect.objectContaining({ audience: { kind: "organization" } }),
    );
  });

  it("changes a direct member between Viewer and Editor with revision checks", async () => {
    const sharedScope = { ...scope, lifecycle: "shared" as const, revision: "7" };
    let directPreset = "viewer" as const | "contributor";
    let directRevision = "2";
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => {
        if (path === "/api/organizations") {
          return { complete: true, organizations: [{
            organizationId: "org_acme", name: "Acme Research", slug: "acme-research", role: "org:member",
            memberCount: 2, aiSubmission: "members", membershipEpoch: 1,
          }] };
        }
        if (path.endsWith("/members")) {
          return { members: [
            { actorId: "user_owner", displayName: "Owner", role: "org:member", joinedAt: "2026-01-01T00:00:00.000Z" },
            { actorId: "user_editor", displayName: "Ada", role: "org:member", joinedAt: "2026-01-01T00:00:00.000Z" },
          ] };
        }
        if (path.endsWith("/project/access")) {
          return {
            scopeId: scope.id,
            revision: "7",
            owner: { actorId: "user_owner", displayName: "Owner" },
            generalAccess: { grantId: "40000000-0000-4000-8000-000000000610", preset: "viewer", revision: "3" },
            people: [{
              actor: { actorId: "user_editor", displayName: "Ada" }, status: "active",
              effectivePreset: directPreset, inherited: false,
              directGrant: { grantId: "40000000-0000-4000-8000-000000000611", preset: directPreset, revision: directRevision },
            }],
          };
        }
        throw new Error(`unexpected GET ${path}`);
      }),
      post: vi.fn(),
      patch: vi.fn(async (_path: string, body: Record<string, unknown>) => {
        directPreset = body.preset as "viewer" | "contributor";
        directRevision = "3";
        return {};
      }),
      delete: vi.fn(),
    };

    render(<ProjectAccessManager api={api} scope={sharedScope} />);

    expect(await screen.findByText("Everyone in Acme Research")).toBeVisible();
    const role = await screen.findByRole("combobox", { name: "Access for Ada" });
    expect(role).toHaveValue("viewer");
    fireEvent.change(role, { target: { value: "contributor" } });

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(
      `/api/collaboration/scopes/${scope.id}/grants/40000000-0000-4000-8000-000000000611`,
      expect.objectContaining({ expectedRevision: "7", expectedGrantRevision: "2", preset: "contributor" }),
    ));
    await waitFor(() => expect(role).toHaveValue("contributor"));
  });

  it("lets an inherited Viewer receive a direct Editor grant", async () => {
    const sharedScope = { ...scope, lifecycle: "shared" as const, revision: "7" };
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/members")) return { members: [
          { actorId: "user_owner", displayName: "Owner", role: "org:member", joinedAt: "2026-01-01T00:00:00.000Z" },
          { actorId: "user_viewer", displayName: "Ada", role: "org:member", joinedAt: "2026-01-01T00:00:00.000Z" },
        ] };
        if (path.endsWith("/project/access")) return {
          scopeId: scope.id,
          revision: "7",
          owner: { actorId: "user_owner", displayName: "Owner" },
          generalAccess: { grantId: "40000000-0000-4000-8000-000000000620", preset: "viewer", revision: "3" },
          people: [{ actor: { actorId: "user_viewer", displayName: "Ada" }, status: "active",
            effectivePreset: "viewer", inherited: true }],
        };
        throw new Error(`unexpected GET ${path}`);
      }),
      post: vi.fn(async () => ({})),
      patch: vi.fn(),
      delete: vi.fn(),
    };

    render(<ProjectAccessManager api={api} scope={sharedScope} organizationName="Acme Research" />);

    expect(await screen.findByRole("combobox", { name: "Add person" })).toHaveValue("user_viewer");
    fireEvent.change(screen.getByRole("combobox", { name: "Role" }), { target: { value: "contributor" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      `/api/collaboration/scopes/${scope.id}/grants`,
      expect.objectContaining({ audience: { kind: "member", actorId: "user_viewer" }, preset: "contributor" }),
    ));
  });

  it("retries a transient access load failure in place", async () => {
    let memberAttempts = 0;
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/members")) {
          memberAttempts += 1;
          if (memberAttempts === 1) throw new Error("temporary");
          return { members: [] };
        }
        if (path.endsWith("/grants")) return [];
        return scope;
      }),
      post: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    };

    render(<ProjectAccessManager api={api} scope={scope} organizationName="Acme Research" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Access is unavailable/);
    fireEvent.click(screen.getByRole("button", { name: "Refresh access" }));
    expect(await screen.findByText("Everyone in Acme Research")).toBeVisible();
    expect(memberAttempts).toBe(2);
  });
});
