// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CollaborationProjectInventory, CollaborationScope } from "@matrix-os/contracts";
import { ProjectSharingButton } from "../../packages/ui/src/collaboration/ProjectSharingButton";
import { ProjectSharingDialog } from "../../packages/ui/src/collaboration/ProjectSharingDialog";

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

describe("organization-wide project access dialog", () => {
  it("uses the compact dialog and opens without creating a default grant", async () => {
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => path.endsWith("/project/inventory") ? inventory : scope),
      post: vi.fn(async (path: string) => {
        if (path.endsWith("/scopes/preflight")) return { eligible: true, resourceRevision: "3", confirmationToken: "p".repeat(64) };
        if (path.endsWith("/scopes")) return scope;
        throw new Error(`unexpected POST ${path}`);
      }),
      patch: vi.fn(),
      delete: vi.fn(),
    };
    render(<ProjectSharingButton api={api} runtimeId="vps:owner" organizationId="org_acme" organizationName="Acme Research"
      projectId="proj_launch" projectName="Launch plan" />);

    fireEvent.click(screen.getByRole("button", { name: "Share project" }));

    const dialog = await screen.findByRole("dialog", { name: "Share Launch plan" });
    expect(dialog.querySelector('[data-slot="project-share-dialog"]')).toHaveClass("max-w-[480px]");
    expect(screen.getByRole("heading", { name: "Share “Launch plan”" })).toBeVisible();
    expect(screen.getByText(/Every active current and future member of Acme Research/i)).toBeVisible();
    expect(screen.getByText("Active organization members get access automatically.")).toBeVisible();
    expect(api.post).not.toHaveBeenCalledWith(expect.stringContaining("/grants"), expect.anything());
    expect(screen.queryByRole("button", { name: /copy link/i })).toBeNull();
  });

  it("does not load role, people, activation, or per-project AI policy controls", async () => {
    const api = { baseUrl: "https://app.matrix-os.com", get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
    render(<ProjectSharingDialog api={api} scope={scope} projectName="Launch plan" organizationName="Acme Research"
      inventory={inventory} refreshInventory={async () => inventory} onClose={vi.fn()} />);

    expect(screen.queryByText("People with access")).toBeNull();
    expect(screen.queryByRole("button", { name: /General access|Access for/i })).toBeNull();
    expect(screen.queryByLabelText("Share with")).toBeNull();
    expect(screen.queryByText(/activate access|Editor AI|provider terms/i)).toBeNull();
    await waitFor(() => expect(api.post).not.toHaveBeenCalled());
  });

  it("shows the same organization rule after publication and one owner unshare decision", async () => {
    const sharedScope: CollaborationScope = { ...scope, lifecycle: "shared", revision: "2",
      capabilities: { ...scope.capabilities, read: true, requestAi: true } };
    const api = { baseUrl: "https://app.matrix-os.com", get: vi.fn(), post: vi.fn(async () => ({
      scopeId: scope.id, lifecycle: "private", revision: 3,
    })), patch: vi.fn(), delete: vi.fn() };
    const onClose = vi.fn();
    render(<ProjectSharingDialog api={api} scope={sharedScope} projectName="Launch plan" organizationName="Acme Research"
      refreshInventory={async () => inventory} onClose={onClose} />);

    expect(screen.getByText(/Every active current and future member of Acme Research/i)).toBeVisible();
    expect(screen.getByText(/AI work uses the owner's current Provider Settings/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Done" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Unshare project" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      `/api/collaboration/scopes/${scope.id}/project/unshare`,
      expect.objectContaining({ expectedRevision: "2" }),
    ));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", { name: "Editor AI" })).toBeNull();
  });
});
