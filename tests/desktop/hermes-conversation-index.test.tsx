// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@desktop/shared/app-error";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { HermesConversationIndex } from
  "@desktop/renderer/src/features/chat/HermesConversationIndex";
import {
  filterConversations,
  normalizeConversationQuery,
} from "@desktop/renderer/src/features/chat/conversation-search";
import {
  useHermesChat,
  type HermesConversationSummary,
} from "@desktop/renderer/src/stores/hermes-chat";
import { useTabs } from "@desktop/renderer/src/stores/tabs";

const conversations: HermesConversationSummary[] = [
  {
    id: "launch-plan",
    title: "Launch plan",
    preview: "Prepare the release checklist",
    messageCount: 4,
    createdAt: 10,
    updatedAt: 30,
  },
  {
    id: "support-notes",
    title: "Customer notes",
    preview: "Review LAUNCH feedback from support",
    messageCount: 2,
    createdAt: 5,
    updatedAt: 20,
  },
  {
    id: "budget",
    title: "Budget review",
    preview: "Compare infrastructure costs",
    messageCount: 1,
    createdAt: 1,
    updatedAt: 10,
  },
];

function api(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: "https://matrix.test",
    get: vi.fn(async () => []),
    getText: vi.fn(),
    getBlob: vi.fn(),
    post: vi.fn(async () => ({ id: "new-chat" })),
    postBytes: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    putBytes: vi.fn(),
    delete: vi.fn(async () => ({ ok: true })),
    putText: vi.fn(),
    ...overrides,
  } as ApiClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  useTabs.setState(useTabs.getInitialState(), true);
  useHermesChat.setState(useHermesChat.getInitialState(), true);
  useHermesChat.setState({
    conversations,
    indexStatus: "ready",
    indexError: null,
    status: "idle",
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("conversation search", () => {
  it("normalizes whitespace and filters title or preview without reordering", () => {
    expect(normalizeConversationQuery("  LAUNCH  ")).toBe("launch");
    expect(filterConversations(conversations, "  LAUNCH  ").map((item) => item.id))
      .toEqual(["launch-plan", "support-notes"]);
    expect(filterConversations(conversations, "   ")).toBe(conversations);
  });
});

describe("HermesConversationIndex", () => {

  it("renders the approved header and focuses an ephemeral Search field", () => {
    render(<HermesConversationIndex api={api()} />);

    expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /select/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
    const search = screen.getByRole("searchbox", { name: "Search chats" });
    expect(document.activeElement).toBe(search);
    expect(search.getAttribute("type")).toBe("text");
    fireEvent.change(search, { target: { value: "budget" } });
    expect(screen.getByRole("button", { name: "Budget review conversation" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Launch plan conversation" })).toBeNull();

    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("searchbox", { name: "Search chats" })).toBeNull();
    expect(screen.getByRole("button", { name: "Launch plan conversation" })).toBeTruthy();
  });

  it("renders 64px rows with a harness badge, timestamp, and no preview metadata", () => {
    render(<HermesConversationIndex api={api()} />);

    const launch = screen.getByRole("button", { name: "Launch plan conversation" });
    const row = launch.closest("[data-conversation-row]");
    expect(row).not.toBeNull();
    expect(row?.className).toContain("h-16");
    expect(launch.textContent).toContain("Launch plan");
    expect(launch.textContent).toContain("Hermes");
    expect(launch.textContent).not.toContain("Prepare the release checklist");
    expect(launch.textContent).not.toContain("4 messages");
    expect(row?.querySelector("time")).not.toBeNull();
  });

  it("distinguishes no matches from an empty canonical index", () => {
    const client = api();
    const { rerender } = render(<HermesConversationIndex api={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search chats" }), {
      target: { value: "nothing matches" },
    });

    expect(screen.getByText("No matching chats")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();

    act(() => useHermesChat.setState({ conversations: [], indexStatus: "ready" }));
    rerender(<HermesConversationIndex api={client} />);
    expect(screen.getByText("No chats yet")).toBeTruthy();
    expect(screen.queryByText("No matching chats")).toBeNull();
  });

  it("clears ephemeral search state when the runtime changes", () => {
    const client = api();
    const { rerender } = render(<HermesConversationIndex api={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search chats" }), {
      target: { value: "budget" },
    });

    act(() => {
      useHermesChat.getState().resetRuntime();
      useHermesChat.setState({ conversations, indexStatus: "ready" });
    });
    rerender(<HermesConversationIndex api={client} />);

    expect(screen.queryByRole("searchbox", { name: "Search chats" })).toBeNull();
    expect(screen.getByRole("button", { name: "Launch plan conversation" })).toBeTruthy();
  });

  it("keeps row opening separate from the hover and focus delete action", () => {
    const openConversation = vi.fn(async () => true);
    useHermesChat.setState({ openConversation });
    render(<HermesConversationIndex api={api()} />);

    const remove = screen.getByRole("button", { name: "Delete Launch plan" });
    expect(remove.className).toContain("group-hover:pointer-events-auto");
    expect(remove.className).toContain("group-focus-within:opacity-100");
    remove.focus();
    expect(document.activeElement).toBe(remove);
    fireEvent.click(remove);

    expect(openConversation).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog", { name: "Delete Launch plan?" });
    expect(dialog.className).toContain("dialog-fade-in");
    expect([...dialog.classList]).not.toContain("fade-in");
    expect(dialog.style.transform).toBe("translate(-50%, -50%)");
  });

  it("keeps harness and activity metadata visible when delete is revealed", () => {
    render(<HermesConversationIndex api={api()} />);

    const launch = screen.getByRole("button", { name: "Launch plan conversation" });
    const remove = screen.getByRole("button", { name: "Delete Launch plan" });
    const row = launch.closest("[data-conversation-row]");
    const metadata = row?.querySelector("[data-conversation-metadata]");

    launch.focus();
    expect(document.activeElement).toBe(launch);
    expect(metadata).not.toBeNull();
    expect(metadata?.textContent).toContain("Hermes");
    expect(metadata?.querySelector("time")).not.toBeNull();
    expect(metadata?.className).not.toContain("group-hover:opacity-0");
    expect(metadata?.className).not.toContain("group-focus-within:opacity-0");
    expect(remove.className).toContain("group-hover:opacity-100");

    remove.focus();
    expect(document.activeElement).toBe(remove);
    expect(remove.className).toContain("focus:opacity-100");
    expect(metadata?.textContent).toContain("Hermes");
    expect(metadata?.querySelector("time")).not.toBeNull();
  });

  it("does not promote a canonical Gateway conversation when it is only opened", async () => {
    const openConversation = vi.fn(async () => true);
    useHermesChat.setState({ openConversation });
    render(<HermesConversationIndex api={api()} />);

    fireEvent.click(screen.getByRole("button", { name: "Launch plan conversation" }));

    await waitFor(() => expect(openConversation).toHaveBeenCalledWith(
      expect.anything(),
      "launch-plan",
    ));

    openConversation.mockResolvedValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Customer notes conversation" }));
    await waitFor(() => expect(openConversation).toHaveBeenCalledWith(
      expect.anything(),
      "support-notes",
    ));
  });

  it("cancels without a request and confirms only once while pending", async () => {
    const pending = deferred<{ ok: true }>();
    const remove = vi.fn(() => pending.promise);
    const client = api({ delete: remove });
    render(<HermesConversationIndex api={client} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete Launch plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete Launch plan" }));
    const confirm = screen.getByRole("button", { name: "Delete chat" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Deleting chat" }).hasAttribute("disabled"))
      .toBe(true);
    expect(screen.getByRole("button", {
      name: "Launch plan conversation",
      hidden: true,
    })).toBeTruthy();

    pending.resolve({ ok: true });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.queryByRole("button", { name: "Launch plan conversation" })).toBeNull();
  });

  it("disables deletion for a known running chat with recovery guidance", () => {
    useHermesChat.setState({ sessionId: "launch-plan", status: "streaming" });
    render(<HermesConversationIndex api={api()} />);

    const remove = screen.getByRole("button", { name: "Delete Launch plan" });
    expect(remove.hasAttribute("disabled")).toBe(true);
    expect(remove.getAttribute("aria-describedby")).toBe("delete-running-launch-plan");
    expect(screen.getByText("Stop the active response before deleting this chat.", {
      selector: "span",
    })).toBeTruthy();
  });

  it("keeps a failed row and dialog recoverable with safe copy", async () => {
    const remove = vi.fn().mockRejectedValue(
      new AppError("server", { detail: "conversation_busy" }),
    );
    render(<HermesConversationIndex api={api({ delete: remove })} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete Launch plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));

    expect((await screen.findByRole("alert")).textContent)
      .toContain("Stop the active response before deleting this chat.");
    expect(screen.getByRole("button", {
      name: "Launch plan conversation",
      hidden: true,
    })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete chat" }).hasAttribute("disabled"))
      .toBe(false);
  });
});
