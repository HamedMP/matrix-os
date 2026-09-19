// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatCollaboration,
  SharedChatPanel,
} from "../../packages/ui/src/collaboration/ChatCollaboration";

const scopeId = "10000000-0000-4000-8000-000000000001";
const invitationId = "30000000-0000-4000-8000-000000000001";
const chatId = "chat_shared_launch";
const defaultSelection = { instanceId: "claude_shared", model: "claude-opus-4-6" };
const createdAt = "2026-09-17T12:00:00.000Z";

describe("shared Chat two-account lifecycle", () => {
  afterEach(cleanup);

  it("accepts, discusses live, requests AI, and reconnects through the shared Chat panel", async () => {
    let accepted = false;
    let revision = 1;
    const messages: Array<Record<string, unknown>> = [];
    const discussionMessages: Array<Record<string, unknown>> = [];
    const requests: Array<Record<string, unknown>> = [];
    const subscribers = new Map<string, Set<() => void | Promise<void>>>();

    const scopeFor = (actorId: string) => ({
      id: scopeId,
      ownerId: "user_owner",
      kind: "chat" as const,
      resourceId: chatId,
      membershipMode: "direct" as const,
      lifecycle: "shared" as const,
      revision: String(revision),
      authEpoch: "1",
      authorityGeneration: "1",
      role: actorId === "user_owner" ? "owner" as const : "editor" as const,
      capabilities: {
        read: true,
        discuss: true,
        manageMembers: actorId === "user_owner",
        requestAi: true,
        observeTerminal: false,
        controlTerminal: false,
        stopTerminal: false,
      },
    });
    const chat = () => ({
      id: chatId,
      scopeId,
      title: "Launch plan",
      lifecycle: "active" as const,
      revision: String(revision),
      messageCount: String(messages.length),
    });
    const notify = (exceptActorId?: string) => {
      queueMicrotask(() => {
        for (const [actorId, actorSubscribers] of subscribers) {
          if (actorId !== exceptActorId) for (const subscriber of actorSubscribers) void subscriber();
        }
      });
    };
    const apiFor = (actorId: string, displayName: string) => ({
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => {
        if (path.endsWith(`/invitations/${invitationId}`)) return {
          id: invitationId,
          scopeId,
          owner: { actorId: "user_owner", displayName: "Nima" },
          target: { actorId: "user_editor", displayName: "Ada" },
          scopeKind: "chat",
          role: "editor",
          status: accepted ? "accepted" : "pending",
          expiresAt: "2026-09-18T12:00:00.000Z",
          revision: "1",
        };
        if (path.endsWith("/chat/messages?after=0&limit=100")) return { messages };
        if (path.includes("/discussion/messages?")) {
          const after = BigInt(new URL(path, "https://matrix.invalid").searchParams.get("after") ?? "0");
          return {
            messages: discussionMessages.filter((message) => BigInt(String(message.sequence)) > after),
            latestSequence: String(discussionMessages.length),
          };
        }
        if (path.endsWith("/chat/requests")) return {
          requests,
          approvals: [],
          capability: { status: "available", effectiveSelection: defaultSelection },
          resourceRevision: String(revision),
        };
        if (path.endsWith("/chat")) return chat();
        if (path.endsWith(`/scopes/${scopeId}`)) return scopeFor(actorId);
        throw new Error(`Unexpected GET ${path}`);
      }),
      post: vi.fn(async (path: string, body: unknown) => {
        if (path.endsWith(`/invitations/${invitationId}/accept`)) {
          accepted = true;
          return { scopeId, actorId, status: "accepted", revision: "2" };
        }
        if (path.endsWith("/discussion/messages")) {
          const text = (body as { text: string }).text;
          const message = {
            id: `msg_discussion_${messages.length + 1}`,
            scopeId,
            sequence: String(discussionMessages.length + 1),
            actor: { actorId, displayName },
            text,
            createdAt,
          };
          discussionMessages.push(message);
          notify();
          return message;
        }
        if (path.endsWith("/chat/requests")) {
          const text = (body as { text: string }).text;
          revision += 1;
          const request = {
            id: `qturn_${requests.length + 1}`,
            chatId,
            acceptedSequence: String(requests.length + 1),
            actor: { actorId, displayName },
            state: "completed",
            text,
            selection: defaultSelection,
            acceptedAt: createdAt,
            updatedAt: createdAt,
          };
          requests.push(request);
          messages.push({
            id: `msg_ai_request_${messages.length + 1}`,
            chatId,
            sequence: String(messages.length + 1),
            role: "user",
            state: "committed",
            purpose: "ai_request",
            actor: { actorId, displayName },
            parts: [{ type: "text", text }],
            createdAt,
          });
          messages.push({
            id: `msg_assistant_${messages.length + 1}`,
            chatId,
            sequence: String(messages.length + 1),
            role: "assistant",
            state: "committed",
            purpose: "assistant",
            actor: { actorId: "matrix_ai", displayName: "Matrix AI" },
            parts: [{ type: "text", text: "Shared answer for everyone" }],
            createdAt,
          });
          notify();
          return { request, resourceRevision: String(revision) };
        }
        throw new Error(`Unexpected POST ${path}`);
      }),
      patch: vi.fn(async () => ({ readThroughSeq: String(discussionMessages.length) })),
      delete: vi.fn(),
      subscribe: vi.fn((_scopeId: string, onEvent: () => void | Promise<void>) => {
        const current = subscribers.get(actorId) ?? new Set();
        current.add(onEvent);
        subscribers.set(actorId, current);
        return () => { current.delete(onEvent); if (!current.size) subscribers.delete(actorId); };
      }),
    });

    const editorApi = apiFor("user_editor", "Ada");
    const ownerApi = apiFor("user_owner", "Nima");
    const openChat = vi.fn();
    const invitation = render(
      <ChatCollaboration
        view={{ kind: "invitation", invitationId }}
        api={editorApi}
        actorId="user_editor"
        openChat={openChat}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
    await waitFor(() => expect(openChat).toHaveBeenCalledWith(scopeId));
    invitation.unmount();

    const owner = render(
      <SharedChatPanel api={ownerApi} actorId="user_owner" runtimeId="owner-runtime" scopeId={scopeId} />,
    );
    const editor = render(
      <SharedChatPanel api={editorApi} actorId="user_editor" runtimeId="editor-runtime" scopeId={scopeId} />,
    );
    expect(await within(owner.container).findByLabelText("Message Chat")).toBeVisible();
    expect(within(owner.container).queryByRole("button", { name: "Ask AI" })).toBeNull();
    expect(await within(editor.container).findByLabelText("Message Chat")).toBeVisible();
    expect(within(editor.container).queryByRole("button", { name: "Ask AI" })).toBeNull();

    fireEvent.click(within(editor.container).getByRole("button", { name: "Open discussion" }));
    fireEvent.change(await within(editor.container).findByLabelText("Add a discussion note"), {
      target: { value: "Ada joined the discussion" },
    });
    fireEvent.click(within(editor.container).getByRole("button", { name: "Post note" }));
    expect(within(owner.container).queryByText("Ada joined the discussion")).toBeNull();
    fireEvent.click(within(owner.container).getByRole("button", { name: "Open discussion" }));
    expect(await within(owner.container).findByText("Ada joined the discussion")).toBeVisible();
    expect(await within(editor.container).findByText("Ada joined the discussion")).toBeVisible();

    fireEvent.click(within(editor.container).getByRole("button", { name: "Close discussion panel" }));
    fireEvent.change(within(editor.container).getByLabelText("Message Chat"), {
      target: { value: "Summarize the launch decision" },
    });
    fireEvent.click(within(editor.container).getByRole("button", { name: "Send" }));

    expect(await within(owner.container).findByText("Shared answer for everyone")).toBeVisible();
    expect(within(owner.container).getAllByText("Ada").length).toBeGreaterThan(0);

    editor.unmount();
    await act(async () => { await Promise.resolve(); });
    const reconnectedEditor = render(
      <SharedChatPanel api={editorApi} actorId="user_editor" runtimeId="editor-runtime" scopeId={scopeId} />,
    );
    await waitFor(() => expect(within(reconnectedEditor.container).getByText("Shared answer for everyone")).toBeVisible());
    expect(within(reconnectedEditor.container).queryByText("Ada joined the discussion")).toBeNull();
    fireEvent.click(within(reconnectedEditor.container).getByRole("button", { name: "Open discussion" }));
    expect(await within(reconnectedEditor.container).findByText("Ada joined the discussion")).toBeVisible();
  });
});
