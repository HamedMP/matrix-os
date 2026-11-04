import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createBotStateDatabase, insertChat, OWNER } from "./bot-state-support.js";

it("does not expose a concurrent transaction's uncommitted Chat through the single-session fixture", async () => {
  const { db, destroy } = await createBotStateDatabase();
  const inserted = Promise.withResolvers<void>();
  const rollback = Promise.withResolvers<void>();
  const cancelled = new Error("rollback synthetic Chat");
  const writer = db.transaction().execute(async trx => {
    await insertChat(trx, "chat_uncommitted", OWNER);
    inserted.resolve();
    await rollback.promise;
    throw cancelled;
  }).then(() => undefined, error => { inserted.reject(error); return error; });
  let reader: Promise<unknown> | undefined;
  try {
    await inserted.promise;
    let readBeforeRollback = false;
    reader = db.transaction().execute(async trx => {
      const row = await trx.selectFrom("chats").select("id")
        .where("id", "=", "chat_uncommitted").executeTakeFirst();
      readBeforeRollback = true;
      return row;
    });
    // Give a wrongly shared session time to enter the still-open transaction.
    await delay(100);
    const enteredBeforeRollback = readBeforeRollback;
    rollback.resolve();
    expect(await writer).toBe(cancelled);
    expect(await reader).toBeUndefined();
    expect(enteredBeforeRollback).toBe(false);
  } finally {
    rollback.resolve();
    await Promise.allSettled([writer, ...(reader ? [reader] : [])]);
    await destroy();
  }
});
