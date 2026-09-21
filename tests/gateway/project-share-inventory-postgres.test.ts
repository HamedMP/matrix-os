import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createChatExecutionRootResolver } from "../../packages/gateway/src/chat/execution-root.js";
import { createProjectChatRootInventory } from "../../packages/gateway/src/collaboration/project-chat-root-inventory.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { createGatewayProjectInventorySource } from "../../packages/gateway/src/collaboration/project-inventory-source.js";
import { createProjectInventoryService } from "../../packages/gateway/src/collaboration/project-inventory.js";
import {
  createCollaborationTestDatabase,
  createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const run = promisify(execFile);
const OWNER = "user_inventory_owner";
const PROJECT = "proj_inventory";
const SLUG = "inventory";
const WORKTREE = "wt_abc123def456";
const NOW = "2026-09-21T10:00:00.000Z";
const SCOPE_ID = "70000000-0000-4000-8000-000000000051";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    timeout: 10_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

async function seedChat(db: CollaborationTestDatabase["db"], id: string) {
  await db.insertInto("chats").values({
    id,
    owner_type: "personal",
    owner_id: OWNER,
    create_request_id: `req_${id}`,
    project_id: PROJECT,
    title: id,
    lifecycle: "active",
    attention: "none",
    collaboration: null,
    user_state: null,
    shell_state: null,
    fork_provenance: null,
    last_message_preview: null,
    current_selection: null,
    bound_driver_kind: null,
    bound_instance_id: null,
    bound_at_turn_id: null,
    created_at: NOW,
    updated_at: NOW,
  }).execute();
}

async function seedRoot(db: CollaborationTestDatabase["db"], chatId: string, root: unknown) {
  await db.insertInto("chat_queued_turns").values({
    id: `qturn_${randomUUID().replaceAll("-", "")}`,
    chat_id: chatId,
    client_request_id: `req_${randomUUID().replaceAll("-", "")}`,
    position: 1,
    status: "queued",
    parts: [],
    driver_kind: "codex",
    instance_id: "codex_default",
    selection: {},
    interaction_mode: "default",
    permission_mode: "default",
    execution_root: root,
    execution_root_fingerprint: null,
    capability_snapshot: {},
    created_at: NOW,
    updated_at: NOW,
  }).execute();
}

describe("share-time project Chat root inventory", () => {
  let fixture: CollaborationTestDatabase;
  let homePath: string;
  let projectRoot: string;
  let worktreeRoot: string;

  beforeEach(async () => {
    fixture = process.env.MATRIX_TEST_POSTGRES_URL
      ? await createRealCollaborationTestDatabase()
      : await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    homePath = await mkdtemp(join(tmpdir(), "matrix-share-chat-roots-"));
    projectRoot = join(homePath, "projects", SLUG, "repo");
    worktreeRoot = join(homePath, "worktrees", SLUG, WORKTREE);
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(homePath, "worktrees", SLUG), { recursive: true });
    await git(projectRoot, "init", "-b", "main");
    await writeFile(join(projectRoot, "README.md"), "project\n");
    await git(projectRoot, "add", "README.md");
    await git(projectRoot, "-c", "user.name=Owner", "-c", "user.email=owner@example.test", "commit", "-m", "initial");
    await git(projectRoot, "worktree", "add", "-b", "feature/chat", worktreeRoot);
    await seedChat(fixture.db, "chat_main");
    await seedChat(fixture.db, "chat_feature");
    await seedRoot(fixture.db, "chat_main", { kind: "project", projectId: PROJECT });
    await seedRoot(fixture.db, "chat_feature", { kind: "worktree", projectId: PROJECT, worktreeId: WORKTREE });
  });

  afterEach(async () => {
    await fixture?.destroy();
    if (homePath) await rm(homePath, { recursive: true, force: true });
  });

  function inventory() {
    const resolver = createChatExecutionRootResolver({
      homePath,
      projects: {
        async getProjectById() {
          return { ok: true as const, project: { id: PROJECT, slug: SLUG, localPath: projectRoot } };
        },
        async resolveProjectWorkingDirectory() { return projectRoot; },
      },
      worktrees: {
        async getWorktree() {
          return { ok: true as const, worktree: { id: WORKTREE, projectSlug: SLUG, path: worktreeRoot, createdAt: NOW } };
        },
      },
    });
    return createProjectChatRootInventory({ db: fixture.db, executionRoots: resolver });
  }

  it("lists every Chat's canonical root, branch and dirty state without exposing host paths", async () => {
    await writeFile(join(worktreeRoot, "draft.txt"), "uncommitted\n");
    const roots = await inventory().list({ ownerId: OWNER, projectId: PROJECT });
    expect(roots).toEqual([
      expect.objectContaining({ chatId: "chat_feature", executionRoot: { kind: "worktree", projectId: PROJECT, worktreeId: WORKTREE }, branch: "feature/chat", dirty: true, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), readiness: "ready" }),
      expect.objectContaining({ chatId: "chat_main", executionRoot: { kind: "project", projectId: PROJECT }, branch: "main", dirty: false, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), readiness: "ready" }),
    ]);
    expect(JSON.stringify(roots)).not.toContain(homePath);
  });

  it("includes all Chat roots in the signed share preview and blocks an unresolved one", async () => {
    const source = createGatewayProjectInventorySource({
      homePath,
      projects: { async get() { return { id: PROJECT, ownerId: OWNER, rootPath: projectRoot, updatedAt: NOW }; } },
      chats: { async list() { return [
        { id: "chat_main", revision: 1 },
        { id: "chat_feature", revision: 1 },
      ]; } },
      chatRoots: inventory(),
      gitSetup: { async get() { return {
        identity: { status: "ready" as const, label: "Project Owner <owner@example.test>" },
        forgeCredential: { status: "ready" as const },
      }; } },
      canvases: { async getProjectCanvas() { return null; } },
      apps: { async get() { return null; } },
      sessions: { async list() { return []; } },
    });
    const service = createProjectInventoryService({
      homePath,
      source,
      confirmationSecret: "S10-test-confirmation-secret-that-is-long-enough",
    });
    await writeFile(join(worktreeRoot, "draft.txt"), "uncommitted\n");
    const preview = await service.preview({ ownerId: OWNER, projectId: PROJECT, membershipEffects: [] });
    expect(preview.ownedItems.filter((item) => item.kind === "chat")).toEqual([
      expect.objectContaining({ id: "chat_feature", executionRoot: { kind: "worktree", projectId: PROJECT, worktreeId: WORKTREE }, branch: "feature/chat", dirty: true }),
      expect.objectContaining({ id: "chat_main", executionRoot: { kind: "project", projectId: PROJECT }, branch: "main", dirty: false }),
    ]);
    expect(preview.blockers).toEqual([]);
    expect(preview.gitSetup).toEqual({
      identity: { status: "ready", label: "Project Owner <owner@example.test>" },
      forgeCredential: { status: "ready" },
    });

    await rm(worktreeRoot, { recursive: true, force: true });
    const blocked = await service.preview({ ownerId: OWNER, projectId: PROJECT, membershipEffects: [] });
    expect(blocked.blockers).toContainEqual({ kind: "chat", id: "chat_feature", code: "chat_root_unavailable" });
    expect(blocked.inventoryHash).not.toBe(preview.inventoryHash);
  });

  it("fails closed when the Chat catalog contains a root missing from canonical Postgres", async () => {
    const source = createGatewayProjectInventorySource({
      homePath,
      projects: { async get() { return { id: PROJECT, ownerId: OWNER, rootPath: projectRoot, updatedAt: NOW }; } },
      chats: { async list() { return [{ id: "chat_orphan", revision: 1 }]; } },
      chatRoots: inventory(),
      canvases: { async getProjectCanvas() { return null; } },
      apps: { async get() { return null; } },
      sessions: { async list() { return []; } },
    });
    const chats = await source.listChats(OWNER, PROJECT);
    expect(chats).toContainEqual(expect.objectContaining({ id: "chat_orphan", compatibility: "blocked", blocker: "chat_root_unavailable" }));
  });

  it("joins a member to the project without creating or copying a worktree", async () => {
    await bootstrapCollaborationDatabase(fixture.db);
    const repository = new CollaborationRepository(fixture.db, { now: () => new Date(NOW) });
    await repository.createDirectScope({
      scopeId: SCOPE_ID, organizationId: "org_inventory_team", ownerId: OWNER,
      kind: "project", resourceId: PROJECT, authorityRuntimeId: "vps:inventory_owner",
    });
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared" }).where("id", "=", SCOPE_ID).execute();
    const draft = join(worktreeRoot, "draft.txt");
    await writeFile(draft, "keep member join out of Git\n");
    const before = await git(projectRoot, "worktree", "list", "--porcelain");
    const dirsBefore = await readdir(join(homePath, "worktrees", SLUG));
    const invitation = await repository.createInvitation({
      scopeId: SCOPE_ID, actorId: OWNER, targetActorId: "user_member", role: "editor",
      clientRequestId: "70000000-0000-4000-8000-000000000052", expectedRevision: 0,
      payloadHash: "a".repeat(64), expiresAt: "2026-09-22T10:00:00.000Z",
    });
    await repository.acceptInvitation({
      invitationId: invitation.invitationId, actorId: "user_member",
      clientRequestId: "70000000-0000-4000-8000-000000000053", expectedRevision: 1,
      payloadHash: "b".repeat(64),
    });
    expect(await repository.getMember(SCOPE_ID, "user_member")).toMatchObject({ status: "accepted", role: "editor" });
    expect(await git(projectRoot, "worktree", "list", "--porcelain")).toBe(before);
    expect(await readdir(join(homePath, "worktrees", SLUG))).toEqual(dirsBefore);
    expect(await readFile(draft, "utf8")).toBe("keep member join out of Git\n");
  });

  it("retains a dirty registered worktree after hard deleting its Chat", async () => {
    const draft = join(worktreeRoot, "draft.txt");
    await writeFile(draft, "keep this uncommitted change\n");
    const repository = new ChatRepository(fixture.db);
    await repository.hardDelete({ type: "personal", ownerId: OWNER }, {
      chatId: "chat_feature", clientRequestId: "req_delete_chat_feature",
    });
    expect(await readFile(draft, "utf8")).toBe("keep this uncommitted change\n");
    expect(await git(worktreeRoot, "status", "--porcelain=v1")).toContain("draft.txt");
    expect(await git(projectRoot, "worktree", "list", "--porcelain")).toContain(worktreeRoot);
    expect((await inventory().list({ ownerId: OWNER, projectId: PROJECT })).map((root) => root.chatId)).toEqual(["chat_main"]);
  });

  it("blocks sharing when a Chat root no longer resolves", async () => {
    await rm(worktreeRoot, { recursive: true, force: true });
    const roots = await inventory().list({ ownerId: OWNER, projectId: PROJECT });
    expect(roots.find((root) => root.chatId === "chat_feature")).toMatchObject({ readiness: "blocked", blocker: "chat_root_unavailable" });
  });
});
