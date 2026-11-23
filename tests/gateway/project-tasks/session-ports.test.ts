import { describe, expect, it, vi } from "vitest";
import type { TaskSessionCredentials } from "../../../packages/gateway/src/project-tasks/session-credentials.js";
import {
  chatRunAgentStatus, checksRollup, createTaskSessionPorts, toTaskPullRequest, type TaskCommandRunner,
} from "../../../packages/gateway/src/server/project-task-sessions.js";

const HOME = "/home/owner";
const WS = `tws_${"b".repeat(32)}`;
const TAB = `tt_${"c".repeat(32)}`;
const credentials: TaskSessionCredentials = {
  issue: async (material) => `mts1.${material.workspaceId}.${material.tabId}.${material.projectId}.${material.taskId}.sig`,
  verify: async () => null,
};

function ports(runCommand: TaskCommandRunner, runtime: Partial<Parameters<typeof createTaskSessionPorts>[0]["terminalRuntime"]> = {}) {
  return createTaskSessionPorts({
    homePath: HOME,
    projectManager: { resolveProjectWorkingDirectory: async () => null, getCodeMetadata: async () => ({ ok: false, status: 404, error: { code: "x", message: "x" } }) } as never,
    worktreeManager: {} as never,
    chats: null,
    sessionCredentials: credentials,
    terminalRuntime: {
      ensureWorkspace: async () => ({ id: WS }) as never,
      createTab: async (_workspace, input) => ({ id: input.tabId ?? TAB }),
      listWorkspaces: async () => [],
      listAgentStatuses: async () => [],
      ...runtime,
    },
    runCommand,
  });
}

function failure(message: string, stderr = ""): Error {
  return Object.assign(new Error(message), { stderr });
}

describe("board session ports over gh and git", () => {
  it("maps gh pull request JSON to the wire summary", () => {
    expect(toTaskPullRequest({
      number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", isDraft: true, reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS", conclusion: "" }],
    })).toEqual({ number: 7, url: "https://github.com/o/r/pull/7", state: "draft", checks: "pending", review: "changes_requested" });
    expect(toTaskPullRequest({ number: 8, url: "https://github.com/o/r/pull/8", state: "MERGED", reviewDecision: "" }))
      .toMatchObject({ state: "merged", checks: "none", review: "none" });
    expect(toTaskPullRequest({ number: 9, url: "javascript:alert(1)", state: "OPEN" })).toBeNull();
    expect(checksRollup([{ state: "SUCCESS" }, { state: "FAILURE" }])).toBe("failing");
    expect(checksRollup([{ status: "COMPLETED", conclusion: "SKIPPED" }, { state: "SUCCESS" }])).toBe("passing");
  });

  it("reads the chat run vocabulary as agent status", () => {
    expect(["running", "accepted", "waiting_for_input", "waiting_for_approval", "failed", "completed", "aborted"].map(chatRunAgentStatus))
      .toEqual(["working", "working", "blocked", "blocked", "error", "done", "idle"]);
  });

  it("reports a missing, signed-out or slow gh as unavailable and no PR as ok", async () => {
    const run = vi.fn<TaskCommandRunner>();
    const { pullRequests } = ports(run);
    run.mockRejectedValueOnce(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));
    expect(await pullRequests.find({ cwd: "/repo", branch: "task/x" })).toEqual({ status: "unavailable" });
    run.mockRejectedValueOnce(failure("Command failed", "To get started with GitHub CLI, please run: gh auth login"));
    expect(await pullRequests.find({ cwd: "/repo", branch: "task/x" })).toEqual({ status: "unavailable" });
    run.mockRejectedValueOnce(Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }));
    expect(await pullRequests.find({ cwd: "/repo", branch: "task/x" })).toEqual({ status: "unavailable" });
    run.mockRejectedValueOnce(failure("Command failed", "no pull requests found for branch \"task/x\""));
    expect(await pullRequests.find({ cwd: "/repo", branch: "task/x" })).toEqual({ status: "ok", pullRequest: null });
    const [command, args, options] = run.mock.calls[0]!;
    expect(command).toBe("gh");
    expect(args.slice(0, 3)).toEqual(["pr", "view", "task/x"]);
    expect(options).toMatchObject({ cwd: "/repo", timeout: 10_000 });
    expect(options.env?.GH_CONFIG_DIR).toBe(`${HOME}/.config/gh`);
  });

  it("pushes, then opens a PR with the title and body as single arguments, or returns the existing one", async () => {
    const pr = JSON.stringify({ number: 3, url: "https://github.com/o/r/pull/3", state: "OPEN" });
    const run = vi.fn<TaskCommandRunner>()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(failure("Command failed", "no pull requests found"))
      .mockResolvedValueOnce({ stdout: "https://github.com/o/r/pull/3", stderr: "" })
      .mockResolvedValueOnce({ stdout: pr, stderr: "" });
    const { pullRequests } = ports(run);
    const title = "BD-1: Fix $(rm -rf ~) `x`";
    expect(await pullRequests.open({ cwd: "/repo", branch: "task/bd-1", baseBranch: "main", title, body: "Body", draft: false }))
      .toMatchObject({ status: "ok", pullRequest: { number: 3, state: "open" } });
    expect(run.mock.calls[0]?.slice(0, 2)).toEqual(["git", ["push", "-u", "origin", "refs/heads/task/bd-1:refs/heads/task/bd-1"]]);
    expect(run.mock.calls[2]?.[1]).toEqual(["pr", "create", "--head=task/bd-1", "--base=main", `--title=${title}`, "--body=Body"]);

    const failedPush = vi.fn<TaskCommandRunner>().mockRejectedValueOnce(failure("rejected"));
    expect(await ports(failedPush).pullRequests.open({ cwd: "/repo", branch: "task/bd-1", baseBranch: "main", title, body: "", draft: true }))
      .toEqual({ status: "unavailable" });
  });

  it("summarizes the working tree and divergence, falling back to the local default branch", async () => {
    const run = vi.fn<TaskCommandRunner>(async (_command, args) => {
      if (args[0] === "status") return { stdout: " M a.ts\n?? b.ts\n", stderr: "" };
      if (args[0] === "rev-parse") return { stdout: "task/bd-1\n", stderr: "" };
      if (args[3] === "origin/main...HEAD") throw failure("unknown revision");
      return { stdout: "1\t4\n", stderr: "" };
    });
    expect(await ports(run).git.summary({ cwd: "/repo", defaultBranch: "main" }))
      .toEqual({ branch: "task/bd-1", dirty: true, ahead: 4, behind: 1, changedFiles: 2 });
  });
});

describe("board session ports over the terminal runtime", () => {
  it("launches a tab with the task environment, a home-relative cwd and a fixed harness command", async () => {
    const createTab = vi.fn(async (_workspace: string, input: { tabId?: string }) => ({ id: input.tabId! }));
    const { terminals } = ports(vi.fn(), { createTab });
    await terminals.createTab({
      workspaceId: WS, tabId: TAB, name: "BD-1 Task", cwd: `${HOME}/worktrees/demo/wt_abc`,
      env: { MATRIX_TASK_ID: "task_1", MATRIX_PROJECT_ID: "proj_demo" }, harness: "claude",
    });
    // The tab's credential signs exactly this tab, project and task.
    const token = `MATRIX_TASK_SESSION_TOKEN=mts1.${WS}.${TAB}.proj_demo.task_1.sig`;
    expect(createTab).toHaveBeenCalledWith(WS, {
      tabId: TAB, name: "BD-1 Task", cwd: "worktrees/demo/wt_abc", accessScope: "owner",
      command: ["env", "MATRIX_TASK_ID=task_1", "MATRIX_PROJECT_ID=proj_demo", token, "sh", "-lc", 'exec "$0"', "claude"],
    });
    await terminals.createTab({ workspaceId: WS, tabId: TAB, name: "Shell", cwd: `${HOME}/p`, env: { MATRIX_TASK_ID: "task_1", MATRIX_PROJECT_ID: "proj_demo" } });
    expect(createTab.mock.calls[1]?.[1]).toMatchObject({ command: ["env", "MATRIX_TASK_ID=task_1", "MATRIX_PROJECT_ID=proj_demo", token, "sh", "-lc", 'exec "${SHELL:-/bin/sh}" -l'] });
  });

  it("refuses a runtime tab whose id differs from the one its credential signs", async () => {
    const { terminals } = ports(vi.fn(), { createTab: async () => ({ id: "tt_other" }) });
    await expect(terminals.createTab({
      workspaceId: WS, tabId: TAB, name: "x", cwd: `${HOME}/p`, env: { MATRIX_TASK_ID: "task_1", MATRIX_PROJECT_ID: "proj_demo" },
    })).rejects.toMatchObject({ name: "TaskPortUnavailableError" });
  });

  it("refuses a cwd outside the home, an unknown harness and ids that are not server ids", async () => {
    const { terminals } = ports(vi.fn());
    const env = { MATRIX_TASK_ID: "task_1", MATRIX_PROJECT_ID: "proj_demo" };
    await expect(terminals.createTab({ workspaceId: WS, tabId: TAB, name: "x", cwd: "/etc", env })).rejects.toMatchObject({ name: "TaskPortUnavailableError" });
    await expect(terminals.createTab({ workspaceId: WS, tabId: TAB, name: "x", cwd: `${HOME}/p`, env, harness: "bash" })).rejects.toMatchObject({ name: "TaskPortUnavailableError" });
    await expect(terminals.createTab({ workspaceId: WS, tabId: TAB, name: "x", cwd: `${HOME}/p`, env: { ...env, MATRIX_TASK_ID: "task_1; rm -rf /" } })).rejects.toThrow();
  });

  it("lists live owner tabs of the project workspace and keys agent status by session ref", async () => {
    const tab = (id: string, extra: Record<string, unknown>) => ({ id, workspaceId: WS, name: id, status: "running", ...extra });
    const { terminals } = ports(vi.fn(), {
      listWorkspaces: async () => [
        { id: WS, scope: "project", projectId: "proj_demo", tabs: [tab("tt_live", {}), tab("tt_chat", { accessScope: "chat" }), tab("tt_dead", { status: "exited" })] },
        { id: "tws_other", scope: "main", tabs: [tab("tt_main", {})] },
      ] as never,
      listAgentStatuses: async () => [{ ref: { workspaceId: WS, tabId: "tt_live" }, status: "blocked" }],
    });
    expect(await terminals.listForProject("proj_demo")).toEqual([{ workspaceId: WS, tabId: "tt_live", name: "tt_live" }]);
    // Existence is any status: an exited tab is still there to reopen; only a closed tab is gone.
    expect(await terminals.existingRefs("proj_demo")).toEqual([`term.${WS}.tt_live`, `term.${WS}.tt_chat`, `term.${WS}.tt_dead`]);
    expect(await terminals.statuses()).toEqual({ [`term.${WS}.tt_live`]: "blocked" });
  });

  it("reports chats as unavailable without the owner database", async () => {
    const { chats } = ports(vi.fn());
    await expect(chats.bindWorktree({ type: "user", id: "u" }, "chat_1", { projectId: "proj_demo", worktreeId: "wt_0123456789abcdef" }))
      .rejects.toMatchObject({ name: "TaskPortUnavailableError" });
    expect(await chats.statuses({ type: "user", id: "u" }, ["chat_1"])).toEqual({});
  });
});
