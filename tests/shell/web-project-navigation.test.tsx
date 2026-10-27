// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp";
import { WebProjectsNav } from "../../shell/src/components/chat/WebProjectsNav";
import { useWebProjects } from "../../shell/src/components/chat/web-projects";
import type { RenameableConversation } from "../../shell/src/components/chat/ChatTitleRename";

function Nav({ gatewayUrl, scopeKey, chats = [] }: { gatewayUrl: string; scopeKey: string; chats?: RenameableConversation[]; onSelectChat?: unknown }) {
  const state = useWebProjects(gatewayUrl, scopeKey);
  return <WebProjectsNav state={state} chats={chats} renderChat={chat => <button key={chat.id} type="button">{chat.title}</button>} />;
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
  fireEvent.click(within(projectsNav).getByRole("button", { name: "Open France project" }));
  fireEvent.click(within(projectsNav).getByRole("button", { name: "France: data lab" }));
  expect(select).toHaveBeenCalledWith("chat_france");
  await waitFor(() => expect(within(projectsNav).getByRole("button", { name: "France: data lab" })).toBeTruthy());
  cleanup();
  const reopened = vi.fn();
  render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp messages={[]} busy={false} connected conversations={conversations}
    onNewChat={vi.fn()} onSwitchConversation={reopened} onSubmit={vi.fn()} authorityKey="user_owner/runtime/main" /></OrganizationStateProvider>);
  const reloadedNav = await screen.findByRole("navigation", { name: "Projects" });
  fireEvent.click(await within(reloadedNav).findByRole("button", { name: "Open France project" }));
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
  expect(await screen.findByRole("button", { name: "Open Personal plan project" })).toBeTruthy();
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
  expect(await screen.findByRole("button", { name: "Open France project" })).toBeTruthy();
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
  expect(await screen.findByRole("button", { name: "Open New computer project" })).toBeTruthy();
  finishOld(Response.json({ projects: [{ id: "proj_old", slug: "old", name: "Old computer" }], nextCursor: null }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Open Old computer project" })).toBeNull());
  expect(response).toHaveBeenCalledTimes(2);
});

it("does not show one account's projects when the account changes on the same computer", async () => {
  const response = vi.fn(async () => Response.json({ projects: [{ id: `proj_${auth.userId}`, slug: auth.userId, name: auth.userId }], nextCursor: null }));
  vi.stubGlobal("fetch", response);
  const props = { gatewayUrl: "https://example.test/vm/main", scopeKey: "main", chats: [], onSelectChat: vi.fn() };
  const view = render(<Nav {...props} />);
  expect(await screen.findByRole("button", { name: "Open user_owner project" })).toBeTruthy();
  auth.userId = "user_next";
  auth.sessionId = "session_next";
  view.rerender(<Nav {...props} />);
  expect(screen.queryByRole("button", { name: "Open user_owner project" })).toBeNull();
  expect(await screen.findByRole("button", { name: "Open user_next project" })).toBeTruthy();
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
    : Response.json({})));
  render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><ChatApp messages={[]} busy={false} connected conversations={conversations}
    sessionId={sessionId} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} authorityKey="user_owner/runtime/main" /></OrganizationStateProvider>);
}

it("lists a project Chat under its Project only, as on Electron Desktop", async () => {
  renderChatApp([projectConversation(1), { id: "chat_loose", title: "Loose chat", preview: "", messageCount: 1, updatedAt: 1 }]);
  const projectsNav = await screen.findByRole("navigation", { name: "Projects" });
  await waitFor(() => expect(screen.queryAllByRole("button", { name: "Chat 1" })).toHaveLength(0));
  fireEvent.click(await within(projectsNav).findByRole("button", { name: "Open France project" }));
  expect(within(projectsNav).getAllByRole("button", { name: "Chat 1" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Chat 1" })).toHaveLength(1);
  expect(within(projectsNav).queryByRole("button", { name: "Loose chat" })).toBeNull();
  expect(screen.getByRole("button", { name: "Loose chat" })).toBeTruthy();
});

it("shows project Chats six at a time, with start times and the open Chat always visible", async () => {
  renderChatApp(Array.from({ length: 14 }, (_, index) => projectConversation(index + 1)), "chat_10");
  const projectsNav = await screen.findByRole("navigation", { name: "Projects" });
  fireEvent.click(await within(projectsNav).findByRole("button", { name: "Open France project" }));
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
  fireEvent.click(await within(projectsNav).findByRole("button", { name: "Open France project" }));
  expect(within(projectsNav).getByRole("button", { name: "Chat 1" })).toBeTruthy();
});
