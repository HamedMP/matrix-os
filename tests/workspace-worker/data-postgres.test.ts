/** Opt-in live spike validation. Never accesses production or drops a database. */
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresWorkspaceRepository, type PostgresWorkspaceRepository } from "../../packages/workspace-worker/src/data/repository.js";
import { PostgresRuntimeStore } from "../../packages/workspace-worker/src/data/runtime-store.js";

const secretFile = process.env.MATRIX_SHARED_WORKSPACE_TEST_DATABASE_FILE;
const enabled = !!secretFile && existsSync(secretFile);
describe.skipIf(!enabled)("isolated live Postgres workspace integration", () => {
  const firstOwner = `spike_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const secondOwner = `${firstOwner}_other`;
  let repository: PostgresWorkspaceRepository;
  let runtime: PostgresRuntimeStore;
  beforeAll(async () => {
    const connectionString = readFileSync(secretFile!, "utf8").trim();
    repository = createPostgresWorkspaceRepository(connectionString);
    await repository.initialize();
    runtime = new PostgresRuntimeStore(repository.db); await runtime.initialize();
  });
  afterAll(async () => {
    if (!repository) return;
    try {
      await repository.db.transaction().execute(async (trx) => {
        for (const table of ["shared_chat_messages", "shared_runtime_jobs", "shared_runtime_bindings", "shared_files", "shared_chats", "shared_workspaces"] as const) {
          await trx.deleteFrom(table).where("owner_id", "in", [firstOwner, secondOwner]).execute();
        }
      });
    } finally { await repository.close(); }
  });
  it("restores saved owner data after reconnect without waking compute", async () => {
    await repository.saveLayout(firstOwner, { windows: [{ id: "live_file_window" }] }, 0);
    await repository.commitFile(firstOwner, "notes/live.txt", "workspace-files/live-test/opaque", 5, 0);
    const chat = await repository.createChat(firstOwner, "req_live", "Live integration");
    await repository.appendMessage(firstOwner, chat.id, "req_message", "user", "Saved before compute");
    const reopened = createPostgresWorkspaceRepository(readFileSync(secretFile!, "utf8").trim());
    try {
      expect((await reopened.bootstrap(firstOwner)).layout.windows).toHaveLength(1);
      expect((await reopened.messages(firstOwner, chat.id))[0].text).toBe("Saved before compute");
      expect((await reopened.bootstrap(secondOwner)).layout.windows).toEqual([]);
      expect(await reopened.file(secondOwner, "notes/live.txt")).toBeNull();
      expect(await reopened.chat(secondOwner, chat.id)).toBeNull();
      expect((await runtime.status(firstOwner)).state).toBe("sleeping");
    } finally { await reopened.close(); }
  });
  it("admits exactly one concurrent revision and fences expired work", async () => {
    const results = await Promise.allSettled([
      repository.saveLayout(firstOwner, { windows: [{ id: "left" }] }, 1),
      repository.saveLayout(firstOwner, { windows: [{ id: "right" }] }, 1),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const now = Date.now();
    const lease = (await runtime.claim({ ownerId: firstOwner, jobId: "live_job", type: "wake" }, now, 50, 500))!;
    expect(lease).not.toBeNull();
    expect(await runtime.claim({ ownerId: firstOwner, jobId: "live_job", type: "wake" }, now, 50, 500)).toBeNull();
    expect(await runtime.heartbeat(lease, now + 100, 50)).toBe(false);
    await runtime.recoverExpired(firstOwner, now + 100);
    expect(await runtime.active(firstOwner, now + 100)).toEqual([]);
    expect(await runtime.finish(lease, "completed", now + 100)).toBe(false);
  });
});
