import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { createChatExecutionRootResolver } from "../../packages/gateway/src/chat/execution-root.js";
import { createProjectChatRootInventory } from "../../packages/gateway/src/collaboration/project-chat-root-inventory.js";
import { createProjectManager } from "../../packages/gateway/src/project-manager.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const exec = promisify(execFile);
const OWNER = "user_git_boundary";
const CHAT = "chat_git_boundary";
const NOW = "2026-10-29T12:00:00.000Z";

async function git(cwd: string, ...args: string[]) {
  return exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd, timeout: 10_000, maxBuffer: 256 * 1024 });
}

describe("project Chat Git metadata stays within its execution root", () => {
  let fixture: CollaborationTestDatabase;
  let homePath: string;
  let root: string;
  let projectId: string;
  let read: () => ReturnType<ReturnType<typeof createProjectChatRootInventory>["list"]>;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    homePath = await mkdtemp(join(tmpdir(), "matrix-chat-git-boundary-"));
    await git(homePath, "init", "-b", "private-parent");
    const projects = createProjectManager({ homePath });
    const created = await projects.createProject({ mode: "scratch", name: "Scratch", slug: "scratch",
      ownerScope: { type: "user", id: OWNER } });
    if (!created.ok) throw new Error("Fixture project creation failed");
    root = created.project.localPath;
    projectId = created.project.id;
    await fixture.db.insertInto("chats").values({
      id: CHAT, owner_type: "personal", owner_id: OWNER, create_request_id: "req_git_boundary",
      project_id: projectId, title: "Scratch", lifecycle: "active", attention: "none",
      collaboration: null, user_state: null, shell_state: null, fork_provenance: null,
      last_message_preview: null, current_selection: null, bound_driver_kind: null,
      bound_instance_id: null, bound_at_turn_id: null, created_at: NOW, updated_at: NOW,
    }).execute();
    const executionRoots = createChatExecutionRootResolver({ homePath, projects,
      worktrees: { getWorktree: async () => ({ ok: false as const, status: 404, error: "Not found" }) } });
    const inventory = createProjectChatRootInventory({ db: fixture.db, executionRoots });
    read = () => inventory.list({ ownerId: OWNER, projectId });
  });

  afterEach(async () => {
    await fixture?.destroy();
    if (homePath) await rm(homePath, { recursive: true, force: true });
  });

  it("does not report the parent repository's branch or dirty state for a scratch project", async () => {
    await writeFile(join(homePath, "private-parent-file.txt"), "outside the shared project\n");
    const [item] = await read();
    expect(item).toMatchObject({ chatId: CHAT, readiness: "ready", executionRoot: { kind: "project", projectId } });
    expect(item?.branch).toBeUndefined();
    expect(item?.dirty).toBeUndefined();
    expect(item?.blocker).toBeUndefined();
  });

  it("keeps scratch sharing ready when a large parent repository exceeds the Git output cap", async () => {
    for (let index = 0; index < 600; index++) {
      await writeFile(join(homePath, `private-${index}-${"x".repeat(115)}.txt`), "outside\n");
    }
    const [item] = await read();
    expect(item).toMatchObject({ chatId: CHAT, readiness: "ready" });
    expect(item?.branch).toBeUndefined();
    expect(item?.dirty).toBeUndefined();
    expect(item?.blocker).toBeUndefined();
  });

  it("retains branch and dirty information for a repository rooted at the project workspace", async () => {
    await git(root, "init", "-b", "project-branch");
    await writeFile(join(root, "README.md"), "project-owned change\n");
    expect(await read()).toMatchObject([{ chatId: CHAT, readiness: "ready", branch: "project-branch", dirty: true }]);
  });

  it("keeps the existing output cap fail-closed for an oversized project repository", async () => {
    await git(root, "init", "-b", "project-branch");
    for (let index = 0; index < 600; index++) {
      await writeFile(join(root, `project-${index}-${"x".repeat(115)}.txt`), "inside\n");
    }
    expect(await read()).toMatchObject([{ chatId: CHAT, readiness: "blocked", blocker: "chat_root_unavailable" }]);
  });

  it("retains Git-file worktrees rooted at the project workspace", async () => {
    await writeFile(join(homePath, "parent.txt"), "parent\n");
    await git(homePath, "add", "parent.txt");
    await git(homePath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "parent");
    await git(homePath, "worktree", "add", "-b", "project-worktree", root);
    await writeFile(join(root, "README.md"), "project worktree change\n");
    expect(await read()).toMatchObject([{ chatId: CHAT, readiness: "ready", branch: "project-worktree", dirty: true }]);
  });
});
