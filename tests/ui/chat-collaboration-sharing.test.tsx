// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ChatSharingButton } from "../../packages/ui/src/chat/ChatSharingButton";
import { ChatCollaboration } from "../../packages/ui/src/collaboration/ChatCollaboration";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});

const scopeId = "10000000-0000-4000-8000-000000000001";
const chatId = "chat_one";

describe("Chat collaboration sharing", () => {
  it("keeps snapshot sharing and live invitations as distinct choices", () => {
    const api = { baseUrl: "https://gateway.test", get: vi.fn(), post: vi.fn(), delete: vi.fn() };
    render(<ChatSharingButton api={api} collaborationApi={api} runtimeId="runtime_owner" chatId={chatId}
      handle="owner" runtimeSlot="primary" platformHost="https://app.matrix-os.com" copyText={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(screen.getByRole("button", { name: "Share snapshot" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Invite collaborators" })).toBeVisible();
    expect(screen.getByText(/frozen copy/i)).toBeVisible();
    expect(screen.getByText(/ongoing Chat/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(screen.queryByRole("button", { name: "Share snapshot" })).toBeNull();
  });

  it("converts an idle Chat once and invites an editor through the live authority", async () => {
    const scope = {
      id: scopeId, ownerId: "user_owner", kind: "chat", resourceId: chatId,
      membershipMode: "direct", lifecycle: "shared", revision: "1", authEpoch: "1",
      authorityGeneration: "1", role: "owner",
      capabilities: { read: true, discuss: true, manageMembers: true, requestAi: false },
    };
    const collaborationApi = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => path.endsWith("/members") ? { members: [] } : scope),
      post: vi.fn(async (path: string) => {
        if (path.endsWith("/preflight")) return { eligible: true, resourceRevision: "4", confirmationToken: "a".repeat(64) };
        if (path.endsWith("/scopes")) return scope;
        if (path.endsWith("/invitations")) return { invitationId: "30000000-0000-4000-8000-000000000001" };
        throw new Error("unexpected route");
      }),
      delete: vi.fn(),
      patch: vi.fn(),
    };
    const snapshotApi = { baseUrl: "https://gateway.test", get: vi.fn(), post: vi.fn(), delete: vi.fn() };
    render(<ChatSharingButton api={snapshotApi} collaborationApi={collaborationApi} runtimeId="runtime_owner"
      chatId={chatId} handle="owner" runtimeSlot="primary" platformHost="https://app.matrix-os.com" copyText={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.click(screen.getByRole("button", { name: "Invite collaborators" }));
    await screen.findByRole("dialog", { name: "Invite collaborators" });
    fireEvent.change(screen.getByLabelText("Matrix user ID"), { target: { value: "user_editor" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "editor" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(collaborationApi.post).toHaveBeenCalledWith(
      `/api/collaboration/scopes/${scopeId}/invitations`,
      expect.objectContaining({ targetActorId: "user_editor", role: "editor", expectedRevision: "1" }),
    ));
    expect(screen.getByText(/Invitation sent/i)).toBeVisible();
    expect(snapshotApi.post).not.toHaveBeenCalled();
  });

  it("shows an authenticated invitation inbox and accepts into the shared Chat", async () => {
    const invitationId = "30000000-0000-4000-8000-000000000001";
    const invitation = {
      id: invitationId, scopeId, owner: { actorId: "user_owner", displayName: "Nima" },
      target: { actorId: "user_editor", displayName: "Ada" }, scopeKind: "chat" as const,
      role: "editor" as const, status: "pending" as const,
      expiresAt: "2026-09-14T12:00:00.000Z", revision: "1",
    };
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => path.endsWith("/inbox")
        ? { items: [{ scopeId, runtimeId: "runtime_owner", ownerId: "user_owner", kind: "chat", authorityGeneration: 1, status: "invited", invitationId, resource: invitation }] }
        : path.endsWith("/shared") ? { items: [] } : invitation),
      post: vi.fn(async () => ({ scopeId, actorId: "user_editor", status: "accepted", revision: "2" })),
      delete: vi.fn(),
    };
    const openInvitation = vi.fn();
    const openChat = vi.fn();
    const { rerender } = render(<ChatCollaboration view={{ kind: "home" }} api={api} actorId="user_editor"
      openInvitation={openInvitation} openChat={openChat} />);
    expect(await screen.findByText("Nima invited you")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Review invitation/i }));
    expect(openInvitation).toHaveBeenCalledWith(invitationId);

    rerender(<ChatCollaboration view={{ kind: "invitation", invitationId }} api={api} actorId="user_editor"
      openInvitation={openInvitation} openChat={openChat} />);
    expect(await screen.findByRole("heading", { name: "Join this shared Chat?" })).toBeVisible();
    expect(screen.getByText(/does not include its project/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      `/api/collaboration/invitations/${invitationId}/accept`,
      expect.objectContaining({ expectedRevision: "1" }),
    ));
    expect(openChat).toHaveBeenCalledWith(scopeId);
  });

  it("loads additional opaque discovery pages without replacing the first page", async () => {
    const invitation = (index: number, ownerName: string) => ({
      id: `30000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      scopeId: `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      owner: { actorId: `user_owner_${index}`, displayName: ownerName },
      target: { actorId: "user_editor", displayName: "Ada" },
      scopeKind: "chat" as const,
      role: "editor" as const,
      status: "pending" as const,
      expiresAt: "2026-09-14T12:00:00.000Z",
      revision: "1",
    });
    const first = invitation(1, "Owner One");
    const second = invitation(2, "Owner Two");
    const item = (resource: ReturnType<typeof invitation>) => ({
      scopeId: resource.scopeId,
      runtimeId: "runtime_owner",
      ownerId: resource.owner.actorId,
      kind: "chat" as const,
      authorityGeneration: 1,
      status: "invited" as const,
      invitationId: resource.id,
      resource,
    });
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => path === "/api/collaboration/inbox"
        ? { items: [item(first)], nextCursor: "opaque-inbox-page" }
        : path.includes("cursor=opaque-inbox-page")
          ? { items: [item(second)] }
          : { items: [] }),
      post: vi.fn(), delete: vi.fn(),
    };
    render(<ChatCollaboration view={{ kind: "home" }} api={api} actorId="user_editor" />);
    expect(await screen.findByText("Owner One invited you")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load more shared items" }));
    expect(await screen.findByText("Owner Two invited you")).toBeVisible();
    expect(screen.getByText("Owner One invited you")).toBeVisible();
  });

  it("renders attributed canonical history and preserves a private draft after failure", async () => {
    const scope = {
      id: scopeId, ownerId: "user_owner", kind: "chat" as const, resourceId: chatId,
      membershipMode: "direct" as const, lifecycle: "shared" as const, revision: "1", authEpoch: "1",
      authorityGeneration: "1", role: "editor" as const,
      capabilities: { read: true, discuss: true, manageMembers: false, requestAi: false },
    };
    let fail = true;
    let refresh = () => undefined;
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/chat/messages?after=0&limit=100")) return { messages: [{
          id: "msg_one", chatId, sequence: "1", role: "user", state: "committed", purpose: "discussion",
          actor: { actorId: "user_owner", displayName: "Nima" }, parts: [{ type: "text", text: "**Welcome**" }],
          createdAt: "2026-09-07T12:00:00.000Z",
        }] };
        if (path.endsWith("/chat")) return { id: chatId, scopeId, title: "Launch plan", lifecycle: "active", revision: "1", messageCount: "1" };
        if (path.endsWith("/user-state")) return { readThroughSeq: "0", pinned: false, muted: false };
        return scope;
      }),
      post: vi.fn(async () => {
        if (fail) throw new Error("private upstream detail");
        return { id: "msg_two", chatId, sequence: "2", purpose: "discussion", actor: { actorId: "user_editor", displayName: "Ada" }, text: "Ready", createdAt: "2026-09-07T12:01:00.000Z" };
      }),
      patch: vi.fn(async () => ({ readThroughSeq: "1", pinned: false, muted: false })),
      delete: vi.fn(),
      subscribe: vi.fn((_scopeId: string, onEvent: () => void) => {
        refresh = onEvent;
        return () => undefined;
      }),
    };
    const { unmount } = render(<ChatCollaboration view={{ kind: "chat", scopeId }} api={api}
      actorId="user_editor" runtimeId="runtime_owner" />);
    expect(await screen.findByText("Nima")).toBeVisible();
    expect(screen.getByText("Welcome")).toBeVisible();
    expect(screen.getByText(/AI requests are unavailable/i)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Message everyone"), { target: { value: "Ready" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Message was not sent");
    expect(screen.getByLabelText("Message everyone")).toHaveValue("Ready");
    const requestsBeforeRefresh = api.get.mock.calls.length;
    refresh();
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(requestsBeforeRefresh));
    expect(screen.getByRole("alert")).toHaveTextContent("Message was not sent");
    unmount();

    fail = false;
    render(<ChatCollaboration view={{ kind: "chat", scopeId }} api={api}
      actorId="user_editor" runtimeId="runtime_owner" />);
    await waitFor(() => expect(screen.getByLabelText("Message everyone")).toHaveValue("Ready"));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByLabelText("Message everyone")).toHaveValue(""));
  });

  it("does not let an older scope load overwrite a newly selected Chat", async () => {
    const oldScopeId = "10000000-0000-4000-8000-000000000010";
    const nextScopeId = "10000000-0000-4000-8000-000000000011";
    const scopeFor = (id: string, resourceId: string) => ({
      id, ownerId: "user_owner", kind: "chat" as const, resourceId,
      membershipMode: "direct" as const, lifecycle: "shared" as const, revision: "1", authEpoch: "1",
      authorityGeneration: "1", role: "editor" as const,
      capabilities: { read: true, discuss: true, manageMembers: false, requestAi: false },
    });
    let resolveOldScope!: (value: unknown) => void;
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => {
        const isOld = path.includes(oldScopeId);
        if (isOld && path.endsWith(oldScopeId)) {
          return new Promise<unknown>((resolve) => { resolveOldScope = resolve; });
        }
        if (path.includes("/chat/messages")) return { messages: [] };
        if (path.endsWith("/chat")) {
          return { id: isOld ? "chat_old" : "chat_next", scopeId: isOld ? oldScopeId : nextScopeId,
            title: isOld ? "Old Chat" : "New Chat", lifecycle: "active", revision: "1", messageCount: "0" };
        }
        return scopeFor(nextScopeId, "chat_next");
      }),
      post: vi.fn(), delete: vi.fn(),
    };
    const { rerender } = render(<ChatCollaboration view={{ kind: "chat", scopeId: oldScopeId }} api={api}
      actorId="user_editor" runtimeId="runtime_owner" />);
    await waitFor(() => expect(resolveOldScope).toBeTypeOf("function"));
    rerender(<ChatCollaboration view={{ kind: "chat", scopeId: nextScopeId }} api={api}
      actorId="user_editor" runtimeId="runtime_owner" />);
    expect(await screen.findByRole("heading", { name: "New Chat" })).toBeVisible();
    await act(async () => { resolveOldScope(scopeFor(oldScopeId, "chat_old")); });
    expect(screen.getByRole("heading", { name: "New Chat" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Old Chat" })).toBeNull();
  });

  it("does not let a stale history page overwrite a newer canonical refresh", async () => {
    const scope = {
      id: scopeId, ownerId: "user_owner", kind: "chat" as const, resourceId: chatId,
      membershipMode: "direct" as const, lifecycle: "shared" as const, revision: "1", authEpoch: "1",
      authorityGeneration: "1", role: "viewer" as const,
      capabilities: { read: true, discuss: false, manageMembers: false, requestAi: false },
    };
    const message = (sequence: number) => ({
      id: `msg_${sequence}`, chatId, sequence: String(sequence), role: "user" as const,
      state: "committed" as const, purpose: "discussion" as const,
      actor: { actorId: "user_owner", displayName: "Nima" }, parts: [{ type: "text" as const, text: `Message ${sequence}` }],
      createdAt: "2026-09-07T12:00:00.000Z",
    });
    let refresh = () => undefined;
    let refreshing = false;
    let resolvePage!: (value: unknown) => void;
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => {
        if (path.endsWith("after=1&limit=100")) return new Promise<unknown>((resolve) => { resolvePage = resolve; });
        if (path.endsWith("after=0&limit=100")) return { messages: refreshing ? [message(1), message(2), message(3)] : [message(1)] };
        if (path.endsWith("/chat")) return { id: chatId, scopeId, title: "Race-safe Chat", lifecycle: "active", revision: "1", messageCount: refreshing ? "3" : "2" };
        return scope;
      }),
      post: vi.fn(), delete: vi.fn(),
      subscribe: vi.fn((_scopeId: string, onEvent: () => void) => {
        refresh = onEvent;
        return () => undefined;
      }),
    };
    render(<ChatCollaboration view={{ kind: "chat", scopeId }} api={api} actorId="user_viewer" />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more messages" }));
    await waitFor(() => expect(resolvePage).toBeTypeOf("function"));
    refreshing = true;
    refresh();
    expect(await screen.findByText("Message 3")).toBeVisible();
    await act(async () => resolvePage({ messages: [message(2)] }));
    expect(screen.getByText("Message 3")).toBeVisible();
  });

  it("keeps viewer discussion controls read-only", async () => {
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => {
        if (path.includes("messages")) return { messages: [] };
        if (path.endsWith("/chat")) return { id: chatId, scopeId, title: "Read only", lifecycle: "active", revision: "1", messageCount: "0" };
        if (path.endsWith("/user-state")) return { readThroughSeq: "0", pinned: false, muted: false };
        return { id: scopeId, ownerId: "user_owner", kind: "chat", resourceId: chatId, membershipMode: "direct", lifecycle: "shared",
          revision: "1", authEpoch: "1", authorityGeneration: "1", role: "viewer",
          capabilities: { read: true, discuss: false, manageMembers: false, requestAi: false } };
      }),
      post: vi.fn(), delete: vi.fn(),
    };
    render(<ChatCollaboration view={{ kind: "chat", scopeId }} api={api} actorId="user_viewer" runtimeId="runtime_owner" />);
    expect(await screen.findByLabelText("Message everyone")).toBeDisabled();
    expect(screen.getByText(/Viewers can read this Chat/i)).toBeVisible();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("paginates canonical history instead of treating the first page as complete", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `msg_${index}`, chatId, sequence: String(index + 1), role: "user" as const,
      state: "committed" as const, purpose: "discussion" as const,
      actor: { actorId: "user_owner", displayName: "Nima" }, parts: [{ type: "text" as const, text: `Message ${index + 1}` }],
      createdAt: "2026-09-07T12:00:00.000Z",
    }));
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => {
        if (path.endsWith("after=0&limit=100")) return { messages: firstPage };
        if (path.endsWith("after=100&limit=100")) return { messages: [{
          id: "msg_101", chatId, sequence: "101", role: "user", state: "committed", purpose: "discussion",
          actor: { actorId: "user_editor", displayName: "Ada" }, parts: [{ type: "text", text: "Latest message" }],
          createdAt: "2026-09-07T12:01:00.000Z",
        }] };
        if (path.endsWith("/chat")) return { id: chatId, scopeId, title: "Long Chat", lifecycle: "active", revision: "1", messageCount: "101" };
        return { id: scopeId, ownerId: "user_owner", kind: "chat", resourceId: chatId, membershipMode: "direct", lifecycle: "shared",
          revision: "1", authEpoch: "1", authorityGeneration: "1", role: "viewer",
          capabilities: { read: true, discuss: false, manageMembers: false, requestAi: false } };
      }),
      post: vi.fn(), delete: vi.fn(),
    };
    render(<ChatCollaboration view={{ kind: "chat", scopeId }} api={api} actorId="user_viewer" runtimeId="runtime_owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more messages" }));
    expect(await screen.findByText("Latest message")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Load more messages" })).toBeNull();
  });

  it("keeps loaded history visible when an older history page fails", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `msg_${index}`, chatId, sequence: String(index + 1), role: "user" as const,
      state: "committed" as const, purpose: "discussion" as const,
      actor: { actorId: "user_owner", displayName: "Nima" }, parts: [{ type: "text" as const, text: `Message ${index + 1}` }],
      createdAt: "2026-09-07T12:00:00.000Z",
    }));
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => {
        if (path.endsWith("after=0&limit=100")) return { messages: firstPage };
        if (path.endsWith("after=100&limit=100")) throw new Error("private upstream detail");
        if (path.endsWith("/chat")) return { id: chatId, scopeId, title: "Long Chat", lifecycle: "active", revision: "1", messageCount: "101" };
        return { id: scopeId, ownerId: "user_owner", kind: "chat", resourceId: chatId, membershipMode: "direct", lifecycle: "shared",
          revision: "1", authEpoch: "1", authorityGeneration: "1", role: "viewer",
          capabilities: { read: true, discuss: false, manageMembers: false, requestAi: false } };
      }),
      post: vi.fn(), delete: vi.fn(),
    };
    render(<ChatCollaboration view={{ kind: "chat", scopeId }} api={api} actorId="user_viewer" runtimeId="runtime_owner" />);
    expect(await screen.findByText("Message 1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load more messages" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("More messages could not be loaded");
    expect(screen.getByText("Message 1")).toBeVisible();
    expect(screen.getByRole("button", { name: "Load more messages" })).toBeVisible();
  });
});
