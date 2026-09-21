// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CollaborationReadiness, CollaborationScope } from "@matrix-os/contracts";
import { ReadinessSummary } from "../../packages/ui/src/collaboration/ReadinessSummary";
import { AudienceGrantPicker } from "../../packages/ui/src/collaboration/AudienceGrantPicker";
import { ChatCollaboratorsDialog } from "../../packages/ui/src/collaboration/ChatCollaboratorsDialog";

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

describe("organization ready-to-work presentation", () => {
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

  it("shows no AI or Git readiness for files, folders or apps", () => {
    for (const resourceKind of ["file", "folder", "app_instance"] as const) {
      const { unmount } = render(<ReadinessSummary readiness={{ resourceKind, state: "ready", missingOwnerSetup: [], items: [] }} />);
      expect(screen.queryByText(/AI source/)).toBeNull();
      expect(screen.queryByText(/Git identity/)).toBeNull();
      unmount();
    }
  });

  it("creates only Viewer or Contributor grants for a current organization member or the organization", async () => {
    const api = {
      baseUrl: "http://localhost", get: vi.fn(async (path: string) => path.endsWith("/members")
        ? { members: [{ actorId: "user_ada", role: "member", joinedAt: "2026-01-01T00:00:00.000Z" }] }
        : []), post: vi.fn(async () => ({ id: "20000000-0000-4000-8000-000000000401" })), delete: vi.fn(async () => null),
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

  it("places the organization member picker in the existing owner manager", async () => {
    const api = { baseUrl: "http://localhost", get: vi.fn(async () => ({ members: [] })), post: vi.fn(), delete: vi.fn() };
    render(<ChatCollaboratorsDialog api={api} scope={scope} members={[]} onRefresh={async () => ({ scope, members: [] })} onClose={vi.fn()} />);
    expect(await screen.findByLabelText("Share with")).toBeVisible();
    expect(screen.queryByLabelText("Member email or username")).toBeNull();
  });
});
