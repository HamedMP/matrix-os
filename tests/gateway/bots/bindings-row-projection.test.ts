/** Real Kysely compiler + inert driver: verifies row projection, never connects to a DB. */
import { afterEach, describe, expect, it } from "vitest";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";

const OWNER = "user_projection_fixture", BOT = "bot_projection_fixture", CHAT = "chat_projection_fixture";
const NOW = "2026-09-27T12:00:00.000Z";
let database: Kysely<OwnerBotDatabase> | undefined;
afterEach(async () => { await database?.destroy(); database = undefined; });

function fixture(row: Record<string, unknown>) {
  const queries: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  database = new Kysely<OwnerBotDatabase>({
    dialect: { createAdapter: () => new PostgresAdapter(), createDriver: () => new DummyDriver(),
      createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler() },
    plugins: [{ transformQuery: ({ node }) => node,
      async transformResult({ result }) { return { ...result, rows: [row] }; } }],
    log: event => { if (event.level === "query") queries.push({ sql: event.query.sql, parameters: event.query.parameters }); },
  });
  return { repository: createBotBindingsRepository(database), queries };
}
const base = { owner_id: OWNER, bot_id: BOT, chat_id: CHAT, created_at: NOW, removed_at: null };

describe("Bot binding row projection without PostgreSQL", () => {
  it("retains the dormant thread project metadata in the owner-scoped read result", async () => {
    const { repository, queries } = fixture({ ...base, kind: "thread", project_id: "proj_retained" });
    expect(await repository.forChat({ ownerId: OWNER, chatId: CHAT })).toEqual([{
      ownerId: OWNER, botId: BOT, chatId: CHAT, kind: "thread", projectId: "proj_retained", createdAt: NOW, removedAt: null,
    }]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.parameters).toEqual([OWNER, CHAT, 16]);
    expect(queries[0]!.sql).toContain('select * from "bot_chat_bindings"');
    expect(queries[0]!.sql).not.toContain("project_id");
  });

  it.each([
    { kind: "direct", column: "absent" }, { kind: "group", column: "absent" },
    { kind: "direct", column: "null" }, { kind: "group", column: "null" },
  ] as const)("keeps $kind output unchanged when project_id is $column", async ({ kind, column }) => {
    const { repository, queries } = fixture({ ...base, kind, ...(column === "null" ? { project_id: null } : {}) });
    expect(await repository.forChat({ ownerId: OWNER, chatId: CHAT })).toEqual([{
      ownerId: OWNER, botId: BOT, chatId: CHAT, kind, createdAt: NOW, removedAt: null,
    }]);
    expect(queries[0]!.sql).not.toContain("project_id");
  });

  it("keeps direct binding writes compatible with schemas that have no project_id column", async () => {
    const { repository, queries } = fixture({ ...base, kind: "direct" });
    expect(await repository.bindDirect({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: NOW }))
      .toEqual({ ownerId: OWNER, botId: BOT, chatId: CHAT, kind: "direct", createdAt: NOW, removedAt: null });
    expect(queries[0]!.sql).toContain("returning *");
    expect(queries[0]!.sql).not.toContain("project_id");
  });

  it("keeps directChatId restricted to live direct bindings and does not query project metadata", async () => {
    const { repository, queries } = fixture({ chat_id: CHAT });
    expect(await repository.directChatId({ ownerId: OWNER, botId: BOT })).toBe(CHAT);
    expect(queries[0]!.parameters).toEqual([OWNER, BOT, "direct"]);
    expect(queries[0]!.sql).toContain('"removed_at" is null');
    expect(queries[0]!.sql).not.toContain("project_id");
  });
});
