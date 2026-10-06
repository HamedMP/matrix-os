import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotSchemaError, bootstrapBotDatabase, type OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { BOT_MIGRATIONS } from "../../../packages/gateway/src/bots/database-migrations.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { startBots, type BotServices } from "../../../packages/gateway/src/startup/bots.js";
import { BOT, NOW, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";
import { migrateDeployedProviderConnectionsV5 } from "./fixtures/provider-schema-v5.js";

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let home: string;
let agents: ChatAgentStore;
let repository: ChatRepository;
let services: BotServices | undefined;
const deployed = [...BOT_MIGRATIONS.slice(0, 4), {
  version: 5, name: "bot_provider_connections", up: migrateDeployedProviderConnectionsV5,
}];

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase({ migrate: false }));
  home = await mkdtemp(join(tmpdir(), "matrix-deployed-bot-schema-"));
  repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  agents = new ChatAgentStore({ homePath: home, db: repository.kysely });
  await agents.bootstrap();
});
afterEach(async () => {
  await services?.close();
  services = undefined;
  await agents.close();
  await destroy();
  await rm(home, { recursive: true, force: true });
});

it("serves the same bound Bot Chat after the deployed v5 schema returns to main", async () => {
  await bootstrapBotDatabase(db, deployed);
  await insertChat(db, "chat_existingbot");
  const owner = { type: "personal" as const, ownerId: OWNER };
  await agents.createRecipeBot(owner, {
    id: BOT, createHash: "a".repeat(64),
    fields: { name: "Saved writer", description: "", instructions: "Help write.", selection: { instanceId: "matrix_pi_default", model: "sonnet" } },
    recipeRef: { recipeId: "writing-bot", version: "2026-09-27.1" },
  });
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_existingbot", now: NOW });
  await sql`INSERT INTO bot_provider_authorizations VALUES (${OWNER}, 'computer_test', 'claude_code_tasks', '', false, false, 7)`.execute(db);
  services = await startBots({ homePath: home, repository, agents, executionRoots: { resolve: vi.fn() }, providers: { getSnapshot: vi.fn() } });
  const app = new Hono().route("/", createBotRoutes({
    ...(services ? { botChats: services.botChats, recipes: services.recipes } : {}),
    getPrincipal: () => ({ userId: OWNER, handle: "test-owner" }),
  }));
  const response = await app.request(`/api/chat-agents/${BOT}/direct-chat`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ chatId: "chat_existingbot" });
  expect((await app.request("/api/chat-agents/bot-recipes")).status).toBe(200);
  const authorizations = await sql`SELECT * FROM bot_provider_authorizations`.execute(db);
  expect(authorizations.rows).toEqual([{ owner_id: OWNER, computer_id: "computer_test", connection_id: "claude_code_tasks", fingerprint: "", enabled: false, background: false, revision: 7 }]);
  expect((await agents.get(owner, BOT))?.revision).toBe(1);
  await expect(bootstrapBotDatabase(db)).resolves.toEqual({ applied: [] });
});

it("rejects a colliding migration name before applying any pending migration", async () => {
  await bootstrapBotDatabase(db, BOT_MIGRATIONS.slice(0, 4));
  await sql`INSERT INTO bot_schema_migrations (version, name) VALUES (5, 'different_bot_feature')`.execute(db);
  await expect(bootstrapBotDatabase(db)).rejects.toEqual(new BotSchemaError("invalid_migrations"));
});

it("rejects a renamed released version before executing later migrations", async () => {
  await bootstrapBotDatabase(db, [BOT_MIGRATIONS[0]!]);
  await sql`UPDATE bot_schema_migrations SET name = 'different_state' WHERE version = 1`.execute(db);
  await expect(bootstrapBotDatabase(db)).rejects.toEqual(new BotSchemaError("invalid_migrations"));
  expect(await db.selectFrom("bot_schema_migrations").select("version").execute()).toEqual([{ version: 1 }]);
});

it("keeps unknown future schemas unavailable without applying missing current migrations", async () => {
  await bootstrapBotDatabase(db, [BOT_MIGRATIONS[0]!]);
  await sql`INSERT INTO bot_schema_migrations (version, name) VALUES (7, 'unknown_future')`.execute(db);
  await expect(bootstrapBotDatabase(db)).rejects.toEqual(new BotSchemaError("newer_schema"));
  expect(await db.selectFrom("bot_schema_migrations").select("version").orderBy("version").execute()).toEqual([{ version: 1 }, { version: 7 }]);
});
