// @vitest-environment jsdom

import React, { type ComponentProps, type ComponentType } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type {
  CanonicalChatClient,
  CanonicalChatEventSource,
  CanonicalChatInvalidation,
} from "@desktop/renderer/src/lib/canonical-chat-client";
import { WorkRail } from "@desktop/renderer/src/features/work/WorkRail";
import { PinOffIcon } from "@desktop/renderer/src/lib/hugeicons";
import type { Project } from "@desktop/renderer/src/stores/board";
import { afterEach, describe, expect, it, vi } from "vitest";

function record(
  id: string,
  title: string,
  options: {
    pinned?: boolean;
    projectId?: string;
    updatedAt: string;
    attention?: "none" | "approval_required" | "input_required" | "failed";
    activeRunStatus?: "accepted" | "running" | "waiting_for_approval" | "waiting_for_input";
    unacknowledged?: boolean;
  },
): CanonicalChatRecord {
  return {
    chat: {
      id,
      ownerScope: { type: "personal", ownerId: "owner_test" },
      title,
      lifecycle: "active",
      attention: options.attention ?? "none",
      revision: 1,
      messageCount: 1,
      userState: { readThroughSeq: 0, pinned: options.pinned ?? false, muted: false },
      createdAt: options.updatedAt,
      updatedAt: options.updatedAt,
    },
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.activeRunStatus ? {
      activeRun: {
        runId: `run_${id}`,
        turnId: `cturn_${id}`,
        status: options.activeRunStatus,
      },
    } : {}),
    ...(options.unacknowledged === undefined ? {} : {
      latestSuccessfulCompletion: {
        runId: `run_completed_${id}`,
        completedAt: "2026-08-28T12:01:00.000Z",
        unacknowledged: options.unacknowledged,
      },
    }),
  } as CanonicalChatRecord;
}

const alpha: Project = { id: "project_alpha_id", slug: "alpha", name: "Alpha", kind: "folder" };
const beta: Project = { id: "project_beta_id", slug: "beta", name: "Beta", kind: "scratch" };
const pinned = record("chat_pinned", "Pinned global", { pinned: true, updatedAt: "2026-08-28T12:00:00.000Z" });
const projectChat = record("chat_alpha", "Alpha chat", { projectId: "project_alpha_id", updatedAt: "2026-08-28T11:00:00.000Z" });
const recent = record("chat_recent", "Recent global", { updatedAt: "2026-08-28T10:00:00.000Z" });

function setup() {
  const records = [pinned, projectChat, recent];
  const client = {
    list: vi.fn(async () => ({ items: records })),
    delete: vi.fn(async (chatId: string) => ({
      chatId,
      deletedAt: "2026-08-28T13:00:00.000Z",
    })),
    updateUserState: vi.fn(async (chatId: string, input: { pinned: boolean }) => {
      const current = records.find((candidate) => candidate.chat.id === chatId)!;
      return {
        ...current,
        chat: {
          ...current.chat,
          userState: { readThroughSeq: 0, muted: false, pinned: input.pinned },
        },
      };
    }),
  } as unknown as CanonicalChatClient;
  const actions = {
    onNewGlobalChat: vi.fn(),
    onCreateProject: vi.fn(),
    onNewProjectChat: vi.fn(),
    onSelectChat: vi.fn(),
    onCollapse: vi.fn(),
  };
  render(<WorkRail client={client} projects={[alpha]} active {...actions} />);
  return { client, actions };
}

function eventHarness() {
  const listeners = new Set<(event: CanonicalChatInvalidation) => void>();
  const eventSource: Pick<CanonicalChatEventSource, "subscribe"> = {
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return {
    eventSource,
    emit(event: CanonicalChatInvalidation) { for (const listener of listeners) listener(event); },
  };
}

function renderRail(client: CanonicalChatClient, eventSource?: Pick<CanonicalChatEventSource, "subscribe">) {
  const EventAwareWorkRail = WorkRail as ComponentType<
    ComponentProps<typeof WorkRail> & { eventSource?: Pick<CanonicalChatEventSource, "subscribe"> }
  >;
  render(<EventAwareWorkRail client={client} eventSource={eventSource} projects={[]} active
    onNewGlobalChat={vi.fn()} onCreateProject={vi.fn()} onNewProjectChat={vi.fn()}
    onSelectChat={vi.fn()} onCollapse={vi.fn()} />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WorkRail", () => {
  it("matches the Settings sidebar title, groups, and item styling", async () => {
    setup();
    const rail = screen.getByRole("navigation", { name: "Chat navigation" });
    const newChat = screen.getByRole("button", { name: "New chat" });
    const search = screen.getByRole("button", { name: "Search chats" });

    expect(rail.className).toContain("w-[240px]");
    expect(rail.className).toContain("gap-0.5");
    expect(rail.className).toContain("overflow-y-auto");
    expect(rail.className).toContain("p-2");
    expect(rail.getAttribute("style")).toContain("background: var(--bg-surface)");
    const title = screen.getByRole("heading", { name: "Chats" });
    expect(title.className).toContain("px-2.5");
    expect(title.className).toContain("py-2");
    expect(title.className).toContain("text-lg");
    expect(title.className).toContain("font-semibold");
    expect(newChat.className).toContain("gap-2.5");
    expect(newChat.className).toContain("px-2.5");
    expect(newChat.className).toContain("py-1.5");
    expect(newChat.className).toContain("text-sm");
    expect(newChat.className).toContain("font-medium");
    expect(newChat.closest('[data-slot="chat-sidebar-new-chat"]')).toBeTruthy();
    expect(search.closest("[data-chat-sidebar-title]")).toBeTruthy();
    expect(search.closest('[data-slot="chat-sidebar-section-heading"]')).toBeNull();
    expect(screen.queryByText("Search", { selector: "button" })).toBeNull();

    const pinnedChat = await screen.findByRole("button", { name: "Pinned global" });
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    const projectChatRow = screen.getByRole("button", { name: "Alpha chat" });
    const recentChat = screen.getByRole("button", { name: "Recent global" });
    const pinnedHeading = screen.getByRole("button", { name: "Pinned" });
    const projectsHeading = screen.getByRole("button", { name: "Projects" });
    const recentsHeading = screen.getByRole("button", { name: "Recents" });

    for (const item of [pinnedChat, projectChatRow, recentChat]) {
      expect(item.className).toContain("gap-2.5");
      expect(item.className).toContain("px-2.5");
      expect(item.className).toContain("py-1.5");
      expect(item.className).toContain("text-sm");
      expect(item.className).toContain("font-medium");
    }
    for (const heading of [pinnedHeading, projectsHeading, recentsHeading]) {
      expect(heading.className).toContain("px-2.5");
      expect(heading.className).toContain("pt-2");
      expect(heading.className).toContain("pb-1");
      expect(heading.className).toContain("text-xs");
      expect(heading.className).toContain("font-semibold");
      expect(heading.className).toContain("tracking-wide");
      expect(heading.querySelector("svg")).toBeNull();
    }
  });

  it("converges two Chat rows from the shared event source without adding WorkRail polling", async () => {
    const events = eventHarness();
    const at = "2026-08-29T01:00:00.000Z";
    const acceptedA = record("chat_parallel_a", "Parallel A", { updatedAt: at, activeRunStatus: "accepted" });
    const runningA = record("chat_parallel_a", "Parallel A", { updatedAt: at, activeRunStatus: "running" });
    const failedA = record("chat_parallel_a", "Parallel A", { updatedAt: at, attention: "failed" });
    const abortedA = record("chat_parallel_a", "Parallel A", { updatedAt: at });
    const idleB = record("chat_parallel_b", "Parallel B", { updatedAt: at });
    const completedB = record("chat_parallel_b", "Parallel B", { updatedAt: at, unacknowledged: true });
    const acknowledgedB = record("chat_parallel_b", "Parallel B", { updatedAt: at, unacknowledged: false });
    const client = {
      list: vi.fn()
        .mockResolvedValueOnce({ items: [acceptedA, idleB] })
        .mockResolvedValueOnce({ items: [runningA, completedB] })
        .mockResolvedValueOnce({ items: [runningA, acknowledgedB] })
        .mockResolvedValueOnce({ items: [failedA, acknowledgedB] })
        .mockResolvedValueOnce({ items: [abortedA, acknowledgedB] })
        .mockResolvedValueOnce({ items: [abortedA, acknowledgedB] }),
    } as unknown as CanonicalChatClient;
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    renderRail(client, events.eventSource);

    expect(await screen.findByLabelText("Agent running for Parallel A")).toBeTruthy();
    expect(screen.queryByLabelText("Unseen completion for Parallel B")).toBeNull();

    act(() => events.emit({ type: "chat.changed", chatId: "chat_parallel_b", cursor: 2 }));
    await waitFor(() => expect(screen.getByLabelText("Unseen completion for Parallel B")).toBeTruthy());
    expect(screen.getByLabelText("Agent running for Parallel A")).toBeTruthy();

    act(() => events.emit({ type: "chat.changed", chatId: "chat_parallel_b", cursor: 3 }));
    await waitFor(() => expect(screen.queryByLabelText("Unseen completion for Parallel B")).toBeNull());
    expect(screen.getByLabelText("Agent running for Parallel A")).toBeTruthy();

    act(() => events.emit({ type: "chat.changed", chatId: "chat_parallel_a", cursor: 4 }));
    await waitFor(() => expect(screen.getByLabelText("Agent failed for Parallel A")).toBeTruthy());

    act(() => events.emit({ type: "chat.changed", chatId: "chat_parallel_a", cursor: 5 }));
    await waitFor(() => expect(screen.queryByLabelText("Agent failed for Parallel A")).toBeNull());
    expect(screen.queryByLabelText("Unseen completion for Parallel A")).toBeNull();

    act(() => events.emit({ type: "chat.full_refresh", cursor: 5 }));
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(6));
    expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 200);
  });

  it("coalesces a burst of shared Chat events into one in-flight and one pending canonical refresh", async () => {
    const events = eventHarness();
    let resolveInFlight!: (value: { items: CanonicalChatRecord[] }) => void;
    const inFlight = new Promise<{ items: CanonicalChatRecord[] }>((resolve) => { resolveInFlight = resolve; });
    const initial = record("chat_burst", "Burst chat", { updatedAt: "2026-08-29T02:00:00.000Z" });
    const refreshed = record("chat_burst", "Burst chat", {
      updatedAt: "2026-08-29T02:01:00.000Z",
      activeRunStatus: "running",
    });
    const client = {
      list: vi.fn()
        .mockResolvedValueOnce({ items: [initial] })
        .mockImplementationOnce(() => inFlight)
        .mockResolvedValueOnce({ items: [refreshed] }),
    } as unknown as CanonicalChatClient;
    renderRail(client, events.eventSource);
    await screen.findByRole("button", { name: "Burst chat" });

    act(() => { for (const cursor of [1, 2, 3]) events.emit({ type: "chat.changed", chatId: initial.chat.id, cursor }); });
    expect(client.list).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveInFlight({ items: [initial] });
      await inFlight;
    });
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(3));
    expect(await screen.findByLabelText("Agent running for Burst chat")).toBeTruthy();
  });

  it("renders attention ahead of running and completion for every Chat row", async () => {
    const updatedAt = "2026-08-28T12:00:00.000Z";
    const records = [
      record("chat_approval", "Approval chat", { updatedAt, attention: "approval_required", activeRunStatus: "running", unacknowledged: true }),
      record("chat_input", "Input chat", { updatedAt, attention: "input_required", activeRunStatus: "running", unacknowledged: true }),
    ];
    const client = {
      list: vi.fn(async () => ({ items: records })),
    } as unknown as CanonicalChatClient;
    renderRail(client);

    await screen.findByRole("button", { name: "Approval chat" });
    expect(screen.getByLabelText("Approval required for Approval chat")).toBeTruthy();
    expect(screen.getByLabelText("Input required for Input chat")).toBeTruthy();
    expect(screen.queryByLabelText("Agent running for Approval chat")).toBeNull();
    expect(screen.queryByLabelText("Unseen completion for Input chat")).toBeNull();
  });

  it("renders New chat as a plain leading rail row", async () => {
    const { actions } = setup();
    await screen.findByRole("button", { name: "Pinned global" });

    const newChat = screen.getByRole("button", { name: "New chat" });
    expect(newChat.className).toContain("text-left");
    expect(newChat.className).toContain("gap-2.5");
    expect(newChat.className).not.toContain("w-full");
    expect(newChat.parentElement?.getAttribute("data-slot")).toBe("chat-sidebar-new-chat");
    expect(newChat.className).toContain("px-2.5");
    expect(newChat.style.background).toBe("");
    fireEvent.click(newChat);
    expect(actions.onNewGlobalChat).toHaveBeenCalledOnce();
  });

  it("lets Chat titles use the full row width beneath overlay actions", async () => {
    setup();
    const chat = await screen.findByRole("button", { name: "Recent global" });
    const title = within(chat).getByText("Recent global");
    const actions = screen.getByRole("button", { name: "Pin Recent global" }).parentElement;

    expect(chat.className).toContain("w-full");
    expect(chat.className).not.toMatch(/\bpr-1[23456789]\b/);
    expect(title.getAttribute("title")).toBe("Recent global");
    expect(actions?.className).toContain("absolute");
    expect(actions?.className).toContain("group-focus-within/chat:opacity-100");
    expect(actions?.getAttribute("style")).toContain(
      "background: linear-gradient(var(--bg-hover), var(--bg-hover)), var(--bg-surface)",
    );
  });

  it("hides pinned Chat actions until hover or focus while preserving run status and an Unpin icon", async () => {
    const runningPinned = record("chat_running_pinned", "Running pinned", {
      pinned: true,
      updatedAt: "2026-08-28T12:00:00.000Z",
      activeRunStatus: "running",
    });
    const client = {
      list: vi.fn(async () => ({ items: [runningPinned] })),
    } as unknown as CanonicalChatClient;
    renderRail(client);

    const chat = await screen.findByRole("button", { name: "Running pinned" });
    const pin = screen.getByRole("button", { name: "Unpin Running pinned" });
    const remove = screen.getByRole("button", { name: "Delete Running pinned" });
    const actions = pin.parentElement as HTMLElement;
    const expectedIcon = render(<PinOffIcon size={13} aria-hidden />).container.querySelector("svg");

    expect(within(chat).getByLabelText("Agent running for Running pinned")).toBeTruthy();
    expect(actions.className).toContain("gap-0.5");
    expect(actions.className).toContain("opacity-0");
    expect(actions.className).toContain("pointer-events-none");
    expect(actions.className).toContain("group-hover/chat:pointer-events-auto");
    expect(actions.className).toContain("group-focus-within/chat:pointer-events-auto");
    expect(actions.className).toContain("group-hover/chat:opacity-100");
    expect(actions.className).toContain("group-focus-within/chat:opacity-100");
    expect(remove.className).toContain("size-6");
    expect(pin.querySelector("svg")?.isEqualNode(expectedIcon ?? null)).toBe(true);

    pin.focus();
    expect(document.activeElement).toBe(pin);
  });

  it("scrolls only an overflowing Chat title while hover actions are visible", async () => {
    let resize!: ResizeObserverCallback;
    class TitleResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", TitleResizeObserver);
    setup();
    const chat = await screen.findByRole("button", { name: "Recent global" });
    const title = within(chat).getByTitle("Recent global");
    const viewport = title.parentElement!;
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 120 });
    Object.defineProperty(title, "scrollWidth", { configurable: true, value: 220 });

    act(() => resize([], {} as ResizeObserver));

    expect(viewport.dataset.overflowing).toBe("true");
    expect(title.className).toContain("group-hover/chat:animate-[chat-title-scroll_4s_ease-in-out_infinite_alternate]");
    expect(title.className).toContain("group-focus-within/chat:animate-[chat-title-scroll_4s_ease-in-out_infinite_alternate]");
    expect(title.className).toContain("motion-reduce:animate-none");
    expect(viewport.style.getPropertyValue("--chat-title-scroll-distance")).toBe("156px");
  });

  it("keeps short Chat titles stable when hover actions are visible", async () => {
    const observers: Array<{ callback: ResizeObserverCallback; elements: Set<Element> }> = [];
    class TitleResizeObserver implements ResizeObserver {
      private readonly entry: { callback: ResizeObserverCallback; elements: Set<Element> };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, elements: new Set() };
        observers.push(this.entry);
      }
      observe(element: Element) { this.entry.elements.add(element); }
      unobserve(element: Element) { this.entry.elements.delete(element); }
      disconnect() { this.entry.elements.clear(); }
    }
    vi.stubGlobal("ResizeObserver", TitleResizeObserver);
    setup();
    const chat = await screen.findByRole("button", { name: "Recent global" });
    const title = within(chat).getByTitle("Recent global");
    const viewport = title.parentElement!;
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 180 });
    Object.defineProperty(title, "scrollWidth", { configurable: true, value: 60 });
    const observer = observers.find((candidate) => candidate.elements.has(viewport))!;

    act(() => observer.callback([], observer as unknown as ResizeObserver));

    expect(viewport.dataset.overflowing).toBe("false");
    expect(title.className).not.toContain("chat-title-scroll");
    expect(viewport.style.getPropertyValue("--chat-title-scroll-distance")).toBe("0px");
  });

  it("preserves overlay scrolling for a selected pinned Chat row", async () => {
    const observers: Array<{ callback: ResizeObserverCallback; elements: Set<Element> }> = [];
    class TitleResizeObserver implements ResizeObserver {
      private readonly entry: { callback: ResizeObserverCallback; elements: Set<Element> };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, elements: new Set() };
        observers.push(this.entry);
      }
      observe(element: Element) { this.entry.elements.add(element); }
      unobserve(element: Element) { this.entry.elements.delete(element); }
      disconnect() { this.entry.elements.clear(); }
    }
    vi.stubGlobal("ResizeObserver", TitleResizeObserver);
    const client = { list: vi.fn(async () => ({ items: [pinned] })) } as unknown as CanonicalChatClient;
    render(
      <WorkRail client={client} projects={[]} active activeChatId="chat_pinned"
        onNewGlobalChat={vi.fn()} onCreateProject={vi.fn()} onNewProjectChat={vi.fn()}
        onSelectChat={vi.fn()} onCollapse={vi.fn()} />,
    );
    const chat = await screen.findByRole("button", { name: "Pinned global" });
    const title = within(chat).getByTitle("Pinned global");
    const viewport = title.parentElement!;
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 110 });
    Object.defineProperty(title, "scrollWidth", { configurable: true, value: 190 });
    const observer = observers.find((candidate) => candidate.elements.has(viewport))!;
    act(() => observer.callback([], observer as unknown as ResizeObserver));

    const actions = screen.getByRole("button", { name: "Unpin Pinned global" }).parentElement!;
    expect(chat.getAttribute("aria-current")).toBe("page");
    expect(viewport.dataset.overflowing).toBe("true");
    expect(actions.className).toContain("absolute");
    expect(actions.getAttribute("style")).toContain(
      "background: linear-gradient(var(--bg-selected), var(--bg-selected)), var(--bg-surface)",
    );
  });

  it("opens an autofocused Chat search dialog from the top of the rail", async () => {
    setup();
    await screen.findByRole("button", { name: "Recent global" });

    fireEvent.click(screen.getByRole("button", { name: "Search chats" }));

    expect(screen.getByRole("dialog", { name: "Search chats" })).toBeTruthy();
    const search = screen.getByRole("searchbox", { name: "Search chats" });
    const searchGroup = search.parentElement as HTMLElement;
    expect(document.activeElement).toBe(search);
    expect(searchGroup.className).toContain("chat-search-field");
    expect(searchGroup.className).not.toContain("focus-within:ring-2");
    expect(searchGroup.className).not.toContain("focus-within:ring-[var(--accent)]");
    expect(search.className).toContain("appearance-none");
    expect(search.className).toContain("border-0");
    expect(search.className).toContain("shadow-none");
    expect(search.className).toContain("focus:ring-0");
    expect((search as HTMLElement).style.borderStyle).toBe("none");
    expect((search as HTMLElement).style.borderWidth).toBe("0px");
    expect((search as HTMLElement).style.borderRadius).toBe("0px");
    expect((search as HTMLElement).style.boxShadow).toBe("none");
    expect((search as HTMLElement).style.outline).toBe("none");

    fireEvent.change(search, { target: { value: "recent" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear Chat search" }));

    expect((search as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(search);
    expect(screen.getByRole("dialog", { name: "Search chats" })).toBeTruthy();
  });

  it("navigates bounded canonical Chat search results without creating a thread", async () => {
    const global = record("chat_global_deploy", "Deploy release", {
      updatedAt: "2026-08-28T11:00:00.000Z",
    });
    const inProject = record("chat_project_deploy", "Deploy release", {
      projectId: "project_alpha_id",
      updatedAt: "2026-08-28T12:00:00.000Z",
    });
    const client = {
      list: vi.fn(async () => ({ items: [global, inProject] })),
    } as unknown as CanonicalChatClient;
    const actions = {
      onNewGlobalChat: vi.fn(),
      onCreateProject: vi.fn(),
      onNewProjectChat: vi.fn(),
      onSelectChat: vi.fn(),
      onCollapse: vi.fn(),
    };
    render(<WorkRail client={client} projects={[alpha]} active {...actions} />);
    await screen.findAllByRole("button", { name: "Deploy release" });
    fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
    const search = screen.getByRole("searchbox", { name: "Search chats" });
    fireEvent.change(search, { target: { value: "deploy" } });

    const projectResult = screen.getByRole("option", { name: "Deploy release, Alpha" });
    const globalResult = screen.getByRole("option", { name: "Deploy release, Global" });
    expect(projectResult.getAttribute("aria-selected")).toBe("true");
    expect(globalResult.getAttribute("aria-selected")).toBe("false");
    expect(search.getAttribute("aria-activedescendant")).toBe(projectResult.id);
    expect(search.getAttribute("aria-autocomplete")).toBe("list");
    expect(search.getAttribute("aria-expanded")).toBe("true");
    expect(projectResult.tabIndex).toBe(-1);
    expect(globalResult.tabIndex).toBe(-1);

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(globalResult.getAttribute("aria-selected")).toBe("true");
    expect(search.getAttribute("aria-activedescendant")).toBe(globalResult.id);
    fireEvent.keyDown(search, { key: "Enter" });

    expect(actions.onSelectChat).toHaveBeenCalledWith(global);
    expect(actions.onNewGlobalChat).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
  });

  it("routes a Project search result and dismisses the modal with Escape", async () => {
    const { actions } = setup();
    await screen.findByRole("button", { name: "Recent global" });
    fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
    const search = screen.getByRole("searchbox", { name: "Search chats" });
    fireEvent.change(search, { target: { value: "alpha" } });
    fireEvent.click(screen.getByRole("option", { name: "Alpha chat, Alpha" }));

    expect(actions.onSelectChat).toHaveBeenCalledWith(projectChat, alpha);
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
    const reopenedSearch = screen.getByRole("searchbox", { name: "Search chats" });
    expect((reopenedSearch as HTMLInputElement).value).toBe("");
    fireEvent.keyDown(reopenedSearch, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull();
  });

  it("shows no-result and stale-result states from the retained canonical index", async () => {
    const events = eventHarness();
    const client = {
      list: vi.fn()
        .mockResolvedValueOnce({ items: [recent] })
        .mockRejectedValueOnce(new Error("private refresh detail")),
    } as unknown as CanonicalChatClient;
    renderRail(client, events.eventSource);
    await screen.findByRole("button", { name: "Recent global" });
    fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
    const search = screen.getByRole("searchbox", { name: "Search chats" });
    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByText("No chats found.")).toBeTruthy();

    fireEvent.change(search, { target: { value: "" } });
    act(() => events.emit({ type: "chat.full_refresh", cursor: 2 }));

    expect(await screen.findByText("Showing recently loaded chats. Refresh failed.")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Recent global, Global" })).toBeTruthy();
  });

  it("keeps Chat search usable across initial loading and safe error states", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let rejectLoad!: (error: Error) => void;
    const pendingLoad = new Promise<never>((_resolve, reject) => { rejectLoad = reject; });
    const client = { list: vi.fn(() => pendingLoad) } as unknown as CanonicalChatClient;
    renderRail(client);
    fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
    const dialog = screen.getByRole("dialog", { name: "Search chats" });

    expect(within(dialog).getByText("Loading chats…")).toBeTruthy();

    await act(async () => {
      rejectLoad(new Error("private gateway detail"));
      await pendingLoad.catch(() => {});
    });

    expect((await within(dialog).findByRole("alert")).textContent).toBe("Chats could not be loaded.");
  });

  it("refreshes the same Chat id across Global to Project and Project to Project routes", async () => {
    const global = record("chat_moved", "Moved chat", {
      updatedAt: "2026-08-28T14:00:00.000Z",
    });
    const inAlpha = { ...global, projectId: "project_alpha_id" };
    const inBeta = { ...global, projectId: "project_beta_id" };
    const client = {
      list: vi.fn()
        .mockResolvedValueOnce({ items: [global] })
        .mockResolvedValueOnce({ items: [inAlpha] })
        .mockResolvedValueOnce({ items: [inBeta] }),
    } as unknown as CanonicalChatClient;
    const actions = {
      onNewGlobalChat: vi.fn(),
      onCreateProject: vi.fn(),
      onNewProjectChat: vi.fn(),
      onSelectChat: vi.fn(),
      onCollapse: vi.fn(),
    };
    const { rerender } = render(
      <WorkRail
        client={client}
        projects={[alpha, beta]}
        active
        activeChatId="chat_moved"
        {...actions}
      />,
    );
    expect(await screen.findByRole("button", { name: "Moved chat" })).toBeTruthy();

    rerender(
      <WorkRail
        client={client}
        projects={[alpha, beta]}
        active
        activeChatId="chat_moved"
        activeProjectSlug="alpha"
        {...actions}
      />,
    );
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    const alphaRow = screen.getByRole("button", { name: "Alpha" });
    fireEvent.click(alphaRow);
    expect(within(alphaRow.parentElement!.parentElement!).getByRole("button", { name: "Moved chat" })).toBeTruthy();

    rerender(
      <WorkRail
        client={client}
        projects={[alpha, beta]}
        active
        activeChatId="chat_moved"
        activeProjectSlug="beta"
        {...actions}
      />,
    );
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(3));
    const betaRow = screen.getByRole("button", { name: "Beta" });
    fireEvent.click(betaRow);
    expect(within(betaRow.parentElement!.parentElement!).getByRole("button", { name: "Moved chat" })).toBeTruthy();
  });

  it("loads bounded canonical Chat pages without a Project filter", async () => {
    const older = record("chat_older", "Older chat", {
      updatedAt: "2026-08-27T10:00:00.000Z",
    });
    const client = {
      list: vi.fn()
        .mockResolvedValueOnce({ items: [recent], nextCursor: "chatcur_page2" })
        .mockResolvedValueOnce({ items: [older] }),
    } as unknown as CanonicalChatClient;
    render(
      <WorkRail
        client={client}
        projects={[alpha]}
        active
        onNewGlobalChat={vi.fn()}
        onCreateProject={vi.fn()}
        onNewProjectChat={vi.fn()}
        onSelectChat={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: "Older chat" })).toBeTruthy();
    expect(client.list).toHaveBeenNthCalledWith(1, { limit: 100 });
    expect(client.list).toHaveBeenNthCalledWith(2, { limit: 100, cursor: "chatcur_page2" });
  });

  it("logs a classified initial-load failure while showing the safe rail error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = {
      list: vi.fn(async () => { throw new TypeError("private gateway detail"); }),
    } as unknown as CanonicalChatClient;
    render(
      <WorkRail
        client={client}
        projects={[alpha]}
        active
        onNewGlobalChat={vi.fn()}
        onCreateProject={vi.fn()}
        onNewProjectChat={vi.fn()}
        onSelectChat={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toBe("Chats could not be loaded.");
    expect(warn).toHaveBeenCalledWith("[work] Chat list load failed:", "TypeError");
  });

  it("reloads the canonical list when the retained Work route selects a new Chat", async () => {
    const created = record("chat_created", "Created chat", {
      updatedAt: "2026-08-28T13:00:00.000Z",
    });
    const client = {
      list: vi.fn()
        .mockResolvedValueOnce({ items: [recent] })
        .mockResolvedValueOnce({ items: [created, recent] }),
    } as unknown as CanonicalChatClient;
    const actions = {
      onNewGlobalChat: vi.fn(),
      onCreateProject: vi.fn(),
      onNewProjectChat: vi.fn(),
      onSelectChat: vi.fn(),
      onCollapse: vi.fn(),
    };
    const { rerender } = render(
      <WorkRail client={client} projects={[alpha]} active {...actions} />,
    );
    expect(await screen.findByRole("button", { name: "Recent global" })).toBeTruthy();

    rerender(
      <WorkRail
        client={client}
        projects={[alpha]}
        active
        activeChatId="chat_created"
        {...actions}
      />,
    );

    expect(await screen.findByRole("button", { name: "Created chat" })).toBeTruthy();
  });

  it("keeps section and Project disclosure state independent", async () => {
    setup();
    expect(await screen.findByRole("button", { name: "Pinned global" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recent global" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Alpha chat" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(screen.getByRole("button", { name: "Alpha chat" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Pinned" }));
    expect(screen.queryByRole("button", { name: "Pinned global" })).toBeNull();
    expect(screen.getByRole("button", { name: "Alpha chat" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recent global" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
    expect(screen.getByRole("button", { name: "Recent global" })).toBeTruthy();
  });

  it("exposes keyboard-reachable global, Project, Chat, and collapse actions without Board", async () => {
    const { actions } = setup();
    await screen.findByRole("button", { name: "Pinned global" });

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));

    const compose = screen.getByRole("button", { name: "New chat in Alpha" });
    expect(screen.queryByRole("button", { name: "Open Alpha board" })).toBeNull();
    compose.focus();
    expect(document.activeElement).toBe(compose);
    expect(compose.className).toContain("focus-visible");
    expect(compose.parentElement?.className).toContain("group-focus-within/project:opacity-100");
    fireEvent.click(compose);
    fireEvent.click(screen.getByRole("button", { name: "Hide Chat navigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Alpha chat" }));

    expect(actions.onNewGlobalChat).toHaveBeenCalledOnce();
    expect(actions.onCreateProject).toHaveBeenCalledOnce();
    expect(actions.onNewProjectChat).toHaveBeenCalledWith(alpha);
    expect(actions.onCollapse).toHaveBeenCalledOnce();
    expect(actions.onSelectChat).toHaveBeenCalledWith(projectChat, alpha);
  });

  it("pins and unpins through the canonical client and updates unique placement", async () => {
    const { client } = setup();
    await screen.findByRole("button", { name: "Recent global" });

    fireEvent.click(screen.getByRole("button", { name: "Pin Recent global" }));
    await waitFor(() => expect(client.updateUserState).toHaveBeenCalledWith("chat_recent", { pinned: true }));
    expect(await screen.findByRole("button", { name: "Unpin Recent global" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Unpin Pinned global" }));
    await waitFor(() => expect(client.updateUserState).toHaveBeenCalledWith("chat_pinned", { pinned: false }));
    expect(await screen.findByRole("button", { name: "Pin Pinned global" })).toBeTruthy();
  });

  it("logs a classified pin failure and restores the row action", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const records = [recent];
    const client = {
      list: vi.fn(async () => ({ items: records })),
      updateUserState: vi.fn(async () => { throw new Error("private gateway detail"); }),
    } as unknown as CanonicalChatClient;
    render(
      <WorkRail
        client={client}
        projects={[]}
        active
        onNewGlobalChat={vi.fn()}
        onCreateProject={vi.fn()}
        onNewProjectChat={vi.fn()}
        onSelectChat={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pin Recent global" }));
    await waitFor(() => expect(warn).toHaveBeenCalledWith(
      "[work] Chat pin update failed:",
      "Error",
    ));
    expect(screen.queryByText("Chats could not be loaded.")).toBeNull();
    expect(screen.getByText("Chat pin could not be updated.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Pin Recent global" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears a stale pin error after a successful route reload", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = {
      list: vi.fn(async () => ({ items: [recent] })),
      updateUserState: vi.fn(async () => { throw new Error("private gateway detail"); }),
    } as unknown as CanonicalChatClient;
    const props = {
      client,
      projects: [] as Project[],
      active: true,
      onNewGlobalChat: vi.fn(),
      onCreateProject: vi.fn(),
      onNewProjectChat: vi.fn(),
      onSelectChat: vi.fn(),
      onCollapse: vi.fn(),
    };
    const { rerender } = render(<WorkRail {...props} activeChatId="chat_before" />);

    fireEvent.click(await screen.findByRole("button", { name: "Pin Recent global" }));
    expect(await screen.findByText("Chat pin could not be updated.")).toBeTruthy();

    rerender(<WorkRail {...props} activeChatId="chat_after" />);
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Chat pin could not be updated.")).toBeNull());
    expect(warn).toHaveBeenCalledWith("[work] Chat pin update failed:", "Error");
  });

  it("clears a stale pin error when the next route reload fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = {
      list: vi.fn()
        .mockResolvedValueOnce({ items: [recent] })
        .mockRejectedValueOnce(new Error("route reload failed")),
      updateUserState: vi.fn(async () => { throw new Error("private gateway detail"); }),
    } as unknown as CanonicalChatClient;
    const props = {
      client,
      projects: [] as Project[],
      active: true,
      onNewGlobalChat: vi.fn(),
      onCreateProject: vi.fn(),
      onNewProjectChat: vi.fn(),
      onSelectChat: vi.fn(),
      onCollapse: vi.fn(),
    };
    const { rerender } = render(<WorkRail {...props} activeChatId="chat_before" />);

    fireEvent.click(await screen.findByRole("button", { name: "Pin Recent global" }));
    expect(await screen.findByText("Chat pin could not be updated.")).toBeTruthy();

    rerender(<WorkRail {...props} activeChatId="chat_after" />);
    expect(await screen.findByText("Chats could not be loaded.")).toBeTruthy();
    expect(screen.queryByText("Chat pin could not be updated.")).toBeNull();
  });

  it("does not surface a pin failure from a previous route", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let rejectPin!: (error: Error) => void;
    const pinRequest = new Promise<never>((_resolve, reject) => {
      rejectPin = reject;
    });
    const client = {
      list: vi.fn(async () => ({ items: [recent] })),
      updateUserState: vi.fn(() => pinRequest),
    } as unknown as CanonicalChatClient;
    const props = {
      client,
      projects: [] as Project[],
      active: true,
      onNewGlobalChat: vi.fn(),
      onCreateProject: vi.fn(),
      onNewProjectChat: vi.fn(),
      onSelectChat: vi.fn(),
      onCollapse: vi.fn(),
    };
    const { rerender } = render(<WorkRail {...props} activeChatId="chat_before" />);

    fireEvent.click(await screen.findByRole("button", { name: "Pin Recent global" }));
    await waitFor(() => expect(client.updateUserState).toHaveBeenCalledOnce());

    rerender(<WorkRail {...props} activeChatId="chat_after" />);
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    rerender(<WorkRail {...props} activeChatId="chat_before" />);
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(3));
    rejectPin(new Error("private gateway detail"));

    await waitFor(() => expect(warn).toHaveBeenCalledWith(
      "[work] Chat pin update failed:",
      "Error",
    ));
    expect(screen.queryByText("Chat pin could not be updated.")).toBeNull();
  });

  it("does not surface a pin failure from a replaced client", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let rejectPin!: (error: Error) => void;
    const pinRequest = new Promise<never>((_resolve, reject) => {
      rejectPin = reject;
    });
    const originalClient = {
      list: vi.fn(async () => ({ items: [recent] })),
      updateUserState: vi.fn(() => pinRequest),
    } as unknown as CanonicalChatClient;
    const replacementClient = {
      list: vi.fn(async () => ({ items: [recent] })),
      updateUserState: vi.fn(),
    } as unknown as CanonicalChatClient;
    const props = {
      projects: [] as Project[],
      active: true,
      activeChatId: "chat_same_route",
      onNewGlobalChat: vi.fn(),
      onCreateProject: vi.fn(),
      onNewProjectChat: vi.fn(),
      onSelectChat: vi.fn(),
      onCollapse: vi.fn(),
    };
    const { rerender } = render(<WorkRail {...props} client={originalClient} />);

    fireEvent.click(await screen.findByRole("button", { name: "Pin Recent global" }));
    await waitFor(() => expect(originalClient.updateUserState).toHaveBeenCalledOnce());

    rerender(<WorkRail {...props} client={replacementClient} />);
    await waitFor(() => expect(replacementClient.list).toHaveBeenCalledOnce());
    rejectPin(new Error("private gateway detail"));

    await waitFor(() => expect(screen.getByRole("button", { name: "Pin Recent global" })).toBeTruthy());
    expect(screen.queryByText("Chat pin could not be updated.")).toBeNull();
  });

  it("does not apply a stale pin success or clear replacement pin progress", async () => {
    let resolveOriginalPin!: (record: CanonicalChatRecord) => void;
    const originalPinRequest = new Promise<CanonicalChatRecord>((resolve) => {
      resolveOriginalPin = resolve;
    });
    const replacementPinRequest = new Promise<CanonicalChatRecord>(() => {});
    const originalClient = {
      list: vi.fn(async () => ({ items: [recent] })),
      updateUserState: vi.fn(() => originalPinRequest),
    } as unknown as CanonicalChatClient;
    const replacementClient = {
      list: vi.fn(async () => ({ items: [recent] })),
      updateUserState: vi.fn(() => replacementPinRequest),
    } as unknown as CanonicalChatClient;
    const props = {
      projects: [] as Project[],
      active: true,
      activeChatId: "chat_same_route",
      onNewGlobalChat: vi.fn(),
      onCreateProject: vi.fn(),
      onNewProjectChat: vi.fn(),
      onSelectChat: vi.fn(),
      onCollapse: vi.fn(),
    };
    const { rerender } = render(<WorkRail {...props} client={originalClient} />);

    fireEvent.click(await screen.findByRole("button", { name: "Pin Recent global" }));
    await waitFor(() => expect(originalClient.updateUserState).toHaveBeenCalledOnce());

    rerender(<WorkRail {...props} client={replacementClient} />);
    await waitFor(() => expect(replacementClient.list).toHaveBeenCalledOnce());
    const replacementPin = await screen.findByRole("button", { name: "Pin Recent global" });
    await waitFor(() => expect((replacementPin as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(replacementPin);
    await waitFor(() => expect(replacementClient.updateUserState).toHaveBeenCalledOnce());

    await act(async () => {
      resolveOriginalPin(record("chat_recent", "Recent global", {
        pinned: true,
        updatedAt: "2026-08-28T10:01:00.000Z",
      }));
      await originalPinRequest;
    });

    expect(screen.queryByRole("button", { name: "Unpin Recent global" })).toBeNull();
    expect((screen.getByRole("button", { name: "Pin Recent global" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("invalidates a pending pin across an away-and-back tab round-trip", async () => {
    let resolveOriginalPin!: (record: CanonicalChatRecord) => void;
    const originalPinRequest = new Promise<CanonicalChatRecord>((resolve) => {
      resolveOriginalPin = resolve;
    });
    const replacementPinRequest = new Promise<CanonicalChatRecord>(() => {});
    const client = {
      list: vi.fn(async () => ({ items: [recent] })),
      updateUserState: vi.fn()
        .mockImplementationOnce(() => originalPinRequest)
        .mockImplementationOnce(() => replacementPinRequest),
    } as unknown as CanonicalChatClient;
    const props = {
      client,
      projects: [] as Project[],
      activeChatId: "chat_same_route",
      onNewGlobalChat: vi.fn(),
      onCreateProject: vi.fn(),
      onNewProjectChat: vi.fn(),
      onSelectChat: vi.fn(),
      onCollapse: vi.fn(),
    };
    const { rerender } = render(<WorkRail {...props} active />);

    fireEvent.click(await screen.findByRole("button", { name: "Pin Recent global" }));
    await waitFor(() => expect(client.updateUserState).toHaveBeenCalledOnce());

    rerender(<WorkRail {...props} active={false} />);
    rerender(<WorkRail {...props} active />);
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    const replacementPin = await screen.findByRole("button", { name: "Pin Recent global" });
    await waitFor(() => expect((replacementPin as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(replacementPin);
    await waitFor(() => expect(client.updateUserState).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveOriginalPin(record("chat_recent", "Recent global", {
        pinned: true,
        updatedAt: "2026-08-28T10:01:00.000Z",
      }));
      await originalPinRequest;
    });

    expect(screen.queryByRole("button", { name: "Unpin Recent global" })).toBeNull();
    expect((screen.getByRole("button", { name: "Pin Recent global" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows Pin and Delete in the Chat context menu", async () => {
    setup();
    const recentChat = await screen.findByRole("button", { name: "Recent global" });

    fireEvent.contextMenu(recentChat, { clientX: 120, clientY: 160 });

    expect(await screen.findByRole("menuitem", { name: "Pin" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });

  it("deletes a Chat from its hover action after confirmation", async () => {
    const { client } = setup();
    await screen.findByRole("button", { name: "Recent global" });

    fireEvent.click(screen.getByRole("button", { name: "Delete Recent global" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));

    await waitFor(() => expect(client.delete).toHaveBeenCalledWith(
      "chat_recent",
      expect.any(String),
    ));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Recent global" })).toBeNull());
  });

  it("ignores a delayed Chat deletion after the rail route scope changes", async () => {
    let resolveDelete!: (value: { chatId: string; deletedAt: string }) => void;
    const pendingDelete = new Promise<{ chatId: string; deletedAt: string }>((resolve) => {
      resolveDelete = resolve;
    });
    const client = {
      list: vi.fn(async () => ({ items: [recent] })),
      delete: vi.fn(() => pendingDelete),
    } as unknown as CanonicalChatClient;
    const onChatDeleted = vi.fn();
    const props = {
      client,
      projects: [] as Project[],
      active: true,
      onNewGlobalChat: vi.fn(),
      onCreateProject: vi.fn(),
      onNewProjectChat: vi.fn(),
      onSelectChat: vi.fn(),
      onCollapse: vi.fn(),
      onChatDeleted,
    };
    const { rerender } = render(
      <WorkRail {...props} activeChatId="chat_original_scope" />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Delete Recent global" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));
    await waitFor(() => expect(client.delete).toHaveBeenCalledOnce());

    rerender(<WorkRail {...props} activeChatId="chat_replacement_scope" />);
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveDelete({
        chatId: recent.chat.id,
        deletedAt: "2026-08-28T13:00:00.000Z",
      });
      await pendingDelete;
    });

    expect(screen.getByRole("button", { name: "Recent global" })).toBeTruthy();
    expect(onChatDeleted).not.toHaveBeenCalled();
  });

  it("opens Project deletion from both hover and right-click actions", async () => {
    setup();
    const project = await screen.findByRole("button", { name: "Alpha" });

    expect(screen.getByRole("button", { name: "Delete Alpha project" })).toBeTruthy();
    fireEvent.contextMenu(project, { clientX: 100, clientY: 140 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    expect(await screen.findByRole("alertdialog", { name: "Delete project permanently?" })).toBeTruthy();
  });
});
