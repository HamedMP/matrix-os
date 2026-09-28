// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatCollaboration } from "../../packages/ui/src/collaboration/ChatCollaboration";

const scopeId = "10000000-0000-4000-8000-000000000001";
const rootId = "20000000-0000-4000-8000-000000000001";
const childId = "20000000-0000-4000-8000-000000000002";
const fileId = "20000000-0000-4000-8000-000000000003";
const base = `/api/collaboration/scopes/${scopeId}`;

function entry(id: string, kind: "file" | "folder", path: string, parentId: string | null, revision = "4") {
  return { id, kind, path, parentId, revision, incarnation: "a".repeat(64), updatedAt: "2026-09-28T12:00:00.000Z" };
}

const root = entry(rootId, "folder", "projects/shared", null);
const child = entry(childId, "folder", "projects/shared/notes", rootId);
const file = entry(fileId, "file", "projects/shared/notes/readme.txt", childId);

function fakeApi(role: "editor" | "viewer", pages: Array<{ entries: unknown[]; nextCursor?: string }>) {
  const api = {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => {
      if (path === base) return {
        id: scopeId, ownerId: "user_owner", kind: "folder", resourceId: rootId, membershipMode: "direct", lifecycle: "shared",
        revision: "1", authEpoch: "1", authorityGeneration: "1", role,
        capabilities: { read: true, discuss: true, manageMembers: false, requestAi: false, observeTerminal: false, controlTerminal: false, stopTerminal: false },
      };
      if (path.startsWith(`${base}/files?`)) return pages[path.includes("cursor=") ? 1 : 0] ?? { entries: [] };
      throw Error(`unexpected ${path}`);
    }),
    post: vi.fn(async (_path: string, body: { type: string; fileId?: string; path?: string }) => ({
      entry: body.type === "create" ? entry(crypto.randomUUID(), "folder", body.path!, rootId, "1") : entry(body.fileId!, "folder", body.path ?? child.path, rootId, "5"),
      replayed: false,
    })),
    delete: vi.fn(),
    getContent: vi.fn(async () => ({ status: "ok" as const, bytes: new TextEncoder().encode("hello"), contentType: "text/plain", size: 5 })),
  };
  return api;
}

beforeEach(() => {
  Object.assign(URL, { createObjectURL: vi.fn(() => "blob:folder"), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("SharedFolderView", () => {
  it("pages the bounded folder listing and navigates by catalog parent identity", async () => {
    const api = fakeApi("viewer", [{ entries: [root, child], nextCursor: child.path }, { entries: [file] }]);
    render(<ChatCollaboration view={{ kind: "folder", scopeId }} api={api} actorId="user_member" />);
    expect(await screen.findByRole("heading", { name: "shared" })).toBeVisible();
    expect(screen.getByRole("button", { name: "notes" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "notes" }));
    expect(screen.getByText("readme.txt")).toBeVisible();
    expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
    expect(api.get).toHaveBeenCalledWith(`${base}/files?limit=100&cursor=${encodeURIComponent(child.path)}`);
  });

  it("creates, renames and deletes as a Contributor using exact catalog identities and revisions", async () => {
    const api = fakeApi("editor", [{ entries: [root, child] }]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ChatCollaboration view={{ kind: "folder", scopeId }} api={api} actorId="user_member" />);
    fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New folder name" }), { target: { value: "drafts" } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${base}/files/actions`, expect.objectContaining({
      type: "create", kind: "folder", parentId: rootId, path: "projects/shared/drafts", clientRequestId: expect.any(String),
    })));
    fireEvent.click(screen.getByRole("button", { name: "Rename notes" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rename folder" }), { target: { value: "archive" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${base}/files/actions`, expect.objectContaining({
      type: "rename", fileId: childId, expectedRevision: "4", path: "projects/shared/archive",
    })));
    fireEvent.click(screen.getByRole("button", { name: "Delete archive" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${base}/files/actions`, expect.objectContaining({
      type: "delete", fileId: childId, expectedRevision: "5",
    })));
  });

  it("downloads only bounded bytes and retains a mutation error while downloading", async () => {
    const api = fakeApi("editor", [{ entries: [root, { ...file, parentId: rootId }] }]);
    api.post.mockRejectedValueOnce(new Error("provider path /private/owner"));
    render(<ChatCollaboration view={{ kind: "folder", scopeId }} api={api} actorId="user_member" />);
    fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New folder name" }), { target: { value: "drafts" } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not");
    fireEvent.click(screen.getByRole("button", { name: "Download readme.txt" }));
    await waitFor(() => expect(api.getContent).toHaveBeenCalledWith(`${base}/files/${fileId}/content`, { maxBytes: 2 * 1024 * 1024 }));
    expect(screen.getByRole("alert")).toHaveTextContent("could not");
    expect(screen.queryByText(/private\/owner/)).toBeNull();
  });
});
