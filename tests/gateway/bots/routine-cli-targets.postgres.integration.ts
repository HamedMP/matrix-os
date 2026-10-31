import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createRoutineCliTargetService, type RoutineCliSourceContext } from "../../../packages/gateway/src/bots/routine-cli-targets.js";
import { BOT, NOW, OWNER, at, createRealBotStateDatabase, insertChat } from "./bot-state-support.js";

// Explicit opt-in suite. Missing native PostgreSQL is a failed prerequisite, never a skip.
// Set MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL to a dedicated test database, then on Node 24:
// pnpm exec vitest run --config vitest.integration.config.ts tests/gateway/bots/routine-cli-targets.postgres.integration.ts --maxWorkers=1 --no-file-parallelism
let db: Kysely<OwnerBotDatabase> | undefined, destroy: (() => Promise<void>) | undefined;
let home: string | undefined, agents: ChatAgentStore | undefined;
const scope = { ownerId: OWNER, computerId: "computer_one" };
const target = { botId: BOT, chatId: "chat_target", baseRevision: 0 };
const principal = { userId: OWNER, source: "jwt" as const };
const otherBot = "bot_abcdefgh";
const source: RoutineCliSourceContext = { ...scope, harness: "claude", generation: "generation_one",
  issuedAt: NOW, expiresAt: at(60_000), actions: ["read"],
  identity: { kind: "chat_run", chatId: "chat_source", runId: "run_source", route: "native" } };

beforeEach(async () => {
  const connectionString = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!connectionString) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required for native routine target races");
  ({ db, destroy } = await createRealBotStateDatabase(connectionString));
  home = await mkdtemp(join(tmpdir(), "matrix-routine-target-pg-"));
  agents = new ChatAgentStore({ homePath: home, db: db as unknown as Kysely<ChatDatabase> });
  await agents.bootstrap();
  await agents.createRecipeBot({ type: "personal", ownerId: OWNER }, { id: BOT, createHash: "a".repeat(64),
    fields: { name: "Recipe Bot", description: "", instructions: "Read", selection: { instanceId: "matrix_pi_default", model: "auto" } },
    recipeRef: { recipeId: "report", version: "1" } });
  await insertChat(db, target.chatId);
  await createBotBindingsRepository(db).bindDirect({ ...scope, ...target, now: NOW });
});
afterEach(async () => {
  try { await agents?.close(); } finally {
    try { await destroy?.(); } finally { if (home) await rm(home, { recursive: true, force: true }); }
  }
  db = undefined; destroy = undefined; home = undefined; agents = undefined;
});

describe("native routine target binding serialization", () => {
  it("preserves PostgreSQL microseconds and rejects an incarnation changed within one millisecond", async () => {
    const database = db!, bindings = createBotBindingsRepository(database);
    const first = "2026-09-27T12:00:00.123456Z", second = "2026-09-27T12:00:00.123457Z";
    await bindings.remove({ ...scope, ...target, now: at(1) });
    await bindings.bindDirect({ ...scope, ...target, now: first });
    const svc = createRoutineCliTargetService({ db: database, scope, agents: agents!, now: () => new Date(NOW),
      revalidateSource: async () => true, canAccessTarget: async () => true });
    expect(await svc.remember(principal, target)).toMatchObject({ target: { bindingCreatedAt: first } });
    expect(await svc.getDefault(principal)).toMatchObject({ target: { bindingCreatedAt: first } });
    await bindings.remove({ ...scope, ...target, now: at(2) });
    await bindings.bindDirect({ ...scope, ...target, now: second });
    await expect(svc.resolve(source, "read")).rejects.toMatchObject({ code: "target_unavailable" });
  });

  it.each([
    ["restore", "direct"], ["restore", "group"], ["insert", "direct"], ["insert", "group"],
  ] as const)("fences a concurrent %s of another %s binding until resolution commits", async (mode, kind) => {
    const database = db!, bindings = createBotBindingsRepository(database);
    const bind = kind === "direct" ? bindings.bindDirect : bindings.bindGroup;
    const other = { ownerId: OWNER, botId: otherBot, chatId: target.chatId, now: at(2) };
    if (mode === "restore") {
      await bind({ ...other, now: NOW });
      await bindings.remove({ ...other, now: at(1) });
    }
    let signalRead!: () => void, releaseRead!: () => void;
    const reading = new Promise<void>(resolve => { signalRead = resolve; });
    const gate = new Promise<void>(resolve => { releaseRead = resolve; });
    const svc = createRoutineCliTargetService({ db: database, scope, agents: agents!, now: () => new Date(NOW),
      // Fixtures cover only the source/ACL seam; the raced binding writer and all DB locks are real.
      revalidateSource: async () => true,
      canAccessTarget: async value => {
        if (value.action === "read") { signalRead(); await gate; }
        return true;
      } });
    await svc.remember(principal, target);
    const resolution = svc.resolve(source, "read");
    // Mark rejection handled while observing the concurrent writer.
    void resolution.catch(() => undefined);
    let writer: Promise<unknown> | undefined;
    try {
      await Promise.race([reading, delay(3_000).then(() => { throw new Error("Target ACL barrier not reached"); })]);
      let writerPid: number | undefined, writerState = "pending";
      writer = database.transaction().execute(async trx => {
        writerPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid;
        return bind(other, trx);
      }).then(result => { writerState = "committed"; return result; }, error => { writerState = "failed"; throw error; });
      void writer.catch(() => undefined);
      let lockObserved = false;
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && writerState === "pending") {
        if (writerPid !== undefined) {
          const activity = await sql<{ wait_event_type: string | null }>`
            SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${writerPid}
          `.execute(database);
          if (activity.rows[0]?.wait_event_type === "Lock") { lockObserved = true; break; }
        }
        await delay(10);
      }
      console.info(JSON.stringify({ mode, kind, writerState, lockObserved }));
      expect({ writerState, lockObserved }, "Binding membership changed inside a resolved target transaction")
        .toEqual({ writerState: "pending", lockObserved: true });
      releaseRead();
      await expect(resolution).resolves.toMatchObject({ botId: BOT, chatId: target.chatId });
      await writer;
      await expect(svc.resolve(source, "read")).rejects.toMatchObject({ code: "target_unavailable" });
    } finally {
      releaseRead();
      await Promise.allSettled([resolution, ...(writer ? [writer] : [])]);
    }
  });
});
