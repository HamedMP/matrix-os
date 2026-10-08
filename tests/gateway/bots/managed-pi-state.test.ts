import { afterEach, expect, it } from "vitest";
import { createManagedPiSessionsRepository } from "../../../packages/gateway/src/chat/managed-pi-sessions.js";
import { NOW, OWNER, OTHER_OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";
import { BotStateError } from "../../../packages/gateway/src/bots/repositories/shared.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
it("stores owner/chat Pi transcripts independently, CAS guards every save, and rejects foreign ownership", async () => {
  const { db, destroy } = await createBotStateDatabase(); cleanups.push(destroy);
  await insertChat(db, "chat_managed"); await insertChat(db, "chat_other", OTHER_OWNER);
  const sessions = createManagedPiSessionsRepository(db);
  const request = { ownerId: OWNER, chatId: "chat_managed", baseRevision: 0, messages: [{ role: "user", content: "hi" }], tokenEstimate: 2, runtimeVersions: {}, now: NOW };
  expect(await sessions.load(request)).toMatchObject({ revision: 0, messages: [] });
  expect(await sessions.save(request)).toEqual({ revision: 1 });
  await expect(sessions.save(request)).rejects.toEqual(new BotStateError("revision_conflict"));
  await sessions.save({ ...request, baseRevision: 1, messages: [] });
  expect(await sessions.load(request)).toMatchObject({ revision: 2, messages: [] });
  expect(await sessions.load({ ...request, ownerId: OTHER_OWNER })).toMatchObject({ revision: 0 });
  await expect(sessions.save({ ...request, chatId: "chat_other" })).rejects.toEqual(new BotStateError("not_found"));
});
