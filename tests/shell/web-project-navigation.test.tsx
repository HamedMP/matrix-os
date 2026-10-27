// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp";
import { WebProjectsNav } from "../../shell/src/components/chat/WebProjectsNav";
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
  const view = render(<WebProjectsNav {...props} />);
  expect(await screen.findByText("No projects on this computer yet.")).toBeTruthy();
  view.rerender(<WebProjectsNav {...props} scopeKey="owner/main/reloaded" />);
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
  const view = render(<WebProjectsNav {...props} gatewayUrl="https://example.test/vm/old" />);
  view.rerender(<WebProjectsNav {...props} gatewayUrl="https://example.test/vm/new" />);
  expect(await screen.findByRole("button", { name: "Open New computer project" })).toBeTruthy();
  finishOld(Response.json({ projects: [{ id: "proj_old", slug: "old", name: "Old computer" }], nextCursor: null }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Open Old computer project" })).toBeNull());
  expect(response).toHaveBeenCalledTimes(2);
});

it("does not show one account's projects when the account changes on the same computer", async () => {
  const response = vi.fn(async () => Response.json({ projects: [{ id: `proj_${auth.userId}`, slug: auth.userId, name: auth.userId }], nextCursor: null }));
  vi.stubGlobal("fetch", response);
  const props = { gatewayUrl: "https://example.test/vm/main", scopeKey: "main", chats: [], onSelectChat: vi.fn() };
  const view = render(<WebProjectsNav {...props} />);
  expect(await screen.findByRole("button", { name: "Open user_owner project" })).toBeTruthy();
  auth.userId = "user_next";
  auth.sessionId = "session_next";
  view.rerender(<WebProjectsNav {...props} />);
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
