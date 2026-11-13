import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as contracts from "../../../packages/contracts/src/bots/index.js";
import { BotStateError } from "../../../packages/gateway/src/bots/repositories/shared.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotRoutinesRepository } from "../../../packages/gateway/src/bots/repositories/routines.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { OWNER, NOW, at, createBotStateDatabase } from "./bot-state-support.js";
import { invocation, context } from "./routine-cli-source-support.js";
import { requestFixture, propose, insertRoutine, TARGET_A, TARGET_B, proposal } from "./routine-cli-request-support.js";

let fixture: Awaited<ReturnType<typeof requestFixture>>, destroy: () => Promise<void>;
beforeEach(async () => { const state = await createBotStateDatabase(); destroy = state.destroy; fixture = await requestFixture(state.db); });
afterEach(async () => { try { await fixture?.close(); } finally { await destroy?.(); } });
const tasks = () => fixture.db.selectFrom("bot_tasks").selectAll().execute();

describe("durable routine request ledger with an explicit atomic admission fixture port", () => {
  it("atomically stores one queued receipt, source consumption, local DB admission and canonical outbox event", async () => {
    const result = await fixture.execute(propose());
    expect(result).toMatchObject({ kind: "receipt", receipt: { requestId: invocation(100), disposition: "queued", revision: 1 } });
    expect(await tasks()).toHaveLength(1);
    expect(await fixture.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
    expect(await fixture.db.selectFrom("chat_outbox").selectAll().where("event_type", "=", "bot.task.updated").execute()).toHaveLength(1);
    expect(contracts.RoutineCliResultSchema.safeParse(result).success).toBe(true);
  });
  it("returns the original committed receipt after response loss, service recreation, new source and default switch", async () => {
    const first = await fixture.execute(propose()); if (first.kind !== "receipt") throw new Error("Expected receipt"); await fixture.switchDefault();
    const source = await fixture.sources.register({ ...context("generation_two"), identity: { kind: "terminal_launch", sessionId: "session", incarnationId: "incarnation", launchId: "launch" } });
    const result = await fixture.service().execute({ token: await fixture.token(propose(), source), operation: propose() });
    expect(result).toEqual(first); expect(await tasks()).toHaveLength(1);
    const row = await fixture.db.selectFrom("routine_cli_requests").select("target_snapshot").executeTakeFirstOrThrow();
    expect(row.target_snapshot).toMatchObject(TARGET_A);
    expect(await fixture.execute({ operation: "request", requestId: invocation(100) })).toMatchObject({ kind: "receipt", receipt: first.receipt });
  });
  it.each(["target", "source", "operation"] as const)("refuses admission port mutation of the verified %s snapshot", async field => {
    const result = await fixture.execute(propose(), { admitMutation: async input => {
      if (field === "target") { input.target.botId = TARGET_B.botId; input.target.chatId = TARGET_B.chatId; }
      if (field === "source") input.source.generation = "forged_generation";
      if (field === "operation") input.operation.requestId = invocation(999);
      return fixture.admitMutation(input);
    } });
    expect(result).toEqual({ kind: "unknown", requestId: invocation(100), disposition: "unknown", reconcile: true });
    expect(await tasks()).toHaveLength(0);
    expect(await fixture.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(0);
  });
  it("conflicts on changed input with the same durable UUID without another admission", async () => {
    await fixture.execute(propose());
    const changed = { operation: "propose", requestId: invocation(100), proposal: { ...proposal, name: "Different" } } satisfies contracts.RoutineCliOperation;
    await expect(fixture.execute(changed)).rejects.toMatchObject({ code: "request_conflict" });
    expect(await tasks()).toHaveLength(1);
  });
  it.each(["missing", "revoked", "expired", "scope"])("rejects %s source even when the request already has a receipt", async fault => {
    await fixture.execute(propose()); const operation = propose(), token = await fixture.token(operation);
    if (fault === "revoked") await fixture.sources.revoke(fixture.source);
    if (fault === "expired") fixture.state.clock = at(60_000);
    if (fault === "scope") fixture.state.operationAllowed = false;
    await expect(fixture.service().execute({ token: fault === "missing" ? undefined : token, operation })).rejects.toMatchObject({ code: fault === "missing" ? "source_context_required" : "permission_denied" });
    expect(await tasks()).toHaveLength(1);
  });
  it("rejects model identity overrides and missing target or mutation policy dependencies", async () => {
    await expect(fixture.service().execute({ token: "irrelevant", operation: propose(), ownerId: OWNER } as never)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(fixture.execute(propose(), { admitMutation: undefined })).rejects.toMatchObject({ code: "unavailable" });
    await expect(fixture.execute({ operation: "list" }, { authorizeTarget: undefined })).rejects.toMatchObject({ code: "unavailable" });
    expect(await tasks()).toHaveLength(0);
  });
  it("passes the original base revision to the admission port and propagates its rejection outside the transaction", async () => {
    const id = await insertRoutine(fixture.db, 1), operation = { operation: "pause" as const, routineId: id, baseRevision: 99, requestId: invocation(100) };
    const token = await fixture.token(operation);
    await expect(fixture.service({ admitMutation: async input => {
      expect(input.operation).toEqual(operation); throw new BotStateError("revision_conflict");
    } }).execute({ token, operation })).rejects.toMatchObject({ code: "revision_conflict" });
    expect(await fixture.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(0);
    expect((await fixture.db.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirst())?.consumed_at).toBeNull();
  });
  it.each(["lifecycle", "operation"] as const)("rolls back real receipt, outbox, admission and consumed capability after final %s rejection at execute entry", async boundary => {
    let writesObserved = false;
    await expect(fixture.execute(propose(), { sources: { consumeWithin: (trx, input, work) => fixture.sources.consumeWithin(trx, input, async (source, executor, verified) => {
      const result = await work(source, executor, verified);
      expect(await trx.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
      expect(await trx.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(1);
      expect(await trx.selectFrom("chat_outbox").selectAll().execute()).toHaveLength(1);
      expect((await trx.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirst())?.consumed_at).not.toBeNull();
      writesObserved = true;
      if (boundary === "lifecycle") fixture.state.live = false;
      else fixture.state.operationAllowed = false;
      return result;
    }) } })).rejects.toMatchObject({ code: "permission_denied" });
    expect(writesObserved).toBe(true);
    expect(await tasks()).toHaveLength(0);
    expect(await fixture.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(0);
    expect(await fixture.db.selectFrom("chat_outbox").selectAll().execute()).toHaveLength(0);
    expect((await fixture.db.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirst())?.consumed_at).toBeNull();
  });
  it.each(["shared", "archived", "removed", "recreated", "deleted"])("rechecks the original receipt target when it becomes %s, never falls back", async change => {
    await fixture.execute(propose()); await fixture.switchDefault();
    if (change === "deleted") await fixture.db.deleteFrom("chats").where("id", "=", TARGET_A.chatId).execute();
    if (change === "shared") await fixture.db.updateTable("chats").set({ collaboration: {} }).where("id", "=", TARGET_A.chatId).execute();
    if (change === "archived") await fixture.db.updateTable("chats").set({ lifecycle: "archived" }).where("id", "=", TARGET_A.chatId).execute();
    if (change === "removed" || change === "recreated") await createBotBindingsRepository(fixture.db).remove({ ownerId: OWNER, ...TARGET_A, now: at(1) });
    if (change === "recreated") await createBotBindingsRepository(fixture.db).bindDirect({ ownerId: OWNER, ...TARGET_A, now: at(2) });
    await expect(fixture.execute({ operation: "request", requestId: invocation(100) })).rejects.toMatchObject({ code: "target_unavailable" });
    expect(await tasks()).toHaveLength(change === "deleted" ? 0 : 1);
  });
  it.each(["ownerId", "computerId"] as const)("rejects a corrupted receipt target %s instead of following another scope", async field => {
    await fixture.execute(propose());
    const row = await fixture.db.selectFrom("routine_cli_requests").select("target_snapshot").executeTakeFirstOrThrow();
    await fixture.db.updateTable("routine_cli_requests").set({ target_snapshot: { ...row.target_snapshot, [field]: "foreign_scope" } }).execute();
    await expect(fixture.execute({ operation: "request", requestId: invocation(100) })).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("requires the verified invocation's actual target approval for overlapping identical reads", async () => {
    const expected: Record<string, string> = { [invocation(1)]: TARGET_A.chatId, [invocation(2)]: TARGET_B.chatId };
    const operation = { operation: "list" as const }, first = await fixture.token(operation); await fixture.switchDefault(); const second = await fixture.token(operation);
    const svc = fixture.service({ authorizeTarget: async ({ invocation: verified, target }) => expected[verified.invocationId] === target.chatId });
    await expect(svc.execute({ token: first, operation })).rejects.toMatchObject({ code: "permission_denied" });
    expect(await svc.execute({ token: second, operation })).toMatchObject({ kind: "list", routines: [] });
  });
  it("returns explicit unknown on a lost commit acknowledgement without re-admitting on reconciliation", async () => {
    const result = await fixture.execute(propose(), { transact: async (owner, work) => { await fixture.transact(owner, work); throw new Error("private connection lost after COMMIT"); } });
    expect(result).toEqual({ kind: "unknown", requestId: invocation(100), disposition: "unknown", reconcile: true });
    expect(await tasks()).toHaveLength(1);
    expect(await fixture.execute({ operation: "request", requestId: invocation(100) })).toMatchObject({ kind: "receipt", receipt: { disposition: "queued" } });
    await fixture.execute(propose()); expect(await tasks()).toHaveLength(1);
  });
  it("does not turn an unobserved receipt into a definitely-unapplied assertion", async () => {
    const operation = propose();
    const result = await fixture.execute(operation, { transact: async (owner, work) => fixture.transact(owner, async transaction => { await work(transaction); throw new Error("ambiguous transport failure"); }) });
    expect(result).toMatchObject({ kind: "unknown", reconcile: true }); expect(await tasks()).toHaveLength(0);
    expect(await fixture.execute({ operation: "request", requestId: invocation(100) })).toEqual({ kind: "not_observed", requestId: invocation(100), mayStillArrive: true });
  });
  it("retains explicit unknown disposition and never retries an uncertain admission port result", async () => {
    expect(await fixture.execute(propose(), { admitMutation: async () => ({ disposition: "unknown" }) })).toMatchObject({ receipt: { disposition: "unknown", reconcile: true } });
    await fixture.execute(propose()); expect(await tasks()).toHaveLength(0);
  });
  it("rejects a fake pending approval result and accepts only a real scoped pending human interaction", async () => {
    await expect(fixture.execute(propose(), { admitMutation: async () => ({ disposition: "pending_approval", interactionId: "in_missing12" }) })).rejects.toMatchObject({ code: "unavailable" });
    const result = await fixture.execute(propose(), { admitMutation: async ({ transaction, target }) => {
      const task = await createBotTasksRepository(transaction.db).create({ ...target, now: NOW }, transaction.db);
      const { interaction } = await createBotInteractionsRepository(transaction.db).create({ ...target, taskId: task.taskId, kind: "approval", payload: { question: "Approve exact fixture?" }, responderActorId: OWNER, blocking: true, expiresAt: at(60_000), now: NOW }, transaction.db);
      return { disposition: "pending_approval", interactionId: interaction.interactionId };
    } });
    expect(result).toMatchObject({ receipt: { disposition: "pending_approval" }, approval: "pending" });
    expect(JSON.stringify(result)).not.toContain("interactionId");
    fixture.state.clock = at(60_000);
    expect(await fixture.execute({ operation: "request", requestId: invocation(100) })).toMatchObject({ receipt: { disposition: "pending_approval" }, approval: "expired" });
  });
  it("separates an applied historical receipt from current routine state and never claims effects stopped", async () => {
    const id = await insertRoutine(fixture.db, 1), op = { operation: "pause" as const, routineId: id, baseRevision: 1, requestId: invocation(100) };
    const result = await fixture.execute(op, { admitMutation: async ({ transaction }) => {
      const record = await createBotRoutinesRepository(transaction.db).control({ ownerId: OWNER, routineId: id, baseRevision: 1, status: "paused", now: NOW }, transaction.db);
      return { disposition: "applied", routine: { routineId: id, status: record.status, revision: record.revision } };
    } });
    expect(result).toMatchObject({ receipt: { disposition: "applied", routine: { status: "paused", revision: 2 } }, current: { status: "paused" } });
    await createBotRoutinesRepository(fixture.db).control({ ownerId: OWNER, routineId: id, baseRevision: 2, status: "archived", now: at(1) });
    expect(await fixture.execute({ operation: "request", requestId: invocation(100) })).toMatchObject({ receipt: { routine: { status: "paused", revision: 2 } }, current: { status: "archived", revision: 3 } });
    expect(JSON.stringify(result)).not.toMatch(/stopped|cancelled|accountId|grantRevision|ownerId|taskId|runId|private/);
  });
});
