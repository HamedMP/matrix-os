import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { Kysely } from "kysely";
import { StartTaskResponseSchema, TaskGitResponseSchema, TaskResponseSchema } from "@matrix-os/contracts/project-tasks";
import { createTestPGlite } from "../../helpers/pglite-test-helper.js";
import { bootstrapProjectTaskDatabase, type ProjectTaskDatabase } from "../../../packages/gateway/src/project-tasks/database.js";
import { ProjectTaskRepository } from "../../../packages/gateway/src/project-tasks/repository.js";
import { ProjectTaskCommentRepository } from "../../../packages/gateway/src/project-tasks/comments.js";
import { ProjectTaskService } from "../../../packages/gateway/src/project-tasks/service.js";
import { ProjectTaskSessionRepository } from "../../../packages/gateway/src/project-tasks/sessions.js";
import { ProjectTaskWork } from "../../../packages/gateway/src/project-tasks/work.js";
import { createProjectTaskRoutes } from "../../../packages/gateway/src/project-tasks/routes.js";
import { createTaskSessionCredentials, type TaskSessionCredentials } from "../../../packages/gateway/src/project-tasks/session-credentials.js";
import { createTaskSessionPorts } from "../../../packages/gateway/src/server/project-task-sessions.js";
import { createProjectManager } from "../../../packages/gateway/src/project-manager.js";
import { createProjectRegistry } from "../../../packages/gateway/src/project-registry.js";
import { createWorktreeManager } from "../../../packages/gateway/src/worktree-manager.js";
import { atomicWriteJson } from "../../../packages/gateway/src/state-ops.js";

const run = promisify(execFile);
const OWNER = { type: "user" as const, id: "user_owner" };
const SLUG = "board-demo";
const WS = `tws_${"d".repeat(32)}`;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  return stdout;
}

describe("start work against a real git repository and the real worktree manager", () => {
  let home: string;
  let repo: string;
  let db: Kysely<ProjectTaskDatabase>;
  let app: Hono;
  let credentials: TaskSessionCredentials;
  const tabs: Array<{ cwd: string; command?: string[] }> = [];

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "board-start-work-")));
    repo = join(home, "projects", SLUG, "repo");
    await mkdir(repo, { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await writeFile(join(repo, "README.md"), "# demo\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-q", "-m", "initial");
    await atomicWriteJson(createProjectRegistry({ homePath: home }).configPath(SLUG), {
      id: "proj_demo", slug: SLUG, name: "Board demo", kind: "github", localPath: repo, defaultBranch: "main",
      addedAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", ownerScope: OWNER,
    });

    db = new Kysely<ProjectTaskDatabase>({ dialect: (await createTestPGlite()).dialect });
    await bootstrapProjectTaskDatabase(db);
    const projectManager = createProjectManager({ homePath: home });
    credentials = createTaskSessionCredentials({ homePath: home });
    const ports = createTaskSessionPorts({
      homePath: home,
      sessionCredentials: credentials,
      projectManager,
      worktreeManager: createWorktreeManager({ homePath: home }),
      chats: null,
      terminalRuntime: {
        ensureWorkspace: async () => ({ id: WS }) as never,
        createTab: async (_workspace, input) => { tabs.push(input); return { id: input.tabId! }; },
        listWorkspaces: async () => [],
        listAgentStatuses: async () => [],
      },
    });
    const sessions = new ProjectTaskSessionRepository(db);
    const tasks = new ProjectTaskService({
      repository: new ProjectTaskRepository(db),
      comments: new ProjectTaskCommentRepository(db),
      members: async () => [],
      projects: projectManager,
      legacyTasks: { listTasks: async () => ({ ok: true as const, tasks: [], nextCursor: null }) },
      publish: async () => {},
      sessions,
      agentStatus: { terminals: ports.terminals },
    });
    app = new Hono();
    app.route("/", createProjectTaskRoutes({ service: tasks, work: new ProjectTaskWork({ tasks, sessions, ports }), getOwnerScope: () => OWNER }));
  });

  afterEach(async () => {
    await db.destroy();
    await rm(home, { recursive: true, force: true });
    tabs.length = 0;
  });

  function call(method: string, path: string, body?: unknown) {
    return app.request(`/api/projects/${SLUG}${path}`, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  }

  it("creates the task's worktree and branch, records them, and reuses them on the next session", async () => {
    const created = TaskResponseSchema.parse(await (await call("POST", "/tasks", { title: "Add login page", status: "todo", clientRequestId: "req_task" })).json()).task;
    const response = await call("POST", `/tasks/${created.id}/start`, { kind: "terminal", clientRequestId: "req_start" });
    expect(response.status).toBe(201);
    const { task, session } = StartTaskResponseSchema.parse(await response.json());

    expect(task).toMatchObject({ branch: "task/bd-1-add-login-page", status: "in_progress" });
    expect(task.worktreeId).toMatch(/^wt_[a-z0-9]+$/);
    const checkout = join(home, "worktrees", SLUG, task.worktreeId!);
    expect((await stat(checkout)).isDirectory()).toBe(true);
    expect((await git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("task/bd-1-add-login-page");
    expect((await git(repo, "branch", "--list", "task/bd-1-add-login-page")).trim()).toContain("task/bd-1-add-login-page");
    expect(tabs[0]?.cwd).toBe(`worktrees/${SLUG}/${task.worktreeId}`);
    expect(tabs[0]?.command).toEqual(expect.arrayContaining([`MATRIX_TASK_ID=${task.id}`, "MATRIX_PROJECT_ID=proj_demo"]));
    // The tab's credential proves this tab, project and task to the board.
    const token = tabs[0]?.command?.find((part) => part.startsWith("MATRIX_TASK_SESSION_TOKEN="))?.slice("MATRIX_TASK_SESSION_TOKEN=".length);
    expect(session.ref).toMatch(/^term\./);
    const [, workspaceId, tabId] = session.ref.split(".");
    await expect(credentials.verify(token ?? "")).resolves.toEqual({ workspaceId, tabId, projectId: "proj_demo", taskId: task.id });
    expect(session.role).toBe("main");

    const second = StartTaskResponseSchema.parse(await (await call("POST", `/tasks/${created.id}/start`, { kind: "terminal", clientRequestId: "req_more" })).json());
    expect(second.task.worktreeId).toBe(task.worktreeId);
    expect(second.session.role).toBe("extra");
    expect(tabs[1]?.cwd).toBe(tabs[0]?.cwd);

    await writeFile(join(checkout, "page.ts"), "export {};\n");
    const gitResponse = await call("GET", `/tasks/${created.id}/git`);
    expect(gitResponse.status).toBe(200);
    const summary = TaskGitResponseSchema.parse(await gitResponse.json()).git;
    expect(summary).toMatchObject({ branch: "task/bd-1-add-login-page", dirty: true, changedFiles: 1, ahead: 0, behind: 0 });
    // No remote and no signed-in gh in this home: PR state is unavailable, not an error.
    expect(summary.prStatus).toBe("unavailable");
  }, 30_000);
});
