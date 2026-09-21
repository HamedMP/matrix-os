// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { SessionAccessControl } from "../../packages/ui/src/collaboration/SessionAccessControl";

HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });

const scope = {
  id: "10000000-0000-4000-8000-000000000001",
  ownerId: "user_owner",
  organizationId: "org_matrix_team",
  kind: "chat" as const,
  resourceId: "chat_shared",
  membershipMode: "direct" as const,
  lifecycle: "shared" as const,
  revision: "2",
  authEpoch: "2",
  authorityGeneration: "1",
  role: "owner" as const,
  capabilities: { read: true, discuss: true, manageMembers: true, requestAi: true,
    observeTerminal: false, controlTerminal: false, stopTerminal: false },
};
const members = [{
  actor: { actorId: "user_owner", displayName: "Nima" },
  role: "owner" as const,
  status: "accepted" as const,
  revision: "1",
  joinedAt: "2026-09-17T12:00:00.000Z",
  updatedAt: "2026-09-17T12:00:00.000Z",
}];

function api() {
  return {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => path.endsWith("/members") ? { members } : scope),
    post: vi.fn(),
    delete: vi.fn(),
  };
}

describe("SessionAccessControl", () => {
  it("uses a compact summary and discloses owner management at the second level", async () => {
    render(<SessionAccessControl api={api()} scope={scope} zIndex={11_000} />);
    fireEvent.click(screen.getByRole("button", { name: "Collaboration access" }));
    const summary = await screen.findByRole("dialog", { name: "Collaboration access summary" });
    expect(summary).toBeVisible();
    expect(summary).toHaveClass("w-80", "max-w-[calc(100vw-2rem)]", "bg-background");
    expect(summary).toHaveStyle({ zIndex: "11000" });
    expect(summary).not.toHaveClass("z-40");
    expect(await screen.findByText("Nima")).toBeVisible();
    expect(screen.getByRole("button", { name: "Manage access" })).toBeVisible();
  });

  it("shows project Chat root and owner Git readiness inside the access popover", async () => {
    const projectScope = { ...scope, kind: "project" as const, resourceId: "proj_shared" };
    const collaborationApi = api();
    collaborationApi.get.mockImplementation(async (path: string) => {
      if (path.endsWith("/members")) return { members };
      if (path.endsWith("/readiness")) return {
        scopeId: projectScope.id,
        chatRoots: [{ chatId: "chat_one", executionRoot: { kind: "worktree", projectId: "proj_shared", worktreeId: "wt_one" }, branch: "feature/chat", dirty: true, readiness: "ready" }],
        gitSetup: { identity: { status: "ready", label: "Owner <owner@example.test>" }, forgeCredential: { status: "missing" } },
      };
      return projectScope;
    });
    render(<SessionAccessControl api={collaborationApi} scope={projectScope} />);
    fireEvent.click(screen.getByRole("button", { name: "Collaboration access" }));
    expect(await screen.findByText(/Chat worktree wt_one/)).toBeVisible();
    expect(screen.getByText(/feature\/chat/)).toBeVisible();
    expect(screen.getByText(/Uncommitted changes/)).toBeVisible();
    expect(screen.getByText(/Owner <owner@example.test>/)).toBeVisible();
    expect(screen.getByText(/GitHub access is missing/)).toBeVisible();
  });

  it("does not offer management to viewers or inherited members", async () => {
    const viewerScope = { ...scope, role: "viewer" as const, membershipMode: "inherited" as const,
      parentScopeId: "20000000-0000-4000-8000-000000000001",
      capabilities: { ...scope.capabilities, discuss: false, manageMembers: false, requestAi: false } };
    const viewerApi = api();
    viewerApi.get.mockImplementation(async (path: string) => path.endsWith("/members") ? { members } : viewerScope);
    render(<SessionAccessControl api={viewerApi} scope={viewerScope} />);
    fireEvent.click(screen.getByRole("button", { name: "Collaboration access" }));
    expect(await screen.findByText("Project access")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Manage access" })).toBeNull();
  });

  it("moves focus into the summary and returns it on close", async () => {
    render(<SessionAccessControl api={api()} scope={scope} />);
    const trigger = screen.getByRole("button", { name: "Collaboration access" });
    fireEvent.click(trigger);
    const close = await screen.findByRole("button", { name: "Close access summary" });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.click(close);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("light-dismisses the access summary and returns focus to its trigger", async () => {
    render(<SessionAccessControl api={api()} scope={scope} />);
    const trigger = screen.getByRole("button", { name: "Collaboration access" });
    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Collaboration access summary" })).toBeVisible();

    fireEvent.pointerDown(document.body);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Collaboration access summary" })).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("uses the refreshed scope revision for preset grants", async () => {
    const currentScope = { ...scope, revision: "3" };
    const collaborationApi = api();
    collaborationApi.get.mockImplementation(async (path: string) => path.startsWith("/api/organizations/")
      ? { members: [{ actorId: "user_ada", role: "member", joinedAt: "2026-09-17T12:00:00.000Z" }] }
      : path.endsWith("/grants") ? [] : path.endsWith("/members") ? { members } : currentScope);
    collaborationApi.post.mockImplementation(async (path: string, body: { audience?: unknown; preset?: string }) =>
      path.endsWith("/policy/preflight") ? undefined : {
        id: "20000000-0000-4000-8000-000000000001", scopeId: scope.id,
        organizationId: scope.organizationId, audience: body.audience, preset: body.preset,
        state: "pending", policyVersion: "v1", revision: "1",
        createdAt: "2026-09-17T12:00:00.000Z", updatedAt: "2026-09-17T12:00:00.000Z",
      });
    render(<SessionAccessControl api={collaborationApi} scope={scope} />);

    fireEvent.click(screen.getByRole("button", { name: "Collaboration access" }));
    fireEvent.click(await screen.findByRole("button", { name: "Manage access" }));
    fireEvent.change(await screen.findByLabelText("Share with"), { target: { value: "user_ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));

    await waitFor(() => expect(collaborationApi.post).toHaveBeenCalledWith(
      `/api/collaboration/scopes/${scope.id}/grants`,
      expect.objectContaining({ expectedRevision: "3", audience: { kind: "member", actorId: "user_ada" }, preset: "viewer" }),
    ));
  });
});
