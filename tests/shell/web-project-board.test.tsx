// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WebProjectHome } from "../../shell/src/components/chat/WebProjectHome";
import { ChatTicketBar } from "../../shell/src/components/chat/ChatTicketBar";
import { OPEN_TERMINAL_SESSION_EVENT } from "../../shell/src/lib/terminal-session-open";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "owner", sessionId: "session" }) }));
vi.mock("@/hooks/useFileWatcher", () => ({ useFileWatcher: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const WORKSPACE = `tws_${"a".repeat(32)}`;
const TAB = `tt_${"b".repeat(32)}`;

const TASK = {
  id: "task_1", projectId: "proj_1", number: 1, key: "FR-1", title: "Fix login", description: "", status: "in_progress", priority: "high",
  rank: "V", assignee: null, labels: [], parentTaskId: null, blockedBy: [], dueAt: null, worktreeId: null, branch: null, pullRequest: null,
  externalLink: null, commentCount: 0, createdBy: "user:owner", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
  archivedAt: null, revision: 1, chatId: "chat_abc", chatStatus: "working",
  sessions: [{ ref: `term.${WORKSPACE}.${TAB}`, kind: "terminal", title: "Tests", role: "main", agentStatus: "idle" }],
};

function gateway() {
  return vi.fn(async (input: string) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/vm\/ana/, "");
    if (path === "/api/projects/france/tasks") return Response.json({ tasks: [TASK], nextCursor: null });
    if (path === "/api/projects/france/board/members") return Response.json({ members: [] });
    if (path === "/api/projects/france/board/settings") {
      return Response.json({ settings: { projectId: "proj_1", taskKey: "FR", linearConnected: false, automation: { startMovesToInProgress: true, prOpenMovesToReview: true, prMergeMovesToDone: true } } });
    }
    if (path === "/api/projects/france/board/attachable-sessions") return Response.json({ sessions: [] });
    if (path.endsWith("/comments")) return Response.json({ comments: [], nextCursor: null });
    if (path.endsWith("/activity")) return Response.json({ activity: [], nextCursor: null });
    if (path.endsWith("/git")) return Response.json({ git: { branch: null, dirty: false, ahead: 0, behind: 0, changedFiles: 0, pullRequest: null, prStatus: "ok" } });
    if (path === "/api/workspace/events") return Response.json({ events: [], nextCursor: null });
    return new Response("{}", { status: 404 });
  });
}

function renderBoard({ onSelectChat = vi.fn(), onProjectChatsChanged = vi.fn(), detailsTaskId = null as string | null } = {}) {
  const fetch = gateway();
  vi.stubGlobal("fetch", fetch);
  render(<WebProjectHome project={{ id: "proj_france", slug: "france", name: "France" }} gatewayUrl="https://example.test/vm/ana" identity="owner"
    view="board" onViewChange={vi.fn()} onSelectChat={onSelectChat} onProjectChatsChanged={onProjectChatsChanged} detailsTaskId={detailsTaskId} />);
  return { fetch, onSelectChat, onProjectChatsChanged };
}

it("opens a card's chat in this Chats window and asks the rail to list it", async () => {
  const { onSelectChat, onProjectChatsChanged } = renderBoard();
  fireEvent.click(await screen.findByRole("button", { name: /FR-1: Fix login/ }));
  expect(onSelectChat).toHaveBeenCalledWith("chat_abc");
  expect(onProjectChatsChanged).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows the project's real board under the Overview | Board switch, without prototype data", async () => {
  const { fetch } = renderBoard();
  expect(screen.getByRole("group", { name: "Project view" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: /FR-1: Fix login/ })).toBeTruthy();
  expect(screen.queryByText(/Prototype/)).toBeNull();
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("https://example.test/vm/ana/api/projects/france/tasks?"), expect.objectContaining({ credentials: "same-origin" }));
});

it("opens a task's details from its chat header, with Open chat and its terminals", async () => {
  const { onSelectChat } = renderBoard({ detailsTaskId: "task_1" });
  const sheet = await screen.findByRole("dialog", { name: /FR-1: Fix login/ });
  expect(within(sheet).queryByRole("button", { name: "Start chat" })).toBeNull();
  fireEvent.click(within(sheet).getByRole("button", { name: /Open chat/ }));
  expect(onSelectChat).toHaveBeenCalledWith("chat_abc");

  const opened: unknown[] = [];
  const listen = (event: Event) => opened.push((event as CustomEvent).detail);
  window.addEventListener(OPEN_TERMINAL_SESSION_EVENT, listen);
  fireEvent.click(within(sheet).getByRole("tab", { name: /Tests, terminal/ }));
  fireEvent.click(within(sheet).getByRole("button", { name: "Open in Terminal" }));
  window.removeEventListener(OPEN_TERMINAL_SESSION_EVENT, listen);
  await waitFor(() => expect(opened).toEqual([{ sessionId: `${WORKSPACE}:${TAB}` }]));
});

it("shows a project chat's ticket above the conversation and edits it in place", async () => {
  const fetch = gateway();
  vi.stubGlobal("fetch", fetch);
  const onOpenDetails = vi.fn();
  render(<ChatTicketBar gatewayUrl="https://example.test/vm/ana" chatId="chat_abc"
    project={{ id: "proj_france", slug: "france", name: "France" }} onOpenDetails={onOpenDetails} />);
  const header = await screen.findByRole("group", { name: "Ticket FR-1" });
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/projects/france/tasks?chatId=chat_abc"), expect.anything());
  fireEvent.click(within(header).getByRole("button", { name: /Details/ }));
  expect(onOpenDetails).toHaveBeenCalledWith(expect.objectContaining({ slug: "france" }), expect.objectContaining({ id: "task_1" }));
});

it("shows no ticket for a chat outside a project", () => {
  vi.stubGlobal("fetch", gateway());
  const { container } = render(<ChatTicketBar gatewayUrl="https://example.test/vm/ana" chatId="chat_loose" project={undefined} onOpenDetails={vi.fn()} />);
  expect(container.innerHTML).toBe("");
});
