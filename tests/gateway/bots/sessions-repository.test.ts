import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { BOT_SESSION_MAX_BYTES, createBotSessionsRepository } from "../../../packages/gateway/src/bots/repositories/sessions.js";
import { BotStateError } from "../../../packages/gateway/src/bots/repositories/shared.js";
import { BOT, NOW, OTHER_OWNER, OWNER, at, createBotStateDatabase, insertChat } from "./bot-state-support.js";

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
const key = { ownerId: OWNER, botId: BOT, chatId: "chat_session1" };
const versions = { "@earendil-works/pi-agent-core": "0.86.1", bundle: "sha256-abc" };

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, "chat_session1");
});
afterEach(async () => destroy());

describe("bot sessions repository", () => {
  it("loads an empty session at revision 0 and saves revision-checked", async () => {
    const repo = createBotSessionsRepository(db);
    await expect(repo.load(key)).resolves.toMatchObject({ revision: 0, messages: [], needsRecompaction: false });
    const messages = [{ role: "user", content: "hi", timestamp: 1 }];
    await expect(repo.save({ ...key, baseRevision: 0, messages, tokenEstimate: 3, runtimeVersions: versions, now: NOW }))
      .resolves.toEqual({ revision: 1 });
    // A second creator loses.
    await expect(repo.save({ ...key, baseRevision: 0, messages, tokenEstimate: 3, runtimeVersions: versions, now: NOW }))
      .rejects.toEqual(new BotStateError("revision_conflict"));
    const next = [...messages, { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 }];
    await expect(repo.save({ ...key, baseRevision: 1, messages: next, tokenEstimate: 9, runtimeVersions: versions, now: at(1) }))
      .resolves.toEqual({ revision: 2 });
    await expect(repo.save({ ...key, baseRevision: 1, messages, tokenEstimate: 3, runtimeVersions: versions, now: at(2) }))
      .rejects.toEqual(new BotStateError("revision_conflict"));
    await expect(repo.load(key)).resolves.toMatchObject({ revision: 2, messages: next });
    await expect(repo.load({ ...key, ownerId: OTHER_OWNER })).resolves.toMatchObject({ revision: 0, messages: [] });
  });

  it("refuses oversized transcripts and unsafe runtime version records", async () => {
    const repo = createBotSessionsRepository(db);
    const huge = [{ role: "user", content: "x".repeat(BOT_SESSION_MAX_BYTES), timestamp: 1 }];
    await expect(repo.save({ ...key, baseRevision: 0, messages: huge, tokenEstimate: 1, runtimeVersions: versions, now: NOW }))
      .rejects.toEqual(new BotStateError("too_large"));
    await expect(repo.save({ ...key, baseRevision: 0, messages: [], tokenEstimate: 1, runtimeVersions: { "bad key": "1" }, now: NOW }))
      .rejects.toEqual(new BotStateError("invalid_input"));
  });

  it("flags transcripts for recompaction until a compacted save clears the flag", async () => {
    const repo = createBotSessionsRepository(db);
    await repo.save({ ...key, baseRevision: 0, messages: [], tokenEstimate: 0, runtimeVersions: versions, now: NOW });
    await expect(repo.markNeedsRecompaction({ ownerId: OWNER, botId: BOT, now: at(1) })).resolves.toBe(1);
    await expect(repo.markNeedsRecompaction({ ownerId: OWNER, botId: BOT, now: at(2) })).resolves.toBe(0);
    await repo.save({ ...key, baseRevision: 1, messages: [], tokenEstimate: 0, runtimeVersions: versions, now: at(3) });
    await expect(repo.load(key)).resolves.toMatchObject({ needsRecompaction: true });
    await repo.save({ ...key, baseRevision: 2, messages: [], tokenEstimate: 0, compactedThroughSeq: 40, runtimeVersions: versions, now: at(4) });
    await expect(repo.load(key)).resolves.toMatchObject({ needsRecompaction: false, compactedThroughSeq: 40, revision: 3 });
  });
});
