// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { ChatCollaboration } from "../../packages/ui/src/collaboration/ChatCollaboration";

const scopeId = "10000000-0000-4000-8000-000000000001";
const chatScopeId = "10000000-0000-4000-8000-000000000002";
const terminalScopeId = "10000000-0000-4000-8000-000000000003";
const fileId = "20000000-0000-4000-8000-000000000001";
const base = `/api/collaboration/scopes/${scopeId}`;
const scope = {
  id: scopeId, ownerId: "user_owner", kind: "project", resourceId: "proj_launch", membershipMode: "direct", lifecycle: "shared",
  revision: "1", authEpoch: "1", authorityGeneration: "1", role: "viewer",
  capabilities: { read: true, discuss: true, manageMembers: false, requestAi: false, observeTerminal: false, controlTerminal: false, stopTerminal: false },
};
const resource = (kind: string, id: string, title: string, childScopeId?: string, readiness = "ready") => ({
  kind, id, title, revision: "1", readiness, ...(childScopeId ? { scopeId: childScopeId } : {}),
});
const project = {
  id: "proj_launch", scopeId, title: "Launch plan", status: "active",
  resources: [
    resource("chat", "chat_roadmap", "Roadmap", chatScopeId),
    resource("terminal", "terminal_build", "Build terminal", terminalScopeId),
    resource("chat", "chat_private", "Private", undefined),
    resource("file", "notes/launch.md", "launch.md"),
    resource("app", "notes", "Notes"),
    resource("app", "blocked", "Blocked", undefined, "blocked"),
  ],
};

function fixture() {
  let currentScope = scope;
  let currentProject = { ...project, resources: [...project.resources] };
  let nextCursor: string | undefined;
  const changed = new Set<() => void | Promise<void>>();
  const api = {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => {
      if (path === base) return currentScope;
      if (path === `${base}/project`) return currentProject;
      if (path === `${base}/files?limit=100`) return { entries: [{ id: fileId, kind: "file", path: "notes/launch.md", parentId: null, revision: "1", incarnation: "a".repeat(64), updatedAt: "2026-09-28T12:00:00.000Z" }], ...(nextCursor ? { nextCursor } : {}) };
      if (path === `${base}/files/${fileId}`) return { id: fileId, kind: "file", path: "notes/launch.md", parentId: null, revision: "1", incarnation: "a".repeat(64), updatedAt: "2026-09-28T12:00:00.000Z" };
      if (path === `${base}/apps/notes`) return { appId: "notes", revision: "1", readiness: "ready", collaborationMode: "scoped" };
      throw new Error(`Unexpected ${path}`);
    }),
    getContent: vi.fn(async (path: string) => {
      const appAsset = path === `${base}/apps/notes/assets/index.html`;
      const body = appAsset ? "<!doctype html><html><head></head><body><h1>Notes</h1></body></html>" : "Launch checklist";
      const bytes = new TextEncoder().encode(body);
      return { status: "ok" as const, bytes, contentType: appAsset ? "text/html" : "text/markdown", size: bytes.byteLength };
    }),
    post: vi.fn(), delete: vi.fn(),
    subscribe: vi.fn((_scopeId: string, onEvent: () => void | Promise<void>) => { changed.add(onEvent); return () => { changed.delete(onEvent); }; }),
  };
  return { api, openChat: vi.fn(), openTerminal: vi.fn(),
    setResources: (resources: typeof project.resources) => { currentProject = { ...currentProject, resources }; },
    setCursor: (cursor: string | undefined) => { nextCursor = cursor; },
    setRole: (role: "viewer" | "editor") => { currentScope = { ...scope, role }; },
    refresh: async () => { await act(async () => { await Promise.all([...changed].map((listener) => listener())); }); },
  };
}

describe("shared project navigation", () => {
  it("opens ready Chats and terminals through inherited child scopes and leaves missing scopes closed", async () => {
    const { api, openChat, openTerminal } = fixture();
    render(<ChatCollaboration view={{ kind: "project", scopeId }} api={api} actorId="user_viewer" openChat={openChat} openTerminal={openTerminal} />);
    expect(await screen.findByRole("heading", { name: "Launch plan" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open Roadmap" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Build terminal" }));
    expect(openChat).toHaveBeenCalledWith(chatScopeId, "chat_roadmap", "Roadmap");
    expect(openTerminal).toHaveBeenCalledWith(terminalScopeId);
    expect(screen.queryByRole("button", { name: "Open Private" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Blocked" })).toBeNull();
  });

  it("opens an exact project file through its catalog descriptor", async () => {
    const { api } = fixture();
    render(<ChatCollaboration view={{ kind: "project", scopeId }} api={api} actorId="user_viewer" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open launch.md" }));
    expect(await screen.findByLabelText("File preview")).toHaveTextContent("Launch checklist");
    expect(api.get).toHaveBeenCalledWith(`${base}/files/${fileId}`);
    expect(api.getContent).toHaveBeenCalledWith(`${base}/files/${fileId}/content`, expect.anything());
  });

  it("opens a project app from the authorized project scope", async () => {
    const { api } = fixture();
    render(<ChatCollaboration view={{ kind: "project", scopeId }} api={api} actorId="user_viewer" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Notes" }));
    expect(await screen.findByTitle("Shared app")).toHaveAttribute("sandbox", "allow-scripts");
    expect(api.get).toHaveBeenCalledWith(`${base}/apps/notes`);
    expect(api.get).not.toHaveBeenCalledWith(`${base}/apps`);
  });

  it("closes a selected app after it is blocked by the owner", async () => {
    const f = fixture();
    render(<ChatCollaboration view={{ kind: "project", scopeId }} api={f.api} actorId="user_viewer" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Notes" }));
    expect(await screen.findByTitle("Shared app")).toBeVisible();
    f.setResources(project.resources.map((entry) => entry.kind === "app" && entry.id === "notes" ? { ...entry, readiness: "blocked" } : entry));
    await f.refresh();
    expect(screen.queryByTitle("Shared app")).toBeNull();
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer available");
  });

  it("clears a stale file page when a refreshed project has no ready files", async () => {
    const f = fixture();
    f.setCursor("next-page");
    render(<ChatCollaboration view={{ kind: "project", scopeId }} api={f.api} actorId="user_viewer" />);
    expect(await screen.findByRole("button", { name: "Load more files" })).toBeVisible();
    f.setResources(project.resources.filter((entry) => entry.kind !== "file"));
    await f.refresh();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more files" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Open launch.md" })).toBeNull();
  });

  it("closes a removed file editor while preserving unsaved text for copying", async () => {
    const f = fixture();
    f.setRole("editor");
    render(<ChatCollaboration view={{ kind: "project", scopeId }} api={f.api} actorId="user_editor" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open launch.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "File contents" }), { target: { value: "My unsaved edit" } });
    f.setResources(project.resources.filter((entry) => entry.kind !== "file"));
    await f.refresh();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Preserved unsaved text" })).toHaveValue("My unsaved edit");
  });
});
