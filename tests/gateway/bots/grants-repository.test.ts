import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import { BotStateError } from "../../../packages/gateway/src/bots/repositories/shared.js";
import { BOT, NOW, OTHER_OWNER, OWNER, at, createBotStateDatabase } from "./bot-state-support.js";

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
const account = { ownerId: OWNER, botId: BOT, service: "gmail", connectionId: "conn_1", accountLabel: "work@example.com", grantedByActorId: OWNER };

beforeEach(async () => ({ db, destroy } = await createBotStateDatabase()));
afterEach(async () => destroy());

describe("bot grants repository", () => {
  it("keeps one live grant per account and audience", async () => {
    const repo = createBotGrantsRepository(db);
    const first = await repo.grant({ ...account, effects: ["send", "read"], audience: "direct", now: NOW });
    expect(first).toMatchObject({ created: true, grant: { effects: ["read", "send"], revokedAt: null } });
    await expect(repo.grant({ ...account, effects: ["read", "send"], audience: "direct", now: at(1) }))
      .resolves.toEqual({ grant: first.grant, created: false });
    await expect(repo.grant({ ...account, effects: ["read"], audience: "direct", now: NOW })).rejects.toEqual(new BotStateError("conflict"));
    await expect(repo.grant({ ...account, effects: ["read", "read"], audience: "direct", now: NOW })).rejects.toEqual(new BotStateError("invalid_input"));
    // The same account in a group audience is a separate grant.
    await expect(repo.grant({ ...account, effects: ["read"], audience: "group:chat_team1", now: NOW })).resolves.toMatchObject({ created: true });
    const narrowed = await repo.updateEffects({ ownerId: OWNER, grantId: first.grant.grantId, baseRevision: 1, effects: ["read"], now: at(2) });
    expect(narrowed).toMatchObject({ effects: ["read"], revision: 2 });
  });

  it("revokes once and lets the account be granted again", async () => {
    const repo = createBotGrantsRepository(db);
    const { grant } = await repo.grant({ ...account, effects: ["read"], audience: "direct", now: NOW });
    await expect(repo.revoke({ ownerId: OTHER_OWNER, grantId: grant.grantId, now: at(1) })).resolves.toBe(false);
    await expect(repo.revoke({ ownerId: OWNER, grantId: grant.grantId, now: at(1) })).resolves.toBe(true);
    await expect(repo.revoke({ ownerId: OWNER, grantId: grant.grantId, now: at(2) })).resolves.toBe(false);
    await expect(repo.findUsable({ ...account, audience: "direct", effect: "read", now: at(3) })).resolves.toBeUndefined();
    await expect(repo.grant({ ...account, effects: ["read", "write"], audience: "direct", now: at(4) })).resolves.toMatchObject({ created: true });
  });

  it("filters usable grants by audience, effect, and expiry", async () => {
    const repo = createBotGrantsRepository(db);
    await repo.grant({ ...account, effects: ["read"], audience: "direct", now: NOW });
    await repo.grant({ ...account, connectionId: "conn_2", effects: ["read", "send"], audience: "group:chat_team1", expiresAt: at(10_000), now: NOW });
    await expect(repo.listLive({ ownerId: OWNER, botId: BOT, audience: "direct", now: at(1) })).resolves.toEqual([expect.objectContaining({ connectionId: "conn_1" })]);
    await expect(repo.listLive({ ownerId: OWNER, botId: BOT, audience: "group:chat_team1", now: at(1) })).resolves.toEqual([expect.objectContaining({ connectionId: "conn_2" })]);
    await expect(repo.listLive({ ownerId: OWNER, botId: BOT, audience: "group:chat_other", now: at(1) })).resolves.toEqual([]);
    await expect(repo.findUsable({ ...account, audience: "direct", effect: "send", now: at(1) })).resolves.toBeUndefined();
    await expect(repo.findUsable({ ...account, connectionId: "conn_2", audience: "group:chat_team1", effect: "send", now: at(1) }))
      .resolves.toMatchObject({ connectionId: "conn_2" });
    await expect(repo.findUsable({ ...account, connectionId: "conn_2", audience: "group:chat_team1", effect: "send", now: at(20_000) }))
      .resolves.toBeUndefined();
  });
});
