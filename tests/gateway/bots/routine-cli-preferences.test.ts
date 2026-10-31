import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import * as contracts from "../../../packages/contracts/src/bots/index.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createRoutineCliPreferencesRepository } from "../../../packages/gateway/src/bots/repositories/routine-cli-preferences.js";
import { BOT, NOW, OWNER, OTHER_OWNER, at, createBotStateDatabase } from "./bot-state-support.js";

let db: Kysely<OwnerBotDatabase>, destroy: () => Promise<void>;
beforeEach(async () => { ({ db, destroy } = await createBotStateDatabase()); });
afterEach(async () => { await destroy(); });
const scope = { ownerId: OWNER, computerId: "computer_one" };
const target = { botId: BOT, chatId: "chat_target", bindingCreatedAt: NOW };

describe("routine CLI preference persistence", () => {
  it("persists one owner+Computer route, never authority, across repository recreation", async () => {
    const repo = createRoutineCliPreferencesRepository(db);
    expect(await repo.get(scope)).toBeNull();
    const saved = await repo.save({ ...scope, target, baseRevision: 0, now: NOW });
    expect(saved).toMatchObject({ revision: 1, target });
    expect(await createRoutineCliPreferencesRepository(db).get(scope)).toEqual(saved);
    expect(await repo.get({ ...scope, ownerId: OTHER_OWNER })).toBeNull();
    expect(await repo.get({ ...scope, computerId: "computer_other" })).toBeNull();
    expect(Object.keys(saved).sort()).toEqual(["revision", "target", "updatedAt"]);
  });
  it("allows one initial save and enforces revision in later writes", async () => {
    const repo = createRoutineCliPreferencesRepository(db);
    await repo.save({ ...scope, target, baseRevision: 0, now: NOW });
    await expect(repo.save({ ...scope, target, baseRevision: 0, now: at(1) })).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(repo.save({ ...scope, target, baseRevision: 1, now: at(2) })).resolves.toMatchObject({ revision: 2 });
    await expect(repo.save({ ...scope, target, baseRevision: 1, now: at(3) })).rejects.toMatchObject({ code: "revision_conflict" });
  });
  it("keeps a revision tombstone after reset so old save/reset cannot win", async () => {
    const repo = createRoutineCliPreferencesRepository(db);
    await repo.save({ ...scope, target, baseRevision: 0, now: NOW });
    expect(await repo.reset({ ...scope, baseRevision: 1, now: at(1) })).toMatchObject({ revision: 2, target: null });
    for (const baseRevision of [0, 1]) {
      await expect(repo.save({ ...scope, target, baseRevision, now: at(2) })).rejects.toMatchObject({ code: "revision_conflict" });
      await expect(repo.reset({ ...scope, baseRevision, now: at(2) })).rejects.toMatchObject({ code: "revision_conflict" });
    }
    expect(await repo.save({ ...scope, target, baseRevision: 2, now: at(3) })).toMatchObject({ revision: 3, target });
  });
  it("shares caller transaction and rolls preference writes back with related work", async () => {
    const repo = createRoutineCliPreferencesRepository(db);
    await expect(db.transaction().execute(async trx => {
      await repo.save({ ...scope, target, baseRevision: 0, now: NOW }, trx);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await repo.get(scope)).toBeNull();
  });
  it("rejects malformed routing inputs without writing credentials or arbitrary fields", async () => {
    const repo = createRoutineCliPreferencesRepository(db);
    await expect(repo.save({ ...scope, target, baseRevision: -1, now: NOW })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repo.save({ ...scope, target: { ...target, token: "secret" }, baseRevision: 0, now: NOW } as never)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repo.save({ ...scope, target: { ...target, bindingCreatedAt: "2026" }, baseRevision: 0, now: NOW })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await repo.get(scope)).toBeNull();
  });
});

describe("strict public routine wire operations", () => {
  it("accepts all CLI verbs while rejecting caller and target identity overrides", () => {
    const requestId = "d662da0b-48bc-49f0-9c72-d38f9d85d001";
    const operations = [{ operation: "list" }, { operation: "show", routineId: `rt_${"a".repeat(24)}` },
      { operation: "request", requestId }, ...["pause", "resume", "archive"].map(operation => ({ operation, routineId: `rt_${"a".repeat(24)}`, baseRevision: 1, requestId })),
      { operation: "propose", requestId, proposal: { name: "Check", prompt: "Read", schedule: { kind: "interval", everyMs: 60_000 }, selection: { instanceId: "matrix_chatgpt_plan", model: "gpt-test" }, authorizedEffects: ["read"] } }];
    for (const op of operations) {
      expect(contracts.RoutineCliOperationSchema.safeParse(op).success).toBe(true);
      for (const key of ["ownerId", "computerId", "chatId", "botId", "source", "harness", "accountId", "grantId", "runtimeHandle"])
        expect(contracts.RoutineCliOperationSchema.safeParse({ ...op, [key]: "forged" }).success).toBe(false);
    }
    expect(contracts.RoutineCliOperationSchema.safeParse({ operation: "pause", routineId: `rt_${"a".repeat(24)}`, baseRevision: 0, requestId }).success).toBe(false);
  });
});
