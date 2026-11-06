// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp";
import { WebProjectsNav } from "../../shell/src/components/chat/WebProjectsNav";
import { useWebProjects } from "../../shell/src/components/chat/web-projects";
import { usePagedProjectChats } from "../../shell/src/components/chat/usePagedProjectChats";
import { ChatRailOrderContext } from "@matrix-os/ui";
import type { RenameableConversation } from "../../shell/src/components/chat/ChatTitleRename";

function Nav({ gatewayUrl, scopeKey, chats = [], activeChatId, onSelectChat = vi.fn() }: { gatewayUrl: string; scopeKey: string; chats?: RenameableConversation[]; activeChatId?: string; onSelectChat?: (chatId: string) => void }) {
  const state = useWebProjects(gatewayUrl, scopeKey);
  return <WebProjectsNav state={state} gatewayUrl={gatewayUrl} chats={chats} listedChatIds={new Set(chats.map(chat => chat.id))} activeChatId={activeChatId} onSelectChat={onSelectChat}
    renderChat={chat => <button key={chat.id} type="button">{chat.title}</button>} />;
}
import { OrganizationStateProvider } from "../../shell/src/lib/collaboration-organization-state";

const auth = vi.hoisted(() => ({ userId: "user_owner", sessionId: "session_owner" }));

vi.mock("@clerk/nextjs", () => ({
  useOrganization: () => ({ organization: null }),
  useAuth: () => auth,
}));
vi.mock("../../shell/src/components/chat-provider-onboarding", () => ({ ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../../shell/src/components/chat/ChatInput", () => ({ ChatInput: () => null }));
vi.mock("@matrix-os/ui", async original => ({ ...await original<typeof import("@matrix-os/ui")>(),
  useBotConversationSummaries: () => ({ conversations: [], unresolvedChatIds: [], loading: false, error: null }),
  ChatAgentsRailSection: () => null,
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); auth.userId = "user_owner"; auth.sessionId = "session_owner"; window.history.replaceState(null, "", "/"); });

it("finds an existing personal project and opens its chat from the Web Chat rail", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const projects = [{ id: "proj_france", slug: "france", name: "France", kind: "scratch", ownerScope: { type: "user", id: "user_owner" } }];
  const request = vi.fn(async (url: string) => url.includes("/api/workspace/projects")
    ? Response.json({ projects, nextCursor: null })
    : Response.json({}));
  vi.stubGlobal("fetch", request);
  const select = vi.fn();
  const conversations = [{ id: "chat_france", title: "France: data lab", preview: "", messageCount: 1, updatedAt: 1,
    canonicalRecord: { projectId: "proj_france", chat: { id: "chat_france", title: "France: data lab", revision: 1,
      messageCount: 1, lifecycle: "active" as const, attention: "none" as const,
      createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z" } },
  }];
  render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp messages={[]} busy={false} connected conversations={conversations}
    onNewChat={vi.fn()} onSwitchConversation={select} onSubmit={vi.fn()} authorityKey="user_owner/runtime/main" /></OrganizationStateProvider>);

  const projectsNav = await screen.findByRole("navigation", { name: "Projects" });
  expect(request).toHaveBeenCalledWith(expect.stringContaining("/api/workspace/projects"), expect.anything());
  fireEvent.click(within(projectsNav).getByRole("button", { name: "Expand France chats" }));
  fireEvent.click(within(projectsNav).getByRole("button", { name: "France: data lab" }));
  expect(select).toHaveBeenCalledWith("chat_france");
  await waitFor(() => expect(within(projectsNav).getByRole("button", { name: "France: data lab" })).toBeTruthy());
  cleanup();
  const reopened = vi.fn();
  render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp messages={[]} busy={false} connected conversations={conversations}
    onNewChat={vi.fn()} onSwitchConversation={reopened} onSubmit={vi.fn()} authorityKey="user_owner/runtime/main" /></OrganizationStateProvider>);
  const reloadedNav = await screen.findByRole("navigation", { name: "Projects" });
  fireEvent.click(await within(reloadedNav).findByRole("button", { name: "Expand France chats" }));
  fireEvent.click(within(reloadedNav).getByRole("button", { name: "France: data lab" }));
  expect(reopened).toHaveBeenCalledWith("chat_france");
  expect(request.mock.calls.filter(([url]) => url.includes("/api/workspace/projects"))).toHaveLength(2);
});

it("keeps the owner's projects visible when the account is also an organization member", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ projects: [{ id: "proj_personal", slug: "personal", name: "Personal plan" }] })));
  render(<OrganizationStateProvider value={{ status: "member", organizationId: "org_team" }}><ChatApp
    messages={[]} busy={false} connected conversations={[]} onNewChat={vi.fn()}
    onSwitchConversation={vi.fn()} onSubmit={vi.fn()} authorityKey="user_owner/runtime/main" />
  </OrganizationStateProvider>);
  expect(await screen.findByRole("button", { name: "Expand Personal plan chats" })).toBeTruthy();
});

it("shows an empty state and a retryable error without making project records disappear", async () => {
  const response = vi.fn()
    .mockResolvedValueOnce(Response.json({ projects: [], nextCursor: null }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ projects: [{ id: "proj_france", slug: "france", name: "France" }], nextCursor: null }));
  vi.stubGlobal("fetch", response);
  const props = { gatewayUrl: "https://example.test/vm/main", scopeKey: "owner/main", chats: [], onSelectChat: vi.fn() };
  const view = render(<Nav {...props} />);
  expect(await screen.findByText("No projects on this computer yet.")).toBeTruthy();
  view.rerender(<Nav {...props} scopeKey="owner/main/reloaded" />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Projects could not be loaded.");
  fireEvent.click(screen.getByRole("button", { name: "Retry projects" }));
  expect(await screen.findByRole("button", { name: "Expand France chats" })).toBeTruthy();
  expect(response).toHaveBeenCalledTimes(3);
});

it("drops prior computer projects immediately and ignores their late response", async () => {
  let finishOld!: (response: Response) => void;
  const oldRequest = new Promise<Response>(resolve => { finishOld = resolve; });
  const response = vi.fn(async (url: string) => url.includes("/vm/old/")
    ? oldRequest
    : Response.json({ projects: [{ id: "proj_new", slug: "new", name: "New computer" }], nextCursor: null }));
  vi.stubGlobal("fetch", response);
  const props = { scopeKey: "owner", chats: [], onSelectChat: vi.fn() };
  const view = render(<Nav {...props} gatewayUrl="https://example.test/vm/old" />);
  view.rerender(<Nav {...props} gatewayUrl="https://example.test/vm/new" />);
  expect(await screen.findByRole("button", { name: "Expand New computer chats" })).toBeTruthy();
  finishOld(Response.json({ projects: [{ id: "proj_old", slug: "old", name: "Old computer" }], nextCursor: null }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Expand Old computer chats" })).toBeNull());
  expect(response).toHaveBeenCalledTimes(2);
});

it("does not show one account's projects when the account changes on the same computer", async () => {
  const response = vi.fn(async () => Response.json({ projects: [{ id: `proj_${auth.userId}`, slug: auth.userId, name: auth.userId }], nextCursor: null }));
  vi.stubGlobal("fetch", response);
  const props = { gatewayUrl: "https://example.test/vm/main", scopeKey: "main", chats: [], onSelectChat: vi.fn() };
  const view = render(<Nav {...props} />);
  expect(await screen.findByRole("button", { name: "Expand user_owner chats" })).toBeTruthy();
  auth.userId = "user_next";
  auth.sessionId = "session_next";
  view.rerender(<Nav {...props} />);
  expect(screen.queryByRole("button", { name: "Expand user_owner chats" })).toBeNull();
  expect(await screen.findByRole("button", { name: "Expand user_next chats" })).toBeTruthy();
  expect(response).toHaveBeenCalledTimes(2);
});

it("keeps project requests on the mounted computer while shared-chat history changes", async () => {
  window.history.replaceState(null, "", "/vm/main");
  const response = vi.fn(async (_url: string) => Response.json({ projects: [], nextCursor: null }));
  vi.stubGlobal("fetch", response);
  const props = { messages: [], busy: false, connected: true, conversations: [], onNewChat: vi.fn(), onSwitchConversation: vi.fn(), onSubmit: vi.fn(), authorityKey: "owner/main", gatewayUrl: `${window.location.origin}/vm/main` };
  const view = render(<ChatApp {...props} />);
  expect(await screen.findByText("No projects on this computer yet.")).toBeTruthy();
  window.history.pushState(null, "", "/shared");
  view.rerender(<ChatApp {...props} />);
  cleanup();
  render(<ChatApp {...props} />);
  expect(await screen.findByText("No projects on this computer yet.")).toBeTruthy();
  const projectCalls = response.mock.calls.map(([url]) => url).filter(url => url.includes("/api/workspace/projects"));
  expect(projectCalls).toEqual([`${window.location.origin}/vm/main/api/workspace/projects`, `${window.location.origin}/vm/main/api/workspace/projects`]);
});

it("switches project reads when Chat moves to a different explicit computer", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const request = vi.fn(async (url: string) => url.includes("/api/workspace/projects")
    ? Response.json({ projects: [{ id: url.includes("/vm/old/") ? "proj_old" : "proj_new",
      slug: url.includes("/vm/old/") ? "old" : "new", name: url.includes("/vm/old/") ? "Old" : "New" }] })
    : Response.json({}));
  vi.stubGlobal("fetch", request);
  const props = { messages: [], busy: false, connected: true, conversations: [], onNewChat: vi.fn(),
    onSwitchConversation: vi.fn(), onSubmit: vi.fn(), authorityKey: "owner" };
  const view = render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp {...props}
    gatewayUrl="https://example.test/vm/old" /></OrganizationStateProvider>);
  expect(await screen.findByRole("button", { name: "Expand Old chats" })).toBeTruthy();
  view.rerender(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp {...props}
    gatewayUrl="https://example.test/vm/new" /></OrganizationStateProvider>);
  expect(screen.queryByRole("button", { name: "Expand Old chats" })).toBeNull();
  expect(await screen.findByRole("button", { name: "Expand New chats" })).toBeTruthy();
});

function projectConversation(index: number, projectId = "proj_france"): RenameableConversation {
  const createdAt = new Date(Date.now() - index * 60 * 60 * 1000).toISOString();
  return { id: `chat_${index}`, title: `Chat ${index}`, preview: "", messageCount: 1, updatedAt: 1,
    canonicalRecord: { projectId, chat: { id: `chat_${index}`, title: `Chat ${index}`, revision: 1, messageCount: 1,
      lifecycle: "active", attention: "none", createdAt, updatedAt: createdAt } } as unknown as RenameableConversation["canonicalRecord"] };
}

function renderChatApp(conversations: RenameableConversation[], sessionId?: string) {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/api/workspace/projects")
    ? Response.json({ projects: [{ id: "proj_france", slug: "france", name: "France" }], nextCursor: null })
    : url.includes("/api/chats?") ? Response.json({ items: [], nextCursor: null }) : Response.json({})));
  render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp messages={[]} busy={false} connected conversations={conversations}
    sessionId={sessionId} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} authorityKey="user_owner/runtime/main" /></OrganizationStateProvider>);
}

it("lists a project Chat under its Project only, as on Electron Desktop", async () => {
  renderChatApp([projectConversation(1), { id: "chat_loose", title: "Loose chat", preview: "", messageCount: 1, updatedAt: 1 }]);
  const projectsNav = await screen.findByRole("navigation", { name: "Projects" });
  await waitFor(() => expect(screen.queryAllByRole("button", { name: "Chat 1" })).toHaveLength(0));
  fireEvent.click(await within(projectsNav).findByRole("button", { name: "Expand France chats" }));
  expect(within(projectsNav).getAllByRole("button", { name: "Chat 1" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Chat 1" })).toHaveLength(1);
  expect(within(projectsNav).queryByRole("button", { name: "Loose chat" })).toBeNull();
  expect(screen.getByRole("button", { name: "Loose chat" })).toBeTruthy();
});

it("shows project Chats six at a time, with start times and the open Chat always visible", async () => {
  renderChatApp(Array.from({ length: 14 }, (_, index) => projectConversation(index + 1)), "chat_10");
  const projectsNav = await screen.findByRole("navigation", { name: "Projects" });
  fireEvent.click(await within(projectsNav).findByRole("button", { name: "Expand France chats" }));
  const shown = () => within(projectsNav).getAllByRole("button", { name: /^Chat \d+$/ });
  expect(shown()).toHaveLength(10);
  const started = within(within(projectsNav).getByRole("button", { name: "Chat 2" })).getByText("2h");
  expect(started.tagName).toBe("TIME");
  expect(started.getAttribute("title")).toMatch(/^Started /);
  fireEvent.click(within(projectsNav).getByRole("button", { name: "Show more France chats" }));
  expect(shown()).toHaveLength(14);
  expect(within(projectsNav).queryByRole("button", { name: "Show more France chats" })).toBeNull();
});

it("matches project Chats by project slug as well as id", async () => {
  renderChatApp([projectConversation(1, "france")]);
  const projectsNav = await screen.findByRole("navigation", { name: "Projects" });
  fireEvent.click(await within(projectsNav).findByRole("button", { name: "Expand France chats" }));
  expect(within(projectsNav).getByRole("button", { name: "Chat 1" })).toBeTruthy();
});

it("opens an existing project chat outside the global navigation window", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const request = vi.fn(async (url: string) => url.includes("/api/workspace/projects")
    ? Response.json({ projects: [{ id: "proj_france", slug: "france", name: "France" }] })
    : url.includes("/api/chats?projectId=france") ? Response.json({ items: [{ chat: { id: "chat_old", title: "Older project chat", titleVersion: 1,
      createdAt: "2025-01-01T00:00:00Z" } }], nextCursor: null })
      : url.includes("/api/chats?") ? Response.json({ items: [], nextCursor: null }) : Response.json({}));
  vi.stubGlobal("fetch", request);
  const select = vi.fn();
  const props = { messages: [], busy: false, connected: true, conversations: [], onNewChat: vi.fn(),
    onSwitchConversation: select, onSubmit: vi.fn(), authorityKey: "owner/main", gatewayUrl: "https://example.test/vm/main" };
  render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp {...props} /></OrganizationStateProvider>);
  const projectsNav = await screen.findByRole("navigation", { name: "Projects" });
  fireEvent.click(await within(projectsNav).findByRole("button", { name: "Expand France chats" }));
  fireEvent.click(await within(projectsNav).findByRole("button", { name: "Older project chat" }));
  expect(select).toHaveBeenCalledWith("chat_old");
  expect(request).toHaveBeenCalledWith(expect.stringContaining("/api/chats?projectId=france"), expect.anything());
  cleanup();
  const reopened = vi.fn();
  render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp {...props} onSwitchConversation={reopened} /></OrganizationStateProvider>);
  const reopenedNav = await screen.findByRole("navigation", { name: "Projects" });
  fireEvent.click(await within(reopenedNav).findByRole("button", { name: "Expand France chats" }));
  fireEvent.click(await within(reopenedNav).findByRole("button", { name: "Older project chat" }));
  expect(reopened).toHaveBeenCalledWith("chat_old");
});

it("only shows unread project chats in the mobile filter", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/api/workspace/projects")
    ? Response.json({ projects: [{ id: "proj_france", slug: "france", name: "France" }] })
    : url.includes("/api/chats?") ? Response.json({ items: [], nextCursor: null }) : Response.json({})));
  const pinned = projectConversation(1);
  pinned.canonicalRecord!.chat.userState = { pinned: true } as NonNullable<typeof pinned.canonicalRecord>["chat"]["userState"];
  const unread = projectConversation(2);
  unread.readState = { unread: true } as NonNullable<typeof unread.readState>;
  render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp messages={[]} busy={false} connected
    conversations={[pinned, unread, projectConversation(3)]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()}
    onSubmit={vi.fn()} authorityKey="owner/main" mobile filterUnreadOnly /></OrganizationStateProvider>);
  const nav = await screen.findByRole("navigation", { name: "Projects" });
  fireEvent.click(await within(nav).findByRole("button", { name: "Expand France chats" }));
  expect(within(nav).getByRole("button", { name: "Chat 2" })).toBeTruthy();
  expect(within(nav).queryByRole("button", { name: "Chat 1" })).toBeNull();
  expect(within(nav).queryByRole("button", { name: "Chat 3" })).toBeNull();
  expect(screen.queryByText("No unread chats.")).toBeNull();
});

it("does not claim there are no unread chats when an older project chat is unread", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const request = vi.fn(async (url: string) => url.includes("/api/workspace/projects")
    ? Response.json({ projects: [{ id: "proj_france", slug: "france", name: "France" }] })
    : url.includes("/api/chats?projectId=proj_france")
      ? Response.json({ items: [{ chat: { id: "chat_unread", title: "Older unread chat" } }], nextCursor: null })
      : Response.json({ items: [], nextCursor: null }));
  vi.stubGlobal("fetch", request);
  render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp messages={[]} busy={false} connected
    conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}
    authorityKey="owner/main" mobile filterUnreadOnly /></OrganizationStateProvider>);
  const nav = await screen.findByRole("navigation", { name: "Projects" });
  fireEvent.click(await within(nav).findByRole("button", { name: "Expand France chats" }));
  expect(await within(nav).findByRole("button", { name: "Older unread chat" })).toBeTruthy();
  expect(screen.queryByText("No unread chats.")).toBeNull();
  expect(request).toHaveBeenCalledWith(expect.stringContaining("unread=true"), expect.anything());
});

it("applies the Chat source filter to older project rows", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/api/workspace/projects")
    ? Response.json({ projects: [{ id: "proj_france", slug: "france", name: "France" }] })
    : url.includes("/api/chats?projectId=proj_france")
      ? Response.json({ items: [
        { chat: { id: "chat_ordinary", title: "Ordinary chat" } },
        { chat: { id: "chat_imported", title: "Imported chat" }, importSource: { harness: "codex" } },
      ], nextCursor: null }) : Response.json({ items: [], nextCursor: null })));
  render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp messages={[]} busy={false} connected
    conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}
    authorityKey="owner/main" mobile /></OrganizationStateProvider>);
  fireEvent.change(screen.getByRole("combobox", { name: "Chat source" }), { target: { value: "codex" } });
  const nav = await screen.findByRole("navigation", { name: "Projects" });
  fireEvent.click(await within(nav).findByRole("button", { name: "Expand France chats" }));
  expect(await within(nav).findByRole("button", { name: "Imported chat" })).toBeTruthy();
  expect(within(nav).queryByRole("button", { name: "Ordinary chat" })).toBeNull();
  expect(screen.queryByText("No chats match this source.")).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Chat source" }), { target: { value: "all" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Search chats" }), { target: { value: "Ordinary" } });
  fireEvent.click(await within(nav).findByRole("button", { name: "Expand France chats" }));
  expect(await within(nav).findByRole("button", { name: "Ordinary chat" })).toBeTruthy();
  expect(within(nav).queryByRole("button", { name: "Imported chat" })).toBeNull();
});

it("keeps pinned project chats in Pinned instead of moving them into Projects", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  // The project page also returns the pinned Chat, as the gateway does.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/api/workspace/projects")
    ? Response.json({ projects: [{ id: "proj_france", slug: "france", name: "France" }] })
    : url.includes("/api/chats?projectId=proj_france") ? Response.json({ items: [{ chat: { id: "chat_1", title: "Chat 1" } }], nextCursor: null })
      : url.includes("/api/chats?") ? Response.json({ items: [], nextCursor: null }) : Response.json({})));
  const pinned = projectConversation(1);
  pinned.canonicalRecord!.chat.userState = { pinned: true } as NonNullable<typeof pinned.canonicalRecord>["chat"]["userState"];
  render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp messages={[]} busy={false} connected
    conversations={[pinned]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}
    authorityKey="owner/main" /></OrganizationStateProvider>);
  const nav = await screen.findByRole("navigation", { name: "Projects" });
  fireEvent.click(await within(nav).findByRole("button", { name: "Expand France chats" }));
  expect(await within(nav).findByText("No chats in this project yet.")).toBeTruthy();
  expect(within(nav).queryByRole("button", { name: "Chat 1" })).toBeNull();
  expect(within(screen.getByRole("region", { name: "Pinned" })).getByRole("button", { name: "Chat 1" })).toBeTruthy();
});

it("keeps known project chats keyboard reorderable inside their project", async () => {
  const move = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/api/workspace/projects")
    ? Response.json({ projects: [{ id: "proj_france", slug: "france", name: "France" }] })
    : Response.json({ items: [], nextCursor: null })));
  render(<ChatRailOrderContext.Provider value={{ manual: true, scopeKey: "owner/main", move }}>
    <Nav gatewayUrl="https://example.test/vm/main" scopeKey="owner/main" chats={[projectConversation(1), projectConversation(2)]} />
  </ChatRailOrderContext.Provider>);
  const nav = await screen.findByRole("navigation", { name: "Projects" });
  fireEvent.click(await within(nav).findByRole("button", { name: "Expand France chats" }));
  const row = within(nav).getByRole("button", { name: "Chat 1" }).closest<HTMLElement>("[data-rail-order-id]");
  expect(row?.dataset.railOrderGroup).toBe("project:proj_france");
  fireEvent.keyDown(row!, { altKey: true, key: "ArrowDown" });
  expect(move).toHaveBeenCalledWith("chat", "chat_1", "chat_2");
});

it("pages past known chats and retries a failed older-chat page", async () => {
  let olderAttempts = 0;
  const request = vi.fn(async (url: string) => url.includes("/api/workspace/projects")
    ? Response.json({ projects: [{ id: "proj_france", slug: "france", name: "France" }] })
    : url.includes("projectId=france") ? Response.json({ items: [], nextCursor: null })
    : url.includes("cursor=chatcur_next")
      ? (++olderAttempts === 1 ? new Response(null, { status: 503 })
        : Response.json({ items: [{ chat: { id: "chat_old", title: "Older chat" } }], nextCursor: null }))
      : Response.json({ items: [{ chat: { id: "chat_1", title: "Chat 1" } }], nextCursor: "chatcur_next" }));
  vi.stubGlobal("fetch", request);
  const select = vi.fn();
  render(<Nav gatewayUrl="https://example.test/vm/main" scopeKey="owner/main" chats={[projectConversation(1)]} onSelectChat={select} />);
  const nav = await screen.findByRole("navigation", { name: "Projects" });
  fireEvent.click(await within(nav).findByRole("button", { name: "Expand France chats" }));
  fireEvent.click(await within(nav).findByRole("button", { name: "Load more chats" }));
  expect(await within(nav).findByRole("alert")).toHaveProperty("textContent", "Project chats could not be loaded.");
  fireEvent.click(within(nav).getByRole("button", { name: "Retry chats" }));
  fireEvent.click(await within(nav).findByRole("button", { name: "Older chat" }));
  expect(select).toHaveBeenCalledWith("chat_old");
  expect(olderAttempts).toBe(2);
  expect(within(nav).getAllByRole("button", { name: "Chat 1" })).toHaveLength(1);
});

it("ignores a late project-chat page after the account changes", async () => {
  let finishOld!: (response: Response) => void;
  const oldPage = new Promise<Response>(resolve => { finishOld = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/api/workspace/projects")
    ? Response.json({ projects: [{ id: "proj_shared_name", slug: "shared-name", name: "Project" }] })
    : auth.userId === "user_owner" ? oldPage
      : Response.json({ items: [{ chat: { id: "chat_new", title: "New account chat" } }], nextCursor: null })));
  const props = { gatewayUrl: "https://example.test/vm/main", scopeKey: "main", chats: [], onSelectChat: vi.fn() };
  const view = render(<Nav {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Expand Project chats" }));
  await waitFor(() => expect(screen.getByText("Loading chats…")).toBeTruthy());
  auth.userId = "user_next";
  auth.sessionId = "session_next";
  view.rerender(<Nav {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Expand Project chats" }));
  expect(await screen.findByRole("button", { name: "New account chat" })).toBeTruthy();
  finishOld(Response.json({ items: [{ chat: { id: "chat_old", title: "Old account chat" } }], nextCursor: null }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Old account chat" })).toBeNull());
});

it("asks for import sources so older imported project chats survive source filters", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  // Like the gateway, drop provenance unless the client opts in with importSourceVersion=1.
  const request = vi.fn(async (url: string) => url.includes("/api/workspace/projects")
    ? Response.json({ projects: [{ id: "proj_france", slug: "france", name: "France" }] })
    : url.includes("/api/chats?projectId=proj_france")
      ? Response.json({ items: [{ chat: { id: "chat_imported", title: "Imported chat" },
        ...(url.includes("importSourceVersion=1") ? { importSource: { harness: "codex" } } : {}) }], nextCursor: null })
      : Response.json({ items: [], nextCursor: null }));
  vi.stubGlobal("fetch", request);
  render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp messages={[]} busy={false} connected
    conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}
    authorityKey="owner/main" mobile /></OrganizationStateProvider>);
  fireEvent.change(screen.getByRole("combobox", { name: "Chat source" }), { target: { value: "codex" } });
  const nav = await screen.findByRole("navigation", { name: "Projects" });
  fireEvent.click(await within(nav).findByRole("button", { name: "Expand France chats" }));
  expect(await within(nav).findByRole("button", { name: "Imported chat" })).toBeTruthy();
});

it("does not bring back a project Chat deleted while its project is open", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/api/workspace/projects")
    ? Response.json({ projects: [{ id: "proj_france", slug: "france", name: "France" }] })
    : url.includes("/api/chats?projectId=proj_france") ? Response.json({ items: [{ chat: { id: "chat_1", title: "Chat 1" } }], nextCursor: null })
      : Response.json({ items: [], nextCursor: null })));
  const onDeleteConversation = vi.fn(async () => true);
  const props = { messages: [], busy: false, connected: true, onNewChat: vi.fn(), onSwitchConversation: vi.fn(), onSubmit: vi.fn(),
    authorityKey: "owner/main", onDeleteConversation };
  const view = render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp {...props} conversations={[projectConversation(1)]} /></OrganizationStateProvider>);
  const nav = await screen.findByRole("navigation", { name: "Projects" });
  fireEvent.click(await within(nav).findByRole("button", { name: "Expand France chats" }));
  expect(await within(nav).findByRole("button", { name: "Actions for Chat 1" })).toBeTruthy();
  fireEvent.pointerDown(within(nav).getByRole("button", { name: "Actions for Chat 1" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete chat" }));
  await waitFor(() => expect(onDeleteConversation).toHaveBeenCalledWith("chat_1"));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  // The canonical state drops the record after a successful delete.
  view.rerender(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp {...props} conversations={[]} /></OrganizationStateProvider>);
  expect(within(nav).queryByRole("button", { name: "Chat 1" })).toBeNull();
  expect(await within(nav).findByText("No chats in this project yet.")).toBeTruthy();
});

it("narrows the Web sidebar to a selected project until the owner goes back, as on Electron Desktop", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/api/workspace/projects")
    ? Response.json({ projects: [{ id: "proj_france", slug: "france", name: "France" }] })
    : url.includes("/api/chats?projectId=proj_france")
      ? Response.json({ items: [{ chat: { id: "chat_1", title: "Chat 1" } }, { chat: { id: "chat_old", title: "Older project chat" } }], nextCursor: null })
      : Response.json({ items: [], nextCursor: null })));
  const pinned = projectConversation(2);
  pinned.canonicalRecord!.chat.userState = { pinned: true } as NonNullable<typeof pinned.canonicalRecord>["chat"]["userState"];
  const select = vi.fn();
  render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp messages={[]} busy={false} connected
    conversations={[projectConversation(1), pinned, { id: "chat_loose", title: "Loose chat", preview: "", messageCount: 1, updatedAt: 1 }]}
    onNewChat={vi.fn()} onSwitchConversation={select} onSubmit={vi.fn()} authorityKey="owner/main" /></OrganizationStateProvider>);
  const nav = await screen.findByRole("navigation", { name: "Projects" });
  fireEvent.click(await within(nav).findByRole("button", { name: "France" }));

  expect(screen.getByRole("heading", { name: "France" })).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "Projects" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Loose chat" })).toBeNull();
  expect(within(screen.getByRole("region", { name: "Pinned" })).getByRole("button", { name: "Chat 2" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Chat 1" })).toBeTruthy();
  const older = await screen.findByRole("region", { name: "Older chats" });
  expect(within(older).queryByRole("button", { name: "Chat 1" })).toBeNull();
  fireEvent.click(within(older).getByRole("button", { name: "Older project chat" }));
  expect(select).toHaveBeenCalledWith("chat_old");

  fireEvent.click(screen.getByRole("button", { name: "Back to all chats" }));
  expect(screen.queryByRole("heading", { name: "France" })).toBeNull();
  expect(screen.getByRole("button", { name: "Loose chat" })).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "Projects" })).toBeTruthy();
});

function renderFocusable(request: (url: string) => Response, extra: { mobile?: boolean } = {}) {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/api/workspace/projects")
    ? Response.json({ projects: [{ id: "proj_france", slug: "france", name: "France" }] }) : request(url)));
  render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp messages={[]} busy={false} connected
    conversations={[projectConversation(1), projectConversation(2)]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}
    authorityKey="owner/main" {...extra} /></OrganizationStateProvider>);
}

it("keeps Load more available in a focused project when nothing on the first page matches", async () => {
  renderFocusable(url => !url.includes("projectId=proj_france") ? Response.json({ items: [], nextCursor: null })
    : url.includes("cursor=") ? Response.json({ items: [{ chat: { id: "chat_needle", title: "Needle chat" } }], nextCursor: null })
      : Response.json({ items: [{ chat: { id: "chat_other", title: "Other chat" } }], nextCursor: "chatcur_page2" }));
  fireEvent.click(await within(await screen.findByRole("navigation", { name: "Projects" })).findByRole("button", { name: "France" }));
  await screen.findByRole("button", { name: "Other chat" });
  fireEvent.change(screen.getByRole("textbox", { name: "Search chats" }), { target: { value: "Needle" } });
  fireEvent.click(await screen.findByRole("button", { name: "Load more chats" }));
  expect(await screen.findByRole("button", { name: "Needle chat" })).toBeTruthy();
});

it("reloads a focused project's older chats when the Unread filter changes", async () => {
  renderFocusable(url => !url.includes("projectId=proj_france") ? Response.json({ items: [], nextCursor: null })
    : url.includes("unread=true") ? Response.json({ items: [{ chat: { id: "chat_unread_old", title: "Unread older chat" } }], nextCursor: null })
      : Response.json({ items: [{ chat: { id: "chat_read_old", title: "Read older chat" } }], nextCursor: null }), { mobile: true });
  fireEvent.click(await within(await screen.findByRole("navigation", { name: "Projects" })).findByRole("button", { name: "France" }));
  await screen.findByRole("button", { name: "Read older chat" });
  fireEvent.click(screen.getByRole("button", { name: "Unread" }));
  expect(await screen.findByRole("button", { name: "Unread older chat" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Read older chat" })).toBeNull();
});

it("keeps focused project chats reorderable in their lifecycle group, as in the main list", async () => {
  renderFocusable(() => Response.json({ items: [], nextCursor: null }));
  fireEvent.click(await within(await screen.findByRole("navigation", { name: "Projects" })).findByRole("button", { name: "France" }));
  await screen.findByRole("heading", { name: "France" });
  const row = screen.getByRole("button", { name: "Chat 1" }).closest<HTMLElement>("[data-rail-order-id]");
  expect(row?.dataset.railOrderId).toBe("chat_1");
  expect(row?.dataset.railOrderGroup).toBeTruthy();
});

it("lays out projects like the other rail sections and older chats like ordinary chat rows", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/api/workspace/projects")
    ? Response.json({ projects: [{ id: "proj_france", slug: "france", name: "France" }] })
    : url.includes("projectId=proj_france") ? Response.json({ items: [{ chat: { id: "chat_old", title: "Older chat" } }], nextCursor: null })
      : Response.json({ items: [], nextCursor: null })));
  render(<Nav gatewayUrl="https://example.test/vm/main" scopeKey="owner/main" chats={[projectConversation(1)]} activeChatId="chat_old" />);
  const nav = await screen.findByRole("navigation", { name: "Projects" });
  // No extra inset: the Projects heading lines up with Pinned, Needs you, Working and Done.
  expect(nav.getAttribute("class")).toBeNull();
  expect(within(nav).getByRole("button", { name: "France" }).closest(".matrix-web-project")).toBeTruthy();
  fireEvent.click(await within(nav).findByRole("button", { name: "Expand France chats" }));
  const older = await within(nav).findByRole("button", { name: "Older chat" });
  expect(older.classList).toContain("matrix-web-chat-row");
  expect(older.closest(".matrix-web-chat-row-item")?.getAttribute("data-current")).toBe("true");
  expect(older.closest(".matrix-web-project-chats")).toBeTruthy();
});

it("stops keeping older project chats at 1,000 rows", async () => {
  let page = 0;
  const request = vi.fn(async (url: string) => {
    // Every page is full and claims more, as a very large project would.
    const batch = url.includes("projectId=france") ? `s${page}` : `i${++page}`;
    return Response.json({ items: Array.from({ length: 100 }, (_, index) => ({ chat: { id: `chat_${batch}_${index}`, title: `Older ${batch} ${index}` } })),
      nextCursor: "chatcur_more" });
  });
  vi.stubGlobal("fetch", request);
  const { result } = renderHook(() => usePagedProjectChats({ id: "proj_france", slug: "france", name: "France" }, "https://example.test/vm/main", false, true));
  for (let loads = 0; loads < 10; loads += 1) {
    await waitFor(() => expect(result.current.loading).toBe(false));
    if (!result.current.hasMore) break;
    act(() => result.current.loadMore());
  }
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.fetched).toHaveLength(1_000);
  expect(result.current.capped).toBe(true);
  expect(result.current.hasMore).toBe(false);
  expect(request).toHaveBeenCalledTimes(10);
});
