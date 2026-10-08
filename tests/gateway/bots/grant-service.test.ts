import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { BotGrantError, createBotGrantService } from "../../../packages/gateway/src/bots/grants-service.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { BOT, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const AT = "2026-09-28T09:00:00.000Z";
let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, "chat_grants1");
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_grants1", now: AT });
});
afterEach(async () => destroy());

describe("bot grant revocation", () => {
  it("revokes the bot's grant, announces it, and cannot revoke twice or another bot's grant", async () => {
    const { grant } = await createBotGrantsRepository(db).grant({
      ownerId: OWNER, botId: BOT, service: "gmail", connectionId: "conn_work", accountLabel: "Work", effects: ["read"],
      audience: "direct", grantedByActorId: OWNER, now: AT,
    });
    const service = createBotGrantService({
      transact: createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>)),
      now: () => new Date("2026-09-28T10:00:00.000Z"),
    });
    await expect(service.revoke(OWNER, "bot_ffffffffffffffffffffffff", grant.grantId)).rejects.toEqual(new BotGrantError("not_found"));
    await expect(service.revoke("user_owner_2", BOT, grant.grantId)).rejects.toEqual(new BotGrantError("not_found"));
    await expect(service.revoke(OWNER, BOT, grant.grantId)).resolves.toEqual({ grantId: grant.grantId, revokedAt: "2026-09-28T10:00:00.000Z" });
    await expect(service.revoke(OWNER, BOT, grant.grantId)).rejects.toEqual(new BotGrantError("not_found"));
    await expect(service.revoke(OWNER, BOT, "gr_bad")).rejects.toEqual(new BotGrantError("invalid_request"));
    const live = await createBotGrantsRepository(db).listLive({ ownerId: OWNER, botId: BOT, audience: "direct", now: AT });
    expect(live).toEqual([]);
    const events = await db.selectFrom("chat_outbox").select(["event_type", "payload"]).execute();
    expect(events).toEqual([{ event_type: "bot.authority.changed", payload: { agentId: BOT, revision: 2 } }]);
  });
});
