// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WebProjectHome } from "../../shell/src/components/chat/WebProjectHome";
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
  archivedAt: null, revision: 1,
  sessions: [
    { ref: "chat_abc", kind: "chat", title: "Login chat", role: "main", agentStatus: "working", harness: "claude" },
    { ref: `term.${WORKSPACE}.${TAB}`, kind: "terminal", title: "Tests", role: "extra", agentStatus: "idle" },
  ],
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

function renderBoard(onSelectChat = vi.fn()) {
  const fetch = gateway();
  vi.stubGlobal("fetch", fetch);
  render(<WebProjectHome project={{ id: "proj_france", slug: "france", name: "France" }} gatewayUrl="https://example.test/vm/ana" identity="owner"
    view="board" onViewChange={vi.fn()} onSelectChat={onSelectChat} />);
  return { fetch, onSelectChat };
}

it("shows the project's real board under the Overview | Board switch, without prototype data", async () => {
  const { fetch } = renderBoard();
  expect(screen.getByRole("group", { name: "Project view" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: /FR-1: Fix login/ })).toBeTruthy();
  expect(screen.queryByText(/Prototype/)).toBeNull();
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("https://example.test/vm/ana/api/projects/france/tasks?"), expect.objectContaining({ credentials: "same-origin" }));
});

it("opens a task's chat in this Chats window and its terminal in the Terminal window", async () => {
  const { onSelectChat } = renderBoard();
  fireEvent.click(await screen.findByRole("button", { name: /FR-1: Fix login/ }));
  const sheet = await screen.findByRole("dialog", { name: /FR-1: Fix login/ });

  fireEvent.click(within(sheet).getByRole("tab", { name: /Login chat, chat/ }));
  fireEvent.click(within(sheet).getByRole("button", { name: "Open in Chat" }));
  expect(onSelectChat).toHaveBeenCalledWith("chat_abc");

  const opened: unknown[] = [];
  const listen = (event: Event) => opened.push((event as CustomEvent).detail);
  window.addEventListener(OPEN_TERMINAL_SESSION_EVENT, listen);
  fireEvent.click(within(sheet).getByRole("tab", { name: /Tests, terminal/ }));
  fireEvent.click(within(sheet).getByRole("button", { name: "Open in Terminal" }));
  window.removeEventListener(OPEN_TERMINAL_SESSION_EVENT, listen);
  await waitFor(() => expect(opened).toEqual([{ sessionId: `${WORKSPACE}:${TAB}` }]));
});
