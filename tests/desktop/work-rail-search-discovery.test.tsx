// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkRailSearchDialog } from "@desktop/renderer/src/features/work/WorkRailSearchDialog";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
const api = vi.hoisted(() => ({ get: vi.fn(), release: vi.fn() }));
vi.mock("@desktop/renderer/src/lib/collaboration", () => ({ createDesktopCollaborationApi: () => api, releaseDesktopCollaborationApi: api.release }));
beforeEach(() => {
  useConnection.setState({ ...useConnection.getInitialState(), userId: "actor_me", platformHost: "https://platform.test" }, true);
  useTabs.setState(useTabs.getInitialState(), true);
  api.get.mockResolvedValue({ items: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const project = { id: "project_alpha", slug: "alpha", name: "Alpha", kind: "folder" as const };
const projectScopeId = "10000000-0000-4000-8000-000000000101";
const acceptedProject = (withOverview: boolean) => ({
  scopeId: projectScopeId,
  runtimeId: "vps:11111111-1111-4111-8111-111111111111",
  ownerId: "actor_owner",
  kind: "project",
  authorityGeneration: 1,
  status: "accepted",
  resource: {
    scope: {
      id: projectScopeId, ownerId: "actor_owner", kind: "project", resourceId: "project_shared",
      membershipMode: "direct", lifecycle: "shared", revision: "1", authEpoch: "1",
      authorityGeneration: "1", role: "editor",
      capabilities: { read: true, discuss: true, manageMembers: false, requestAi: false,
        observeTerminal: false, controlTerminal: false, stopTerminal: false },
    },
    project: { id: "project_shared", scopeId: projectScopeId, status: "active", resources: [] },
    ...(withOverview ? { overview: { projectId: "project_shared", scopeId: projectScopeId,
      name: "Rail project", status: "active", chats: [] } } : {}),
  },
});
describe("Work search discovery", () => {
  it.each([false, true])("preserves the selected source on every server search page (archived: %s)", async archived => {
    const row = (source: "claude" | "codex" | undefined, page: number) => ({
      chat: { id: `chat_${source ?? "native"}_${page}`, title: `Match ${source ?? "native"} ${page}`, lifecycle: archived ? "archived" : "active", revision: 1, updatedAt: "2026-11-12T00:00:00.000Z", createdAt: "2026-11-12T00:00:00.000Z" },
      ...(source ? { importSource: { harness: source } } : {}),
    });
    const page = vi.fn(async (_query: unknown, input?: { cursor?: string }) => ({
      items: [row("claude", input?.cursor ? 2 : 1), row("codex", input?.cursor ? 2 : 1), row(undefined, input?.cursor ? 2 : 1)],
      nextCursor: input?.cursor ? null : "next",
    }));
    const client = { search: page, list: (input: { cursor?: string }) => page("", input) } as unknown as CanonicalChatClient;
    const props = { open: true, records: [], projects: [], status: "ready" as const, client, onClose: vi.fn(), onSelect: vi.fn() };
    const view = render(<WorkRailSearchDialog {...props} {...{ sourceFilter: "claude" as const }} />);
    if (archived) fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    else fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Match" } });
    await screen.findByRole("option", { name: "Match claude 1, Global" });
    expect(screen.queryByRole("option", { name: "Match codex 1, Global" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Match native 1, Global" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more results" }));
    await screen.findByRole("option", { name: "Match claude 2, Global" });
    expect(screen.queryByRole("option", { name: "Match codex 2, Global" })).toBeNull();
    view.rerender(<WorkRailSearchDialog {...props} {...{ sourceFilter: "codex" as const }} />);
    expect(screen.getByRole("option", { name: "Match codex 2, Global" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Match claude 1, Global" })).toBeNull();
  });
  it("keeps Search inside a smaller window even when the main-pane center is offset", () => {
    render(<WorkRailSearchDialog open centerX={490} bounds={{left:0,right:740}} records={[]} projects={[]} status="ready" client={null} onClose={vi.fn()} onSelect={vi.fn()}/>);
    expect(screen.getByRole("dialog",{name:"Search chats"}).style.left).toBe("424px");
  });
  it("centers Search in its supplied main pane while keeping delete confirmation viewport-centered", async () => {
    const archived = { chat: { id: "chat_position", title: "Positioned chat", lifecycle: "archived", revision: 1, updatedAt: "2026-11-12T00:00:00.000Z", createdAt: "2026-11-12T00:00:00.000Z" } };
    const client = { list: vi.fn(async () => ({ items: [archived] })) } as unknown as CanonicalChatClient;
    render(<WorkRailSearchDialog open centerX={876} records={[]} projects={[]} status="ready" client={client} onClose={vi.fn()} onSelect={vi.fn()}/>);
    expect(screen.getByRole("dialog", { name: "Search chats" }).style.left).toBe("876px");
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete Positioned chat" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Delete archived chats?" });
    expect(confirmation.style.left).toBe("");
    expect(confirmation.classList.contains("left-1/2")).toBe(true);
  });
  it("drops an old client's pending archive error and allows the replacement client to restore", async () => {
    const record = (id: string) => ({ chat: { id, title: id, lifecycle: "archived", revision: 3, updatedAt: "2026-11-12T00:00:00.000Z", createdAt: "2026-11-12T00:00:00.000Z" } });
    let failOriginal!: (error: Error) => void;
    const original = {
      list: vi.fn(async () => ({ items: [record("chat_old_actor")] })),
      updateLifecycle: vi.fn(() => new Promise((_, reject) => { failOriginal = reject; })),
    } as unknown as CanonicalChatClient;
    const replacement = {
      list: vi.fn(async () => ({ items: [record("chat_replacement")] })),
      updateLifecycle: vi.fn(async () => ({ ...record("chat_replacement"), chat: { ...record("chat_replacement").chat, lifecycle: "active", revision: 4 } })),
    } as unknown as CanonicalChatClient;
    const changed = vi.fn();
    const props = { open: true, records: [], projects: [], status: "ready" as const, onClose: vi.fn(), onSelect: vi.fn(), onArchiveChanged: changed };
    const view = render(<WorkRailSearchDialog {...props} client={original}/>);
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore chat_old_actor" }));
    view.rerender(<WorkRailSearchDialog {...props} client={replacement}/>);
    await screen.findByRole("button", { name: "Restore chat_replacement" });
    await act(async () => { failOriginal(new Error("old private failure")); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Restore chat_replacement" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Restore chat_replacement" }));
    await waitFor(() => expect(screen.queryByRole("option", { name: "chat_replacement, Global" })).toBeNull());
    expect(changed).toHaveBeenCalledOnce();
  });

  it("clears a delete confirmation when the verified actor changes without replacing the client", async () => {
    const old = { chat: { id: "chat_old", title: "Old actor chat", lifecycle: "archived", revision: 3, updatedAt: "2026-11-12T00:00:00.000Z", createdAt: "2026-11-12T00:00:00.000Z" } };
    const remove = vi.fn(async () => ({}));
    const list = vi.fn(async () => ({ items: [old] }));
    const client = { list, delete: remove } as unknown as CanonicalChatClient;
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" client={client} onClose={vi.fn()} onSelect={vi.fn()}/>);
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete Old actor chat" }));
    expect(screen.getByRole("alertdialog", { name: "Delete archived chats?" })).toBeTruthy();
    list.mockImplementation(() => new Promise(() => {}));
    act(() => useConnection.setState({ userId: "replacement_actor" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Old actor chat" })).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not send the previous actor's search phrase to a replacement runtime authority", async () => {
    const search = vi.fn(async () => ({ items: [] }));
    const client = { search } as unknown as CanonicalChatClient;
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" client={client} onClose={vi.fn()} onSelect={vi.fn()}/>);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search chats" }), { target: { value: "private previous actor phrase" } });
    await waitFor(() => expect(search).toHaveBeenCalledOnce());
    act(() => useConnection.setState({ userId: "replacement_actor", authGeneration: 2 }));
    expect((screen.getByRole("searchbox", { name: "Search chats" }) as HTMLInputElement).value).toBe("");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    expect(search).toHaveBeenCalledOnce();
  });

  it("does not reinsert a restored archive when an older page request finishes later", async () => {
    const row = (id: string) => ({ chat: { id, title: id, lifecycle: "archived", revision: 3, updatedAt: "2026-11-12T00:00:00.000Z", createdAt: "2026-11-12T00:00:00.000Z" } });
    let finishPage!: (page: unknown) => void;
    const list = vi.fn((input: { cursor?: string }) => input.cursor
      ? new Promise(resolve => { finishPage = resolve; })
      : Promise.resolve({ items: [row("chat_restoring")], nextCursor: "next" }));
    const updateLifecycle = vi.fn(async () => ({ ...row("chat_restoring"), chat: { ...row("chat_restoring").chat, lifecycle: "active", revision: 4 } }));
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" client={{ list, updateLifecycle } as unknown as CanonicalChatClient} onClose={vi.fn()} onSelect={vi.fn()}/>);
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    await screen.findByRole("option", { name: "chat_restoring, Global" });
    fireEvent.click(screen.getByRole("button", { name: "Show more results" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore chat_restoring" }));
    await waitFor(() => expect(screen.queryByRole("option", { name: "chat_restoring, Global" })).toBeNull());
    await act(async () => { finishPage({ items: [row("chat_restoring"), row("chat_older")], nextCursor: null }); });
    expect(screen.queryByRole("option", { name: "chat_restoring, Global" })).toBeNull();
    expect((screen.getByRole("button", { name: "Show more results" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens the full archive page from Search without opening an archived conversation", async () => {
    const openArchive = vi.fn();
    const select = vi.fn();
    const list = vi.fn(async () => ({ items: [] }));
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" client={{ list } as unknown as CanonicalChatClient} onClose={vi.fn()} onSelect={select} {...{ onOpenArchivedList: openArchive }}/>);
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open the archived list" }));
    expect(openArchive).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
  });
  it("loads older archived chats beyond the first result page", async () => {
    const record = (id: string) => ({ chat: { id, title: id, lifecycle: "archived", revision: 1, archivedAt: id === "chat_recent" ? new Date().toISOString() : "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", createdAt: "2026-11-12T00:00:00.000Z" } });
    const list = vi.fn(async (input: { cursor?: string }) => input.cursor
      ? { items: [record("chat_older")], nextCursor: null }
      : { items: [record("chat_recent")], nextCursor: "cursor_next" });
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" client={{ list } as unknown as CanonicalChatClient} onClose={vi.fn()} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    expect(await screen.findByRole("option", { name: "chat_recent, Global" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "chat_recent, Global" }).textContent).toContain("Archived today");
    fireEvent.click(screen.getByRole("button", { name: "Show more results" }));
    expect(await screen.findByRole("option", { name: "chat_older, Global" })).toBeTruthy();
    expect(list).toHaveBeenCalledWith({ lifecycle: "archived", limit: 50, cursor: "cursor_next" });
  });
  it("keeps project-name chat matches alongside full-history server search", async () => {
    const record = { chat: { id: "chat_project_match", title: "Untitled", lifecycle: "active", revision: 1, updatedAt: "2026-11-12T00:00:00.000Z", createdAt: "2026-11-12T00:00:00.000Z" }, projectId: project.id };
    const search = vi.fn(async () => ({ items: [], nextCursor: null }));
    render(<WorkRailSearchDialog open records={[record] as never} projects={[project]} status="ready" client={{ search } as unknown as CanonicalChatClient} onClose={vi.fn()} onSelect={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search chats" }), { target: { value: "Alpha" } });
    await waitFor(() => expect(search).toHaveBeenCalled());
    expect(screen.getByRole("option", { name: "Untitled, Alpha" })).toBeTruthy();
  });
  it("restores an archived search result and confirms permanent deletion", async () => {
    const archived = { chat: { id: "chat_old", title: "Old chat", lifecycle: "archived", revision: 3, updatedAt: "2026-11-12T00:00:00.000Z", createdAt: "2026-11-12T00:00:00.000Z" } };
    const list = vi.fn(async () => ({ items: [archived] }));
    const updateLifecycle = vi.fn(async () => ({ ...archived, chat: { ...archived.chat, lifecycle: "active", revision: 4 } }));
    const remove = vi.fn(async () => ({ chatId: "chat_old", deletedAt: "2026-11-12T01:00:00.000Z" }));
    const client = { list, updateLifecycle, delete: remove } as unknown as CanonicalChatClient;
    const changed = vi.fn();
    const restored = vi.fn();
    const props = { records: [], projects: [], status: "ready" as const, client, onClose: vi.fn(), onSelect: vi.fn(), onArchiveChanged: changed, onArchiveRestored: restored };
    const view = render(<WorkRailSearchDialog open {...props}/>);
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    await screen.findByRole("button", { name: "Restore Old chat" });
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search chats" }), { key: "r", metaKey: true });
    await waitFor(() => expect(updateLifecycle).toHaveBeenCalledWith("chat_old", { baseRevision: 3, lifecycle: "active" }));
    expect(changed).toHaveBeenCalled();
    expect(restored).toHaveBeenCalledWith({ ...archived, chat: { ...archived.chat, lifecycle: "active", revision: 4 } });
    view.rerender(<WorkRailSearchDialog open={false} {...props}/>);
    view.rerender(<WorkRailSearchDialog open {...props}/>);
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete Old chat" }));
    expect(screen.getByText(/Its messages are deleted too/)).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("option", { name: "Old chat, Global" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete Old chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete forever" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("chat_old", expect.stringMatching(/^req_/)));
    expect(restored).toHaveBeenCalledOnce();
  });

  it("keeps a failed permanent deletion in its confirmation for retry or safe cancellation", async () => {
    const archived = { chat: { id: "chat_retry", title: "Retry deletion", lifecycle: "archived", revision: 3, updatedAt: "2026-11-12T00:00:00.000Z", createdAt: "2026-11-12T00:00:00.000Z" } };
    const remove = vi.fn(async () => { throw new Error("private backend failure"); });
    const client = { list: vi.fn(async () => ({ items: [archived] })), delete: remove } as unknown as CanonicalChatClient;
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" client={client} onClose={vi.fn()} onSelect={vi.fn()}/>);
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete Retry deletion" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Delete archived chats?" });
    expect(confirmation.getAttribute("data-state")).toBe("open");
    fireEvent.click(screen.getByRole("button", { name: "Delete forever" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The chat could not be deleted. Try again.");
    expect(screen.queryByText("private backend failure")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("option", { name: "Retry deletion, Global" })).toBeTruthy();
    expect(remove).toHaveBeenCalledOnce();
  });
  it("hides shared discovery after a complete listing confirms no organizations", () => {
    useConnection.setState({ organizationId: null, organizationStatus: "none" });

    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} />);

    expect(screen.queryByRole("tab", { name: "Shared" })).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("does not restore stale shared results while renewed membership is revalidated", async () => {
    useConnection.setState({ organizationId: "org_matrix", organizationStatus: "member" });
    api.get.mockResolvedValue({ items: [{ scopeId: "10000000-0000-4000-8000-000000000001", runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "actor_owner", kind: "chat", authorityGeneration: 1, status: "invited", invitationId: "20000000-0000-4000-8000-000000000001" }] });
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shared" }));
    await screen.findByRole("option", { name: "Shared chat invitation, Invitation · Shared chat" });

    act(() => useConnection.setState({ organizationId: null, organizationStatus: "none" }));
    expect(screen.queryByRole("tab", { name: "Shared" })).toBeNull();

    api.get.mockImplementation(() => new Promise(() => {}));
    act(() => useConnection.setState({ organizationId: "org_matrix", organizationStatus: "member" }));

    expect(screen.queryByRole("option", { name: "Shared chat invitation, Invitation · Shared chat" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Loading shared items…");
  });

  it("keeps loaded shared results while search is temporarily closed", async () => {
    useConnection.setState({ organizationId: "org_matrix", organizationStatus: "member" });
    api.get.mockResolvedValue({ items: [{ scopeId: "10000000-0000-4000-8000-000000000001", runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "actor_owner", kind: "chat", authorityGeneration: 1, status: "invited", invitationId: "20000000-0000-4000-8000-000000000001" }] });
    const props = { records: [], projects: [], status: "ready" as const, onClose: vi.fn(), onSelect: vi.fn() };
    const view = render(<WorkRailSearchDialog open {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shared" }));
    await screen.findByRole("option", { name: "Shared chat invitation, Invitation · Shared chat" });

    view.rerender(<WorkRailSearchDialog open={false} {...props} />);
    api.get.mockImplementation(() => new Promise(() => {}));
    view.rerender(<WorkRailSearchDialog open {...props} />);

    expect(screen.getByRole("option", { name: "Shared chat invitation, Invitation · Shared chat" })).toBeTruthy();
  });

  it("filters standalone existing Projects and opens their center without creating a Chat", () => {
    const onSelectProject = vi.fn();
    render(<WorkRailSearchDialog open records={[]} projects={[project]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} onSelectProject={onSelectProject} />);
    fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
    fireEvent.click(screen.getByRole("option", { name: "Alpha, Project" }));
    expect(onSelectProject).toHaveBeenCalledWith(project);
  });
  it("reads only authorized existing shared discovery and delegates invitation review to the shared tab", async () => {
    api.get.mockResolvedValue({ items: [{ scopeId: "10000000-0000-4000-8000-000000000001", runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "actor_owner", kind: "chat", authorityGeneration: 1, status: "invited", invitationId: "20000000-0000-4000-8000-000000000001" }] });
    const onOpenShared = vi.fn();
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} onOpenShared={onOpenShared} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shared" }));
    fireEvent.click(await screen.findByRole("option", { name: "Shared chat invitation, Invitation · Shared chat" }));
    expect(api.get).toHaveBeenCalledWith("/api/collaboration/inbox");
    expect(api.get).toHaveBeenCalledWith("/api/collaboration/shared");
    expect(onOpenShared).toHaveBeenCalledOnce();
    expect(useTabs.getState().tabs).toEqual([]);
  });
  it("keeps accepted shared projects out of search because the Projects rail owns them", async () => {
    api.get.mockResolvedValue({ items: [acceptedProject(true)] });
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} onOpenShared={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: "Shared" }));

    expect(await screen.findByText("No shared items found.")).toBeTruthy();
    expect(screen.queryByRole("option")).toBeNull();
  });
  it("keeps an accepted project discoverable when the Projects rail has no overview", async () => {
    api.get.mockResolvedValue({ items: [acceptedProject(false)] });
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} onOpenShared={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: "Shared" }));

    expect(await screen.findByRole("option", { name: "Shared project, Shared · Shared project" })).toBeTruthy();
  });
  it("clears the prior actor's discovery before a new actor lookup completes", async () => {
    api.get.mockResolvedValue({ items: [{ scopeId: "10000000-0000-4000-8000-000000000001", runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "actor_owner", kind: "chat", authorityGeneration: 1, status: "invited", invitationId: "20000000-0000-4000-8000-000000000001" }] });
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shared" }));
    await screen.findByRole("option", { name: "Shared chat invitation, Invitation · Shared chat" });
    api.get.mockImplementation(() => new Promise(() => {}));
    act(() => useConnection.setState({ userId: "another_actor" }));
    expect(screen.queryByRole("option", { name: "Shared chat invitation, Invitation · Shared chat" })).toBeNull();
    expect(screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Shared" }));
    expect(screen.getByRole("status").textContent).toBe("Loading shared items…");
    expect(api.release).toHaveBeenCalled();
  });
  it("shows a safe shared read failure", async () => {
    api.get.mockRejectedValue(new Error("private server path"));
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shared" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Shared items could not be loaded. Try again.");
    expect(screen.queryByText("private server path")).toBeNull();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });
});
