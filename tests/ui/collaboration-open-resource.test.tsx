// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { ChatCollaboration } from "../../packages/ui/src/collaboration/ChatCollaboration";
import {
  canOpenSharedResource,
  openSharedResource,
  type SharedResourceKind,
} from "../../packages/ui/src/collaboration/recipient-views";

const scopeId = "10000000-0000-4000-8000-000000000001";
const invitationId = "30000000-0000-4000-8000-000000000001";
const grantId = "40000000-0000-4000-8000-000000000001";
const KINDS: SharedResourceKind[] = ["chat", "terminal", "project", "file", "folder", "app"];

function openers() {
  return {
    openChat: vi.fn(),
    openTerminal: vi.fn(),
    openProject: vi.fn(),
    openFile: vi.fn(),
    openFolder: vi.fn(),
    openApp: vi.fn(),
  };
}

function openerFor(kind: SharedResourceKind, all: ReturnType<typeof openers>) {
  return { chat: all.openChat, terminal: all.openTerminal, project: all.openProject, file: all.openFile, folder: all.openFolder, app: all.openApp }[kind];
}

function scopeFor(kind: SharedResourceKind, role: "editor" | "viewer" = "editor") {
  return {
    id: scopeId, ownerId: "user_owner", kind, resourceId: `${kind}_1`, membershipMode: "direct", lifecycle: "shared",
    revision: "1", authEpoch: "1", authorityGeneration: "1", role,
    capabilities: { read: true, discuss: true, manageMembers: false, requestAi: false, observeTerminal: false, controlTerminal: false, stopTerminal: false },
  };
}

describe("openSharedResource", () => {
  it.each(KINDS)("opens a %s with its own opener and never another", (kind) => {
    const all = openers();
    expect(openSharedResource(kind, scopeId, all)).toBe(true);
    const expected = openerFor(kind, all);
    expect(expected).toHaveBeenCalledWith(scopeId);
    for (const opener of Object.values(all)) if (opener !== expected) expect(opener).not.toHaveBeenCalled();
  });

  it.each(["file", "folder", "app"] as const)("reports a %s it cannot open instead of falling back to Chat", (kind) => {
    const all = openers();
    const partial = { openChat: all.openChat, openTerminal: all.openTerminal, openProject: all.openProject };
    expect(canOpenSharedResource(kind, partial)).toBe(false);
    expect(openSharedResource(kind, scopeId, partial)).toBe(false);
    expect(all.openChat).not.toHaveBeenCalled();
  });
});

describe("kind-aware opening in Shared with me", () => {
  it.each(KINDS)("accepts an invited %s into its own view", async (kind) => {
    const all = openers();
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => path.startsWith("/api/collaboration/inbox") ? { items: [{
        scopeId, runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "user_owner", kind,
        authorityGeneration: 1, status: "invited", invitationId,
        resource: {
          id: invitationId, scopeId, owner: { actorId: "user_owner", displayName: "Nima" }, target: { actorId: "user_ada", displayName: "Ada" },
          scopeKind: kind, role: "editor", status: "pending", expiresAt: "2026-10-19T12:00:00.000Z", revision: "2",
        },
      }] } : { items: [] }),
      post: vi.fn(async () => ({ scopeId })),
      delete: vi.fn(),
    };
    render(<ChatCollaboration view={{ kind: "home" }} api={api} actorId="user_ada" {...all} />);

    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));

    await waitFor(() => expect(openerFor(kind, all)).toHaveBeenCalledWith(scopeId));
    for (const opener of Object.values(all)) if (opener !== openerFor(kind, all)) expect(opener).not.toHaveBeenCalled();
  });

  it.each(KINDS)("opens an organization-wide %s in its own view after accepting the grant", async (kind) => {
    const all = openers();
    let accepted = false;
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => path.startsWith("/api/collaboration/shared") && !accepted ? { items: [{
        scopeId, runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "user_owner", kind,
        authorityGeneration: 1, status: "organization_pending", organizationId: "org_matrix_team", grantId,
      }] } : { items: [] }),
      post: vi.fn(async () => { accepted = true; return { state: "active" }; }),
      delete: vi.fn(),
    };
    render(<ChatCollaboration view={{ kind: "home" }} api={api} actorId="user_ada" {...all} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    await waitFor(() => expect(openerFor(kind, all)).toHaveBeenCalledWith(scopeId));
    for (const opener of Object.values(all)) if (opener !== openerFor(kind, all)) expect(opener).not.toHaveBeenCalled();
  });

  it("lists an accepted file by name and opens it in the file view", async () => {
    const all = openers();
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => path.startsWith("/api/collaboration/shared") ? { items: [{
        scopeId, runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "user_owner", kind: "file",
        authorityGeneration: 1, status: "accepted", resource: { scope: scopeFor("file", "viewer"), name: "launch-notes.md" },
      }] } : { items: [] }),
      post: vi.fn(),
      delete: vi.fn(),
    };
    render(<ChatCollaboration view={{ kind: "home" }} api={api} actorId="user_ada" {...all} />);

    expect(await screen.findByText("launch-notes.md")).toBeVisible();
    expect(screen.getByText("Shared file · Viewer")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(all.openFile).toHaveBeenCalledWith(scopeId);
    expect(all.openChat).not.toHaveBeenCalled();
  });

  it("explains an accepted folder or app this surface cannot open yet", async () => {
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => path.startsWith("/api/collaboration/shared") ? { items: [{
        scopeId, runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "user_owner", kind: "folder",
        authorityGeneration: 1, status: "accepted", resource: { scope: scopeFor("folder") },
      }] } : { items: [] }),
      post: vi.fn(),
      delete: vi.fn(),
    };
    const openChat = vi.fn();
    render(<ChatCollaboration view={{ kind: "home" }} api={api} actorId="user_ada" openChat={openChat} />);

    expect(await screen.findByText("Shared folder · Editor")).toBeVisible();
    expect(screen.getByText("This shared folder can’t be opened here yet.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();
    expect(openChat).not.toHaveBeenCalled();
  });

  it("explains an accepted invitation or organization share this surface cannot open", async () => {
    let organizationAccepted = false;
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => {
        if (path.startsWith("/api/collaboration/inbox")) return { items: [{
          scopeId, runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "user_owner", kind: "folder",
          authorityGeneration: 1, status: "invited", invitationId,
          resource: {
            id: invitationId, scopeId, owner: { actorId: "user_owner", displayName: "Nima" }, target: { actorId: "user_ada", displayName: "Ada" },
            scopeKind: "folder", role: "editor", status: "pending", expiresAt: "2026-10-19T12:00:00.000Z", revision: "2",
          },
        }] };
        return { items: organizationAccepted ? [] : [{
          scopeId: "10000000-0000-4000-8000-000000000009", runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "user_owner", kind: "app",
          authorityGeneration: 1, status: "organization_pending", organizationId: "org_matrix_team", grantId,
        }] };
      }),
      post: vi.fn(async (path: string) => {
        if (path.includes("/grants/")) { organizationAccepted = true; return { state: "active" }; }
        return { scopeId };
      }),
      delete: vi.fn(),
    };
    const openChat = vi.fn();
    render(<ChatCollaboration view={{ kind: "home" }} api={api} actorId="user_ada" openChat={openChat} />);

    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Accepted. This shared folder can’t be opened here yet.");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Accepted. This shared app can’t be opened here yet."));
    expect(openChat).not.toHaveBeenCalled();
  });

  it("explains an accepted invitation details page this surface cannot open", async () => {
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async () => ({
        id: invitationId, scopeId, owner: { actorId: "user_owner", displayName: "Nima" }, target: { actorId: "user_ada", displayName: "Ada" },
        scopeKind: "app", role: "viewer", status: "pending", expiresAt: "2026-10-19T12:00:00.000Z", revision: "2",
      })),
      post: vi.fn(async () => ({ scopeId })),
      delete: vi.fn(),
    };
    const openChat = vi.fn();
    render(<ChatCollaboration view={{ kind: "invitation", invitationId }} api={api} actorId="user_ada" openChat={openChat} />);

    fireEvent.click(await screen.findByRole("button", { name: /Accept/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("Accepted. This shared app can’t be opened here yet.");
    expect(openChat).not.toHaveBeenCalled();
  });

  it("describes what a file invitation grants instead of Chat access", async () => {
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async () => ({
        id: invitationId, scopeId, owner: { actorId: "user_owner", displayName: "Nima" }, target: { actorId: "user_ada", displayName: "Ada" },
        scopeKind: "file", role: "viewer", status: "pending", expiresAt: "2026-10-19T12:00:00.000Z", revision: "2",
      })),
      post: vi.fn(async () => ({ scopeId })),
      delete: vi.fn(),
    };
    const all = openers();
    render(<ChatCollaboration view={{ kind: "invitation", invitationId }} api={api} actorId="user_ada" {...all} />);

    expect(await screen.findByText(/Access to this file/)).toBeVisible();
    expect(screen.queryByText(/Chat’s history/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Accept/ }));
    await waitFor(() => expect(all.openFile).toHaveBeenCalledWith(scopeId));
    expect(all.openChat).not.toHaveBeenCalled();
  });
});
