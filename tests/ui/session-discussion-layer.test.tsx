// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { SessionDiscussionLayer } from "../../packages/ui/src/collaboration/SessionDiscussionLayer";
import { useSessionDiscussion } from "../../packages/ui/src/collaboration/useSessionDiscussion";

const discussion = {
  messages: [{
    id: "note-1",
    scopeId: "10000000-0000-4000-8000-000000000001",
    sequence: "1",
    actor: { actorId: "ada", displayName: "Ada" },
    text: "Human-only note",
    createdAt: "2026-09-17T12:00:00.000Z",
  }],
  latestSequence: "1",
  draft: "",
  setDraft: vi.fn(),
  loading: false,
  sending: false,
  error: false,
  send: vi.fn(async () => undefined),
  hasMore: false,
  loadMore: vi.fn(async () => undefined),
  readOnly: false,
};

describe("SessionDiscussionLayer", () => {
  it("is an overlay dialog, explains AI isolation, and supports light dismiss", () => {
    const close = vi.fn();
    render(<SessionDiscussionLayer open onClose={close} discussion={discussion} zIndex={620} />);
    expect(screen.getByRole("dialog", { name: "Discussion" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText(/not prompts for AI/i)).toBeVisible();
    expect(document.querySelector('[data-slot="session-discussion-layer"]')).toHaveClass("absolute", "inset-0");
    expect(document.querySelector('[data-slot="session-discussion-layer"]')).toHaveStyle({ zIndex: "620" });
    expect(document.querySelector('[data-slot="session-discussion-layer"]')).not.toHaveClass("z-30");
    fireEvent.click(screen.getByRole("button", { name: "Close discussion" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("supports Escape and makes viewer discussion read-only", () => {
    const close = vi.fn();
    render(<SessionDiscussionLayer open onClose={close} discussion={{ ...discussion, readOnly: true }} />);
    expect(screen.getByLabelText("Add a discussion note")).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("contains keyboard focus and uses the confirmed full-height mobile presentation", async () => {
    render(<SessionDiscussionLayer open onClose={vi.fn()} discussion={{ ...discussion, draft: "Private draft" }} />);
    const dialog = screen.getByRole("dialog", { name: "Discussion" });
    const close = screen.getByRole("button", { name: "Close discussion panel" });
    const post = screen.getByRole("button", { name: "Post note" });

    await waitFor(() => expect(close).toHaveFocus());
    expect(dialog).toHaveClass("w-full", "bg-background", "sm:w-96");
    post.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(close).toHaveFocus();
    close.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(post).toHaveFocus();
  });

  it("paginates notes and marks only rendered notes as read", async () => {
    const notes = Array.from({ length: 101 }, (_, index) => ({
      id: `note-${index + 1}`,
      scopeId: "10000000-0000-4000-8000-000000000001",
      sequence: String(index + 1),
      actor: { actorId: "ada", displayName: "Ada" },
      text: `Note ${index + 1}`,
      createdAt: "2026-09-17T12:00:00.000Z",
    }));
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => path.includes("after=100")
        ? { messages: notes.slice(100), latestSequence: "101" }
        : { messages: notes.slice(0, 100), latestSequence: "101" }),
      post: vi.fn(),
      patch: vi.fn(async (_path: string, body: unknown) => body),
      delete: vi.fn(),
    };
    const scope = {
      id: "10000000-0000-4000-8000-000000000001",
      ownerId: "user_owner",
      kind: "chat" as const,
      resourceId: "chat_shared",
      membershipMode: "direct" as const,
      lifecycle: "shared" as const,
      revision: "1",
      authEpoch: "1",
      authorityGeneration: "1",
      role: "editor" as const,
      capabilities: { read: true, discuss: true, manageMembers: false, requestAi: true,
        observeTerminal: false, controlTerminal: false, stopTerminal: false },
    };
    function Harness() {
      const value = useSessionDiscussion({ api, scope, actorId: "ada", runtimeId: "owner-vps", open: true });
      return <SessionDiscussionLayer open onClose={vi.fn()} discussion={value} />;
    }

    render(<Harness />);
    expect(await screen.findByText("Note 100")).toBeVisible();
    expect(screen.queryByText("Note 101")).toBeNull();
    await waitFor(() => expect(api.patch).toHaveBeenLastCalledWith(
      `/api/collaboration/scopes/${scope.id}/discussion/user-state`,
      { readThroughSeq: "100" },
    ));

    fireEvent.click(screen.getByRole("button", { name: "Load more discussion notes" }));
    expect(await screen.findByText("Note 101")).toBeVisible();
    await waitFor(() => expect(api.patch).toHaveBeenLastCalledWith(
      `/api/collaboration/scopes/${scope.id}/discussion/user-state`,
      { readThroughSeq: "101" },
    ));
  });

  it("fences an in-flight page when the collaboration identity changes", async () => {
    const scopeA = {
      id: "10000000-0000-4000-8000-000000000001",
      ownerId: "user_owner",
      kind: "chat" as const,
      resourceId: "chat_a",
      membershipMode: "direct" as const,
      lifecycle: "shared" as const,
      revision: "1",
      authEpoch: "1",
      authorityGeneration: "1",
      role: "editor" as const,
      capabilities: { read: true, discuss: true, manageMembers: false, requestAi: true,
        observeTerminal: false, controlTerminal: false, stopTerminal: false },
    };
    const scopeB = { ...scopeA, id: "20000000-0000-4000-8000-000000000002", resourceId: "chat_b" };
    const note = (scopeId: string, text: string) => ({
      id: `note-${scopeId}`,
      scopeId,
      sequence: "1",
      actor: { actorId: "ada", displayName: "Ada" },
      text,
      createdAt: "2026-09-17T12:00:00.000Z",
    });
    let resolveScopeA!: (value: unknown) => void;
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async (path: string) => {
        if (path.includes(scopeA.id)) return new Promise((resolve) => { resolveScopeA = resolve; });
        return { messages: [note(scopeB.id, "Scope B note")], latestSequence: "1" };
      }),
      post: vi.fn(),
      patch: vi.fn(async (_path: string, body: unknown) => body),
      delete: vi.fn(),
    };
    function Harness({ scope }: { scope: typeof scopeA }) {
      const value = useSessionDiscussion({ api, scope, actorId: "ada", runtimeId: "owner-vps", open: true });
      return <SessionDiscussionLayer open onClose={vi.fn()} discussion={value} />;
    }
    const view = render(<Harness scope={scopeA} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining(scopeA.id)));

    view.rerender(<Harness scope={scopeB} />);
    expect(await screen.findByText("Scope B note")).toBeVisible();
    await act(async () => {
      resolveScopeA({ messages: [note(scopeA.id, "Scope A note")], latestSequence: "1" });
      await Promise.resolve();
    });

    expect(screen.queryByText("Scope A note")).toBeNull();
    expect(screen.getByText("Scope B note")).toBeVisible();
    expect(api.patch).not.toHaveBeenCalledWith(
      expect.stringContaining(scopeA.id),
      expect.anything(),
    );
  });
});
