import { describe, expect, it, vi } from "vitest";
import { TerminalRuntimeError } from "@matrix-os/terminal-runtime";
import { createProjectDeletionCleanup } from "../../packages/gateway/src/project-deletion-cleanup.js";
import { createProjectChatCleanup } from "../../packages/gateway/src/chat/project-deletion.js";
import type { ProjectConfig } from "../../packages/gateway/src/project-manager.js";
import type { WorkspaceSession } from "../../packages/gateway/src/agent-session-manager.js";
import type { ChatListPage } from "../../packages/gateway/src/chat/repository.js";

const principal = { userId: "user_a", source: "jwt" as const };
const project = { id: "proj_a", slug: "repo", ownerScope: { type: "user", id: "user_a" } } as ProjectConfig;
const child = { terminalRef: { workspaceId: "main", tabId: "owned" } } as WorkspaceSession;

function fixture() {
  const order: string[] = [];
  const options = {
    deleteChats: vi.fn(async () => { order.push("chats"); }),
    threads: { deleteProjectThreads: vi.fn(async () => { order.push("threads"); return { ok: true as const, deleted: 1 }; }) },
    sessions: { deleteProjectSessions: vi.fn(async (input: { beforeRemove?: (sessions: WorkspaceSession[]) => Promise<void> }) => {
      order.push("stop-sessions");
      await input.beforeRemove?.([child]);
      order.push("delete-sessions");
      return { ok: true as const, deleted: 1 };
    }) },
    worktrees: { listWorktrees: vi.fn().mockResolvedValue({ ok: true, worktrees: [{ id: "wt_owned" }] }),
      deleteWorktree: vi.fn().mockResolvedValue({ ok: true }) },
    reviews: { deleteProjectReviews: vi.fn(async () => ({ ok: true as const, deleted: 1 })) },
    terminal: {
      listWorkspaces: vi.fn().mockResolvedValue([
        { id: "project", scope: "project", projectId: project.id, tabs: [] },
        { id: "main", scope: "main", tabs: [{ id: "owned" }, { id: "unrelated" }] },
        { id: "other", scope: "project", projectId: "proj_other", tabs: [{ id: "other" }] },
      ]),
      deleteWorkspace: vi.fn(async () => { order.push("workspace"); }),
      deleteTab: vi.fn(async () => { order.push("tab"); }),
    },
  };
  return { options, order, cleanup: createProjectDeletionCleanup(options) };
}

describe("project cascade cleanup", () => {
  it("deletes descendant sessions and their Main tabs while preserving unrelated work", async () => {
    const f = fixture();
    await f.cleanup(project, principal);
    expect(f.order).toEqual(["chats", "threads", "stop-sessions", "workspace", "tab", "delete-sessions"]);
    expect(f.options.terminal.deleteWorkspace).toHaveBeenCalledExactlyOnceWith("project", { confirmTerminate: true });
    expect(f.options.terminal.deleteTab).toHaveBeenCalledExactlyOnceWith({ workspaceId: "main", tabId: "owned" });
    expect(f.options.sessions.deleteProjectSessions).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "user_a", projectSlug: "repo" }));
  });

  it("retains descendant refs on terminal cleanup failure so the same deletion can retry", async () => {
    const f = fixture();
    f.options.terminal.deleteTab.mockRejectedValueOnce(new Error("unavailable"));
    await expect(f.cleanup(project, principal)).rejects.toThrow("unavailable");
    expect(f.order).not.toContain("delete-sessions");
    expect(f.options.reviews.deleteProjectReviews).not.toHaveBeenCalled();
    await f.cleanup(project, principal);
    expect(f.order).toContain("delete-sessions");
  });

  it.each(["deleteWorkspace", "deleteTab"] as const)("accepts %s already removed after inventory was read", async (method) => {
    const f = fixture();
    f.options.terminal[method].mockRejectedValueOnce(new TerminalRuntimeError("not_found"));
    await expect(f.cleanup(project, principal)).resolves.toBeUndefined();
    expect(f.order).toContain("delete-sessions");
  });

  it("retains a failed worktree cleanup for retry and passes the project owner scope", async () => {
    const f = fixture();
    f.options.worktrees.deleteWorktree.mockResolvedValueOnce({ ok: false, status: 409, error: { code: "worktree_locked" } });
    await expect(f.cleanup(project, principal)).rejects.toThrow("Project worktree cleanup failed");
    await expect(f.cleanup(project, principal)).resolves.toBeUndefined();
    expect(f.options.worktrees.deleteWorktree).toHaveBeenCalledWith({ projectSlug: "repo", worktreeId: "wt_owned",
      ownerScope: project.ownerScope, confirmDirtyDelete: true });
  });

  it("accepts an already removed worktree but propagates inventory outages", async () => {
    const f = fixture();
    f.options.worktrees.deleteWorktree.mockResolvedValueOnce({ ok: false, status: 404, error: { code: "not_found" } });
    await expect(f.cleanup(project, principal)).resolves.toBeUndefined();
    f.options.worktrees.listWorktrees.mockResolvedValueOnce({ ok: false, status: 503, error: { code: "unavailable" } });
    await expect(f.cleanup(project, principal)).rejects.toThrow("Project worktree inventory failed");
  });

  it("stops on thread cleanup failure", async () => {
    const f = fixture();
    f.options.threads.deleteProjectThreads.mockRejectedValueOnce(new Error("stop failed"));
    await expect(f.cleanup(project, principal)).rejects.toThrow("stop failed");
    expect(f.options.sessions.deleteProjectSessions).not.toHaveBeenCalled();
  });
});

describe("canonical project chats", () => {
  it("includes archived chats and repeated pages, cancelling runs before transactional deletion", async () => {
    const order: string[] = [];
    const list = vi.fn().mockResolvedValueOnce({ items: [
      { chat: { id: "chat_a" }, activeRun: { runId: "run_a" } }, { chat: { id: "chat_archived", lifecycle: "archived" } },
    ] } as ChatListPage).mockResolvedValueOnce({ items: [{ chat: { id: "chat_next" } }] } as ChatListPage)
      .mockResolvedValue({ items: [] });
    const hardDelete = vi.fn(async (_owner, input) => { order.push(input.chatId); return { chatId: input.chatId, deletedAt: "2026-09-17T00:00:00Z" }; });
    const cancelRun = vi.fn().mockImplementation(async () => { order.push("cancel"); });
    await createProjectChatCleanup({ repository: { list, hardDelete }, orchestrator: { cancelRun } })(project, principal);
    expect(order).toEqual(["cancel", "chat_a", "chat_archived", "chat_next"]);
    expect(list).toHaveBeenCalledWith({ type: "personal", ownerId: "user_a" }, { projectId: "repo", limit: 100 });
    expect(list).toHaveBeenCalledWith({ type: "personal", ownerId: "user_a" }, { projectId: "proj_a", limit: 100 });
  });

  it("does not remove Chat data when cancellation fails", async () => {
    const list = vi.fn().mockResolvedValue({ items: [{ chat: { id: "chat_a" }, activeRun: { runId: "run_a" } }] });
    const hardDelete = vi.fn();
    const cancelRun = vi.fn().mockRejectedValue(new Error("stop failed"));
    await expect(createProjectChatCleanup({ repository: { list, hardDelete }, orchestrator: { cancelRun } })(project, principal)).rejects.toThrow("stop failed");
    expect(hardDelete).not.toHaveBeenCalled();
  });
});
