// @vitest-environment jsdom
import React, { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatAgentsWorkspace, clearChatNavigationScopes, useChatAgentsNavigation } from "@matrix-os/ui";
import type { CanonicalChatNavigationResponse, CanonicalChatRecord } from "@matrix-os/contracts";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { AppError } from "@desktop/shared/app-error";
import { WorkRail } from "@desktop/renderer/src/features/work/WorkRail";
import { useWorkNavigation } from "@desktop/renderer/src/features/work/use-work-navigation";
import type { Project } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";

const initialConnection = useConnection.getState();
beforeEach(() => {
  useConnection.setState({ status: "signed-in", userId: "bot-authority-fixture", platformHost: "https://platform.test", runtimeSlot: "primary", authGeneration: 1, organizationStatus: "none", organizationId: null });
});
afterEach(() => {
  cleanup();
  clearChatNavigationScopes();
  useConnection.setState(initialConnection);
  localStorage.clear();
  vi.restoreAllMocks();
});
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function navigation(): CanonicalChatNavigationResponse {
  return { version: 1, truncated: false, items: [{
    chat: { id: "chat_private_bot", title: "Private bot transcript", titleVersion: 1, revision: 1, lifecycle: "active", attention: "none", messageCount: 0, createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" },
    readState: { version: 0, unread: false, markedUnread: false, latestIncomingSeq: 0, readThroughSeq: 0 },
    classification: { kind: "bot", agentId: "bot_private00" }, persistence: "personal",
  }] };
}
const approvals = [{ kind: "approval", status: "pending", agentId: "bot_private00", chatId: "chat_private_bot", expiresAt: "2099-01-01T00:00:00Z" }];
function fixture(withOrdinary = false, projects: Project[] = [], projectId?: string) {
  const initial = navigation();
  if (withOrdinary) initial.items.push({ ...initial.items[0]!,
    chat: { ...initial.items[0]!.chat, id: "chat_private_ordinary", title: "Private pending Chat", userState: { readThroughSeq: 0, pinned: true, muted: false } }, classification: { kind: "ordinary" }, projectId,
  });
  const client = {
    navigation: vi.fn(async () => initial),
    delete: vi.fn(async () => ({ chatId: "chat_private_ordinary", deletedAt: "2026-10-08T01:00:00Z" })),
    agents: {
      list: vi.fn(async () => ({ enabled: true, agents: [{ id: "bot_private00", name: "Old private bot", recipeRef: { recipeId: "research", version: 1 } }] })),
      bots: {
        directChat: vi.fn(async () => "chat_private_bot"),
        directBot: vi.fn(async () => "bot_private00"),
        tasks: vi.fn(async () => []),
        interactions: vi.fn(async () => approvals),
        ensureDirectChat: vi.fn(async () => "chat_private_bot"),
      },
    },
  } as unknown as CanonicalChatClient;
  let captured: ReturnType<typeof useWorkNavigation>;
  let capturedAgents: ReturnType<typeof useChatAgentsNavigation>;
  function Probe() {
    const state = useWorkNavigation(client, undefined, true);
    const agents = useChatAgentsNavigation();
    useLayoutEffect(() => { captured = state; capturedAgents = agents; }, [state, agents]);
    return null;
  }
  const actions = { onNewGlobalChat: vi.fn(), onCreateProject: vi.fn(), onNewProjectChat: vi.fn(), onSelectChat: vi.fn(), onCollapse: vi.fn(), onOpenBotChat: vi.fn(), onChatDeleted: vi.fn(), onChatRenamed: vi.fn(), onOpenAgents: vi.fn(), onStartAgentChat: vi.fn() };
  const view = (activeChatId?: string, currentProjects = projects) => <ChatAgentsWorkspace><WorkRail client={client} projects={currentProjects} active activeChatId={activeChatId} {...actions} /><Probe /></ChatAgentsWorkspace>;
  const rendered = render(view());
  return { client, actions, agents: () => capturedAgents, store: () => captured!.store!, rerender: (id?: string, currentProjects = projects) => rendered.rerender(view(id, currentProjects)) };
}
async function loaded() {
  await screen.findByRole("button", { name: "Review Old private bot approval" });
  await screen.findByRole("button", { name: "Chat with Old private bot" });
  expect(screen.getByLabelText("1 pending approvals")).toBeTruthy();
}
function expectNoOldData() {
  expect(screen.queryAllByText("Old private bot")).toEqual([]);
  expect(screen.queryByRole("button", { name: "Review Old private bot approval" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Chat with Old private bot" })).toBeNull();
  expect(screen.queryByLabelText("1 pending approvals")).toBeNull();
}

it("hides names and approval counts through revoked navigation, even when the Agent API still succeeds", async () => {
  const { client, store } = fixture();
  await loaded();
  const libraryCalls = vi.mocked(client.agents!.list).mock.calls.length;
  act(() => store().revoke());
  expectNoOldData();
  const recovery = pending<CanonicalChatNavigationResponse>();
  vi.mocked(client.navigation!).mockImplementationOnce(() => recovery.promise);
  let refresh!: Promise<void>;
  act(() => { refresh = store().refresh(); });
  expectNoOldData();
  await act(async () => { recovery.reject(new AppError("server")); await refresh; });
  expectNoOldData();
  expect(client.agents!.list).toHaveBeenCalledTimes(libraryCalls);
});

it("does not resurrect old Agent names or pending approvals during failed Agent recovery after fresh navigation", async () => {
  const { client, store } = fixture();
  await loaded();
  const library = pending<Awaited<ReturnType<NonNullable<CanonicalChatClient["agents"]>["list"]>>>();
  vi.mocked(client.agents!.list).mockImplementation(() => library.promise);
  act(() => store().revoke());
  await act(async () => { await store().refresh(); });
  expectNoOldData();
  await act(async () => library.reject(new AppError("server")));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Review Old private bot approval" })).toBeNull());
  expectNoOldData();
});

it("rejects late pre-revocation Bot attention callbacks", async () => {
  const { client, store } = fixture();
  await loaded();
  const attention = pending<typeof approvals>();
  vi.mocked(client.agents!.bots!.interactions).mockImplementation(() => attention.promise);
  const calls = vi.mocked(client.agents!.bots!.interactions).mock.calls.length;
  act(() => window.dispatchEvent(new FocusEvent("focus")));
  await waitFor(() => expect(vi.mocked(client.agents!.bots!.interactions).mock.calls.length).toBeGreaterThan(calls));
  await act(async () => { store().revoke(); attention.resolve(approvals); });
  expectNoOldData();
});

it("preserves the same authority's Bot library across ordinary Chat selection", async () => {
  const { client, rerender } = fixture();
  await loaded();
  const libraryCalls = vi.mocked(client.agents!.list).mock.calls.length;
  rerender("chat_other");
  rerender("chat_private_bot");
  await waitFor(() => expect(screen.getByRole("button", { name: "Review Old private bot approval" })).toBeTruthy());
  expect(client.agents!.list).toHaveBeenCalledTimes(libraryCalls);
});

it("discards a saved Chat deletion target on revocation and does not reopen it during recovery", async () => {
  const { store } = fixture(true);
  fireEvent.contextMenu(await screen.findByRole("button", { name: "Private pending Chat" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  expect(screen.getByRole("alertdialog", { name: "Delete Private pending Chat?" })).toBeTruthy();
  act(() => store().revoke());
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await act(async () => { await store().refresh(); });
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("rejects a late deletion after same-store revoke and recovery", async () => {
  const { client, actions, store } = fixture(true);
  const deletion = pending<Awaited<ReturnType<CanonicalChatClient["delete"]>>>();
  vi.mocked(client.delete).mockImplementation(() => deletion.promise);
  fireEvent.contextMenu(await screen.findByRole("button", { name: "Private pending Chat" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));
  await waitFor(() => expect(client.delete).toHaveBeenCalledOnce());
  act(() => store().revoke());
  await act(async () => { await store().refresh(); });
  await act(async () => deletion.resolve({ chatId: "chat_private_ordinary", deletedAt: "2026-10-08T01:00:00Z" }));
  expect(screen.getByRole("button", { name: "Private pending Chat" })).toBeTruthy();
  expect(actions.onChatDeleted).not.toHaveBeenCalled();
});

it("fences deletion callbacks immediately when revocation occurs before React rerenders", async () => {
  const { client, actions, store } = fixture(true);
  const deletion = pending<Awaited<ReturnType<CanonicalChatClient["delete"]>>>();
  vi.mocked(client.delete).mockImplementation(() => deletion.promise);
  fireEvent.contextMenu(await screen.findByRole("button", { name: "Private pending Chat" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));
  await act(async () => {
    store().revoke();
    deletion.resolve({ chatId: "chat_private_ordinary", deletedAt: "2026-10-08T01:00:00Z" });
  });
  expect(actions.onChatDeleted).not.toHaveBeenCalled();
});

it("opens Agents with the raw host client identity and closes the old panel on revocation", async () => {
  const { client, agents, store } = fixture();
  await loaded();
  fireEvent.click(screen.getByRole("button", { name: "Agents" }));
  expect(agents()?.opened?.client).toBe(client.agents);
  act(() => store().revoke());
  expect(agents()?.opened).toBeNull();
  await act(async () => { await store().refresh(); });
  await screen.findByRole("button", { name: "Chat with Old private bot" });
  fireEvent.click(screen.getByRole("button", { name: "Agents" }));
  expect(agents()?.opened?.client).toBe(client.agents);
});

it("fences a pending Agent opener synchronously at the navigation epoch boundary", async () => {
  const { client, actions, store } = fixture();
  await loaded();
  const opening = pending<string>();
  vi.mocked(client.agents!.bots!.ensureDirectChat).mockImplementation(() => opening.promise);
  fireEvent.click(screen.getByRole("button", { name: "Chat with Old private bot" }));
  await waitFor(() => expect(client.agents!.bots!.ensureDirectChat).toHaveBeenCalledOnce());
  await act(async () => { store().revoke(); opening.resolve("chat_private_bot"); });
  expect(actions.onOpenBotChat).not.toHaveBeenCalled();
  expectNoOldData();
});

for (const revoked of [false, true]) {
  it.each(["pin", "read", "delete", "rename"] as const)(`publishes accepted %s only within its captured authority (revoked=${revoked})`, async action => {
    const { client, actions, store, rerender } = fixture(true);
    await screen.findByRole("button", { name: "Private pending Chat" });
    const previous = store().getSnapshot().items.find(item => item.chat.id === "chat_private_ordinary")!;
    const response = pending<CanonicalChatRecord>();
    const deletion = pending<Awaited<ReturnType<CanonicalChatClient["delete"]>>>();
    client.updateUserState = vi.fn(() => response.promise);
    client.updateReadState = vi.fn(() => response.promise);
    client.updateTitle = vi.fn(() => response.promise);
    client.delete = vi.fn(() => deletion.promise);
    if (action === "pin") fireEvent.click(screen.getByRole("button", { name: "Unpin Private pending Chat" }));
    else {
      fireEvent.contextMenu(screen.getByRole("button", { name: "Private pending Chat" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: action === "read" ? "Mark as unread" : action === "delete" ? "Delete" : "Rename" }));
      if (action === "delete") fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));
      if (action === "rename") {
        const input = await screen.findByRole("textbox", { name: "Rename Private pending Chat" });
        fireEvent.change(input, { target: { value: "Accepted renamed Chat" } });
        fireEvent.keyDown(input, { key: "Enter" });
      }
    }
    const mutation = action === "pin" ? client.updateUserState : action === "read" ? client.updateReadState : action === "delete" ? client.delete : client.updateTitle;
    await waitFor(() => expect(mutation).toHaveBeenCalledOnce());
    if (revoked) {
      act(() => store().revoke());
      await act(async () => { await store().refresh(); });
    } else rerender("chat_other_selected");
    const updated = { ...previous, chat: { ...previous.chat, revision: 2,
      title: action === "rename" ? "Accepted renamed Chat" : previous.chat.title, titleVersion: action === "rename" ? 2 : previous.chat.titleVersion,
      userState: { readThroughSeq: 0, muted: false, pinned: action !== "pin" },
    }, readState: { ...previous.readState, version: 1, unread: true, markedUnread: true } };
    await act(async () => {
      if (action === "delete") deletion.resolve({ chatId: previous.chat.id, deletedAt: "2026-10-08T01:00:00Z" });
      else response.resolve(updated);
    });
    const current = store().getSnapshot().items.find(item => item.chat.id === previous.chat.id);
    if (revoked) expect(current).toEqual(previous);
    else if (action === "delete") expect(current).toBeUndefined();
    else if (action === "pin") expect(current?.chat.userState?.pinned).toBe(false);
    else if (action === "read") expect(current?.readState.markedUnread).toBe(true);
    else expect(current?.chat.title).toBe("Accepted renamed Chat");
    expect(actions.onChatDeleted).not.toHaveBeenCalled();
    expect(actions.onChatRenamed).not.toHaveBeenCalled();
  });
}

async function pendingSelection(context: ReturnType<typeof fixture>) {
  const detail = pending<Awaited<ReturnType<CanonicalChatClient["getDetail"]>>>();
  context.client.getDetail = vi.fn(() => detail.promise);
  fireEvent.click(await screen.findByRole("button", { name: "Private pending Chat" }));
  await waitFor(() => expect(context.client.getDetail).toHaveBeenCalledOnce());
  const record = context.store().getSnapshot().items.find(item => item.chat.id === "chat_private_ordinary")!;
  return { detail, record };
}

it.each(["library", "draft", "bot"] as const)("a later %s intent cancels a pending ordinary Chat detail", async intent => {
  const context = fixture(true);
  await loaded();
  if (intent === "draft") fireEvent.click(screen.getByRole("button", { name: "Add new agent" }));
  const { detail, record } = await pendingSelection(context);
  let binding: ReturnType<typeof pending<string>> | undefined;
  if (intent === "library") fireEvent.click(screen.getByRole("button", { name: "Agents" }));
  if (intent === "draft") act(() => context.agents()?.opened?.onStartChat?.("Make a research agent"));
  if (intent === "bot") {
    binding = pending<string>();
    vi.mocked(context.client.agents!.bots!.ensureDirectChat).mockImplementation(() => binding!.promise);
    fireEvent.click(screen.getByRole("button", { name: "Chat with Old private bot" }));
    await waitFor(() => expect(context.client.agents!.bots!.ensureDirectChat).toHaveBeenCalledOnce());
  }
  await act(async () => detail.resolve({ record } as Awaited<ReturnType<CanonicalChatClient["getDetail"]>>));
  expect(context.actions.onSelectChat).not.toHaveBeenCalled();
  if (intent === "library") expect(context.agents()?.opened?.client).toBe(context.client.agents);
  if (intent === "draft") expect(context.actions.onStartAgentChat).toHaveBeenCalledExactlyOnceWith("Make a research agent");
  if (binding) {
    await act(async () => binding!.resolve("chat_private_bot"));
    expect(context.actions.onOpenBotChat).toHaveBeenCalledExactlyOnceWith("chat_private_bot");
  }
});

it.each(["project_beta", undefined, "project_unknown"])("opens fresh Project membership %s instead of cached Alpha", async projectId => {
  const alpha: Project = { id: "project_alpha", slug: "alpha", name: "Alpha", kind: "folder" };
  const beta: Project = { id: "project_beta", slug: "beta", name: "Beta", kind: "folder" };
  const context = fixture(true, [alpha], alpha.id);
  const { detail, record } = await pendingSelection(context);
  context.rerender(undefined, [alpha, beta]);
  const fresh = { ...record, projectId };
  await act(async () => detail.resolve({ record: fresh } as Awaited<ReturnType<CanonicalChatClient["getDetail"]>>));
  if (projectId === beta.id) expect(context.actions.onSelectChat).toHaveBeenCalledExactlyOnceWith(fresh, beta);
  else expect(context.actions.onSelectChat).toHaveBeenCalledExactlyOnceWith(fresh);
});
