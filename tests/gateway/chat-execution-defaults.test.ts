import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { adapter, catalog, owner, principal } from "./chat-orchestrator-test-support.js";
import type { ChatExecutionRootResolver } from "../../packages/gateway/src/chat/execution-root.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";

const WORKTREE = "wt_0123456789abcdef";

/** A task chat keeps running in its worktree when a turn names no root (spec 2699 section 3). */
describe("chat default execution root", () => {
  let repository: ChatRepository;

  beforeEach(async () => {
    repository = new ChatRepository((await createTestPGlite()).dialect);
    await repository.bootstrap();
  });
  afterEach(async () => { await repository.kysely.destroy(); });

  function orchestrator(worktrees: "optional" | "none" = "optional") {
    const resolve = vi.fn<ChatExecutionRootResolver["resolve"]>(async (_owner, ref) => ({
      ref, fingerprint: "a".repeat(64), primaryWorkspaceRoot: ref.kind === "worktree" ? "/safe/worktree" : "/safe/project", projectSlug: "demo",
    }));
    const base = catalog();
    const instances = base.instances.map((instance) => ({ ...instance, supports: { ...instance.supports, worktrees } }));
    const run = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => ({ ...base, instances }) },
      adapters: new CanonicalChatProviderRegistry([adapter(async function* () { yield { type: "run.completed", outcome: "completed" }; })]),
      executionRoots: { resolve, revalidate: vi.fn(async (_owner, provenance) => ({ ...provenance, primaryWorkspaceRoot: "/safe", projectSlug: "demo" })) },
    });
    return { run, resolve };
  }

  async function turn(run: CanonicalChatOrchestrator, chatId: string, requestId: string) {
    const chat = await repository.get(owner, chatId);
    await run.admitTurn(principal, owner, chatId, {
      clientRequestId: requestId, baseRevision: chat!.chat.revision, parts: [{ type: "text", text: "go" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" }, interactionMode: "default", permissionMode: "supervised",
    });
    await run.drain();
  }

  it("binds a server-only default worktree on create, idempotently and only for the owner", async () => {
    const service = createCanonicalChatService(repository);
    const created = await service.create(owner, { clientRequestId: "req_task_one", title: "BD-1", projectId: "proj_demo" }, { defaultWorktreeId: WORKTREE });
    const again = await service.create(owner, { clientRequestId: "req_task_one", title: "BD-1", projectId: "proj_demo" }, { defaultWorktreeId: WORKTREE });
    expect(again.chat.id).toBe(created.chat.id);
    expect(await repository.getExecutionDefault(owner, created.chat.id)).toEqual({ projectId: "proj_demo", worktreeId: WORKTREE });
    expect(await repository.getExecutionDefault({ type: "personal", ownerId: "someone_else" }, created.chat.id)).toBeNull();

    await expect(service.create(owner, { clientRequestId: "req_task_bad", title: "x", projectId: "proj_demo" }, { defaultWorktreeId: "../etc" })).rejects.toThrow();
    await expect(service.create(owner, { clientRequestId: "req_task_none", title: "x" }, { defaultWorktreeId: WORKTREE })).rejects.toMatchObject({ status: 400 });
    expect(await repository.get(owner, "chat_missing_0123456789abcdef0123456789ab")).toBeNull();
  });

  it("runs a turn without a root in the default worktree, and in the project once the chat moves", async () => {
    const service = createCanonicalChatService(repository);
    const { chat } = await service.create(owner, { clientRequestId: "req_task_two", title: "BD-2", projectId: "proj_demo" }, { defaultWorktreeId: WORKTREE });
    const { run, resolve } = orchestrator();
    try {
      await turn(run, chat.id, "req_turn_one");
      expect(resolve).toHaveBeenLastCalledWith(owner, { kind: "worktree", projectId: "proj_demo", worktreeId: WORKTREE });
      await turn(run, chat.id, "req_turn_two");
      expect(resolve).toHaveBeenLastCalledWith(owner, { kind: "worktree", projectId: "proj_demo", worktreeId: WORKTREE });

      const current = await repository.get(owner, chat.id);
      await repository.update(owner, chat.id, { baseRevision: current!.chat.revision, projectId: "proj_other" });
      expect(await repository.getExecutionDefault(owner, chat.id)).toBeNull();
      await turn(run, chat.id, "req_turn_three");
      expect(resolve).toHaveBeenLastCalledWith(owner, { kind: "project", projectId: "proj_other" });
    } finally {
      await run.close();
    }
  });

  it("keeps a plain project chat in its project and uses the project for providers without worktrees", async () => {
    const service = createCanonicalChatService(repository);
    const plain = (await service.create(owner, { clientRequestId: "req_plain", title: "Plain", projectId: "proj_demo" })).chat;
    const task = (await service.create(owner, { clientRequestId: "req_task_three", title: "BD-3", projectId: "proj_demo" }, { defaultWorktreeId: WORKTREE })).chat;
    const optional = orchestrator();
    const none = orchestrator("none");
    try {
      await turn(optional.run, plain.id, "req_plain_turn");
      expect(optional.resolve).toHaveBeenLastCalledWith(owner, { kind: "project", projectId: "proj_demo" });
      await turn(none.run, task.id, "req_none_turn");
      expect(none.resolve).toHaveBeenLastCalledWith(owner, { kind: "project", projectId: "proj_demo" });
    } finally {
      await optional.run.close();
      await none.run.close();
    }
  });
});
