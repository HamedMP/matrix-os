// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectLanding } from "@desktop/renderer/src/features/project/ProjectLanding";
import type { Project } from "@desktop/renderer/src/stores/board";
import { createApiClient } from "@desktop/renderer/src/lib/api";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useProjectView } from "@desktop/renderer/src/stores/project-view";
import { useTabs } from "@desktop/renderer/src/stores/tabs";

const actions = vi.hoisted(() => ({ showInFiles: vi.fn(), setDialog: vi.fn(), update: vi.fn(), dialog: null, pending: false, error: null, available: true }));
vi.mock("@desktop/renderer/src/features/work/work-rail/use-project-actions", () => ({ useProjectActions: () => actions }));

const WORKSPACE = `tws_${"a".repeat(32)}`;
const TAB = `tt_${"b".repeat(32)}`;
const project: Project = { id: "project_alpha_id", slug: "alpha", name: "Alpha", kind: "folder" };

const TASK = {
  id: "task_1", projectId: "proj_1", number: 1, key: "AL-1", title: "Fix login", description: "", status: "in_progress", priority: "high",
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
    const path = new URL(input).pathname;
    if (path === "/api/projects/alpha/tasks") return Response.json({ tasks: [TASK], nextCursor: null });
    if (path === "/api/projects/alpha/board/members") return Response.json({ members: [] });
    if (path === "/api/projects/alpha/board/settings") {
      return Response.json({ settings: { projectId: "proj_1", taskKey: "AL", linearConnected: false, automation: { startMovesToInProgress: true, prOpenMovesToReview: true, prMergeMovesToDone: true } } });
    }
    if (path === "/api/projects/alpha/board/attachable-sessions") return Response.json({ sessions: [] });
    if (path.endsWith("/comments")) return Response.json({ comments: [], nextCursor: null });
    if (path.endsWith("/activity")) return Response.json({ activity: [], nextCursor: null });
    if (path.endsWith("/git")) return Response.json({ git: { branch: null, dirty: false, ahead: 0, behind: 0, changedFiles: 0, pullRequest: null, prStatus: "ok" } });
    if (path === "/api/workspace/events") return Response.json({ events: [], nextCursor: null });
    return new Response("{}", { status: 404 });
  });
}

function connect(runtimeSlot = "primary") {
  const fetchFn = gateway();
  const api = createApiClient({ baseUrl: "https://fixture.test", getRuntimeSlot: () => useConnection.getState().runtimeSlot, fetchFn });
  useConnection.setState({ api, runtimeSlot, status: "signed-in" });
  return fetchFn;
}

function renderLanding(showMetadata = true) {
  return render(<ProjectLanding project={project} showMetadata={showMetadata}><textarea aria-label="Project draft" /></ProjectLanding>);
}

const initialConnection = useConnection.getState();
const initialTabs = useTabs.getState();
const initialViews = useProjectView.getState();

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useConnection.setState(initialConnection, true);
  useTabs.setState(initialTabs, true);
  useProjectView.setState(initialViews, true);
});

it("switches the project page between Overview and Board and remembers Board for the project", async () => {
  const fetchFn = connect();
  renderLanding();
  expect(screen.getByRole("textbox", { name: "Project draft" })).toBeTruthy();

  fireEvent.click(within(screen.getByRole("group", { name: "Project view" })).getByRole("button", { name: "Board" }));

  expect(useProjectView.getState().viewFor("alpha")).toBe("board");
  expect(await screen.findByRole("button", { name: /AL-1: Fix login/ })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Project draft" })).toBeNull();
  expect(fetchFn).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/fixture\.test\/api\/projects\/alpha\/tasks\?/), expect.objectContaining({ redirect: "error" }));

  fireEvent.click(screen.getByRole("button", { name: "Overview" }));
  expect(useProjectView.getState().viewFor("alpha")).toBe("overview");
  expect(screen.getByRole("textbox", { name: "Project draft" })).toBeTruthy();
});

it("reopens on the remembered Board with Electron's own board preferences, on the selected computer", async () => {
  const fetchFn = connect("vm-2");
  useProjectView.getState().setView("alpha", "board");
  window.localStorage.setItem("matrix:project-board:v1:electron:project_alpha_id", JSON.stringify({
    layout: "list",
    filter: { statuses: [], priorities: [], labels: [], assignees: [], search: "", showCanceled: false, showArchived: false },
  }));

  renderLanding();

  expect(await screen.findByRole("table")).toBeTruthy();
  await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining("/api/projects/alpha/tasks?"), expect.anything()));
  for (const [url] of fetchFn.mock.calls) expect(url).toContain("runtime=vm-2");
});

it("keeps an open chat in front of the remembered Board", () => {
  connect();
  useProjectView.getState().setView("alpha", "board");
  renderLanding(false);
  expect(screen.queryByRole("group", { name: "Project view" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "Project draft" })).toBeTruthy();
});

it("opens a task's chat in the project's Chat and its terminal in the Terminal app", async () => {
  connect();
  useProjectView.getState().setView("alpha", "board");
  renderLanding();

  fireEvent.click(await screen.findByRole("button", { name: /AL-1: Fix login/ }));
  const sheet = await screen.findByRole("dialog", { name: /AL-1: Fix login/ });

  fireEvent.click(within(sheet).getByRole("tab", { name: /Login chat, chat/ }));
  fireEvent.click(within(sheet).getByRole("button", { name: "Open in Chat" }));
  expect(useTabs.getState().tabs.find((tab) => tab.id === useTabs.getState().activeTabId)).toMatchObject({
    kind: "work", workRoute: "project", projectSlug: "alpha", chatId: "chat_abc", chatView: "conversation",
  });
  expect(useProjectView.getState().viewFor("alpha")).toBe("board");

  fireEvent.click(within(sheet).getByRole("tab", { name: /Tests, terminal/ }));
  fireEvent.click(within(sheet).getByRole("button", { name: "Open in Terminal" }));
  expect(useTabs.getState().tabs.some((tab) => tab.kind === "terminals")).toBe(true);
  expect(useTabs.getState().terminalSessionRequest?.sessionName).toBe(`${WORKSPACE}:${TAB}`);
});

it("shows the composer for a new-chat request on a project remembered as Board, without forgetting Board", async () => {
  const { useProjectChatLauncher } = await import("@desktop/renderer/src/lib/project-chat");
  connect();
  useProjectView.getState().setView("alpha", "board");
  renderLanding();
  expect(screen.queryByRole("textbox", { name: "Project draft" })).toBeNull();

  act(() => { useProjectChatLauncher.getState().requestComposer("alpha"); });
  expect(screen.getByRole("textbox", { name: "Project draft" })).toBeTruthy();
  expect(useProjectView.getState().viewFor("alpha")).toBe("board");

  // The request being consumed keeps the composer for this visit; choosing Board shows the board again.
  act(() => { useProjectChatLauncher.getState().consumeComposer("alpha"); });
  expect(screen.getByRole("textbox", { name: "Project draft" })).toBeTruthy();
  fireEvent.click(within(screen.getByRole("group", { name: "Project view" })).getByRole("button", { name: "Board" }));
  expect(screen.queryByRole("textbox", { name: "Project draft" })).toBeNull();
});
