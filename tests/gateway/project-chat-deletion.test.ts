import { expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createProjectChatCleanup } from "../../packages/gateway/src/chat/project-deletion.js";
import type { ProjectConfig } from "../../packages/gateway/src/domains/workspace/project-manager.js";

it("hard-deletes project chats including archived history without touching other projects or owners", async () => {
  const db = await KyselyPGlite.create();
  const repository = new ChatRepository(db.dialect);
  const owner = { type: "personal" as const, ownerId: "user_a" };
  const other = { type: "personal" as const, ownerId: "user_b" };
  try {
    await repository.bootstrap();
    for (const [id, projectId, chatOwner] of [
      ["chat_project", "repo", owner], ["chat_archived", "repo", owner],
      ["chat_other_project", "other", owner], ["chat_other_owner", "repo", other],
    ] as const) {
      await repository.create(chatOwner, { id, projectId, title: id, clientRequestId: `req_${id}` });
    }
    await repository.update(owner, "chat_archived", { baseRevision: 0, lifecycle: "archived" });
    const cleanup = createProjectChatCleanup({
      repository,
      orchestrator: { cancelRun: async () => { throw new Error("Idle chats must not require cancellation"); } },
    });
    const project = { id: "proj_repo", slug: "repo" } as ProjectConfig;
    await cleanup(project, { userId: owner.ownerId, source: "jwt" });
    await cleanup(project, { userId: owner.ownerId, source: "jwt" });
    expect((await repository.list(owner, { projectId: "repo", limit: 100 })).items).toEqual([]);
    expect((await repository.list(owner, { projectId: "other", limit: 100 })).items).toHaveLength(1);
    expect((await repository.list(other, { projectId: "repo", limit: 100 })).items).toHaveLength(1);
    const tombstones = await repository.kysely.selectFrom("chat_deletions").select("chat_id").execute();
    expect(tombstones.map(row => row.chat_id).sort()).toEqual(["chat_archived", "chat_project"]);
  } finally {
    await repository.kysely.destroy();
  }
});
