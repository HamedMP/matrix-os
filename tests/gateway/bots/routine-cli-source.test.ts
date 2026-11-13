import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createRoutineCliSourceService } from "../../../packages/gateway/src/bots/routine-cli-source.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { NOW, OTHER_OWNER, OWNER, at, createBotStateDatabase } from "./bot-state-support.js";
import { SOURCE_SCOPE as scope, context, control, invocation, list } from "./routine-cli-source-support.js";

let db: Kysely<OwnerBotDatabase>, destroy: () => Promise<void>, clock: string, live: boolean, allowed: boolean;
const service = (limits = {}) => createRoutineCliSourceService({ db, scope, now: () => new Date(clock), limits,
  validateLifecycle: async () => live, authorizeOperation: async () => allowed });
beforeEach(async () => { ({ db, destroy } = await createBotStateDatabase()); clock = NOW; live = true; allowed = true; });
afterEach(async () => { await destroy(); });
const consume = (svc: ReturnType<typeof service>, token: string | undefined, operation = list) => db.transaction().execute(trx =>
  svc.consumeWithin(trx, { token, operation }, async source => source));

// Lifecycle/operation validators are fixtures. No source adapter or owner action approval is implemented by them.
describe("routine source generation and exact invocation capability", () => {
  it("keeps one canonical host invocation UUID across issuance policy and stored-capability consumption", async () => {
    const seen: string[] = [], expected = invocation(1);
    const svc = createRoutineCliSourceService({ db, scope, now: () => new Date(clock), validateLifecycle: async () => true,
      authorizeOperation: async (_source, _operation, _trx, verified) => { seen.push(verified.invocationId); return true; } });
    const ref = await svc.register(context());
    const token = (await svc.issue(ref, { invocationId: expected.toUpperCase(), operation: list })).takeToken();
    expect(await db.transaction().execute(trx => svc.consumeWithin(trx, { token, operation: list }, async (_source, _executor, verified) => verified.invocationId)))
      .toBe(expected);
    expect(seen).toEqual([expected, expected, expected]);
  });
  it("correlates identical read approvals by verified host invocation, never a latest operation digest", async () => {
    const approved = { [invocation(1)]: "target_one", [invocation(2)]: "target_two" };
    const svc = createRoutineCliSourceService({ db, scope, now: () => new Date(clock), validateLifecycle: async () => true,
      authorizeOperation: async (_source, _operation, _trx, verified) => !!verified && !!approved[verified.invocationId] });
    const ref = await svc.register(context());
    const first = (await svc.issue(ref, { invocationId: invocation(1), operation: list })).takeToken();
    const second = (await svc.issue(ref, { invocationId: invocation(2), operation: list })).takeToken();
    for (const [token, expected] of [[first, "target_one"], [second, "target_two"]]) {
      const result = await db.transaction().execute(trx => svc.consumeWithin(trx, { token, operation: list }, async (_source, _trx, verified) => approved[verified.invocationId]));
      expect(result).toBe(expected);
    }
  });
  it("consumes one exact invocation under a transaction and never returns a general owner principal", async () => {
    const svc = service(), source = await svc.register(context());
    const delivery = await svc.issue(source, { invocationId: invocation(1), operation: list });
    const token = delivery.takeToken();
    expect(await consume(svc, token)).toEqual(context());
    await expect(consume(svc, token)).rejects.toMatchObject({ code: "permission_denied" });
    expect(await db.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirst()).toMatchObject({ consumed_at: expect.anything() });
  });
  it("requires both lifecycle and exact-operation policy dependencies without permissive defaults", async () => {
    const base = { db, scope, now: () => new Date(clock) };
    for (const callbacks of [{}, { validateLifecycle: async () => true }, { authorizeOperation: async () => true }]) {
      const svc = createRoutineCliSourceService({ ...base, ...callbacks });
      await expect(svc.register(context())).rejects.toMatchObject({ code: "unavailable" });
    }
  });
  it("allows inactive source registration with no action scopes, never an executable capability", async () => {
    const svc = service(), source = await svc.register({ ...context(), actions: [] });
    await expect(svc.issue(source, { invocationId: invocation(1), operation: list })).rejects.toMatchObject({ code: "permission_denied" });
  });
  it.each(["claude", "codex", "hermes", "opencode", "pi"] as const)("keeps the actual %s identity in immutable stored source evidence", async harness => {
    const svc = service(), input = { ...context(), harness };
    const ref = await svc.register(input), delivery = await svc.issue(ref, { invocationId: invocation(1), operation: list });
    expect(await consume(svc, delivery.takeToken())).toEqual(input);
  });
  it("distinguishes native Pi, managed Pi and exact Terminal launch incarnations", async () => {
    const svc = service();
    const native = { ...context(), harness: "pi" as const };
    const managed = { ...native, identity: { kind: "chat_run" as const, chatId: "chat_source", runId: "run_source", route: "managed" as const } };
    const terminal = { ...native, identity: { kind: "terminal_launch" as const, sessionId: "session_one", incarnationId: "incarnation_one", launchId: "launch_one" } };
    const refs = [];
    for (const source of [native, managed, terminal]) refs.push(await svc.register(source));
    expect(new Set(refs.map(ref => ref.sourceId)).size).toBe(3);
  });
  it.each(["owner", "computer", "future", "expired", "identity override"])("rejects invalid %s registration from trusted-call boundary", async fault => {
    const input = context();
    if (fault === "owner") input.ownerId = OTHER_OWNER;
    if (fault === "computer") input.computerId = "foreign_computer";
    if (fault === "future") input.issuedAt = at(1);
    if (fault === "expired") input.expiresAt = NOW;
    if (fault === "identity override") Object.assign(input, { grantId: "forged" });
    await expect(service().register(input)).rejects.toMatchObject({ code: fault === "identity override" ? "invalid_input" : "permission_denied" });
  });
  it("registers duplicates idempotently but cannot change or revive an existing generation", async () => {
    const svc = service(), source = await svc.register(context());
    expect(await service().register(context())).toEqual(source);
    await expect(svc.register({ ...context(), actions: ["control"] })).rejects.toMatchObject({ code: "revision_conflict" });
    await svc.revoke(source);
    await expect(service().register(context())).rejects.toMatchObject({ code: "permission_denied" });
    expect(await svc.revoke(source)).toEqual({ revoked: true });
  });
  it("new generation revokes old credentials and stale registration cannot resurrect it in a new process", async () => {
    const svc = service(), first = await svc.register(context());
    const token = (await svc.issue(first, { invocationId: invocation(1), operation: list })).takeToken();
    const second = await service().register(context("generation_two"));
    expect(second).not.toEqual(first);
    await expect(consume(service(), token)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(service().register(context())).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("bounds authority to the exact operation payload and never accepts identity overrides", async () => {
    const svc = service(), source = await svc.register(context());
    const token = (await svc.issue(source, { invocationId: invocation(1), operation: control })).takeToken();
    for (const operation of [list, { ...control, baseRevision: 2 }, { ...control, operation: "resume" as const }])
      await expect(consume(svc, token, operation)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(db.transaction().execute(trx => svc.consumeWithin(trx, { token, operation: control, ownerId: OWNER } as never, async () => true)))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(svc.issue(source, { invocationId: invocation(1), operation: { ...control, baseRevision: 2 } })).rejects.toMatchObject({ code: "revision_conflict" });
    expect(await consume(svc, token, control)).toEqual(context());
  });
  it.each([undefined, "", "not-a-token", "rcli_" + "x".repeat(43)])("rejects absent/malformed/unknown capability %s", async token => {
    await expect(consume(service(), token)).rejects.toMatchObject({ code: token === undefined ? "source_context_required" : "permission_denied" });
  });
  it("checks configured owner and Computer instead of treating a token as an owner bearer", async () => {
    const svc = service(), source = await svc.register(context());
    const token = (await svc.issue(source, { invocationId: invocation(1), operation: list })).takeToken();
    for (const foreignScope of [{ ...scope, ownerId: OTHER_OWNER }, { ...scope, computerId: "foreign_computer" }]) {
      const foreign = createRoutineCliSourceService({ db, scope: foreignScope, now: () => new Date(clock), validateLifecycle: async () => true, authorizeOperation: async () => true });
      await expect(consume(foreign, token)).rejects.toMatchObject({ code: "permission_denied" });
    }
  });
  it("rechecks actual lifecycle and exact-action policy on issue and every use", async () => {
    const svc = service(), source = await svc.register(context());
    live = false;
    await expect(svc.issue(source, { invocationId: invocation(1), operation: list })).rejects.toMatchObject({ code: "permission_denied" });
    live = true; allowed = false;
    await expect(svc.issue(source, { invocationId: invocation(1), operation: list })).rejects.toMatchObject({ code: "permission_denied" });
    allowed = true; const token = (await svc.issue(source, { invocationId: invocation(1), operation: list })).takeToken();
    allowed = false; await expect(consume(svc, token)).rejects.toMatchObject({ code: "permission_denied" });
    allowed = true; live = false; await expect(consume(svc, token)).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("passes the required current action ceiling into source validation, including target revalidation", async () => {
    const svc = createRoutineCliSourceService({ db, scope, now: () => new Date(clock),
      validateLifecycle: async (_source, _trx, action) => action !== "control", authorizeOperation: async () => true });
    const ref = await svc.register(context());
    await db.transaction().execute(async trx => { expect(await svc.revalidateSource(context(), "control", trx)).toBe(false); });
    await expect(svc.issue(ref, { invocationId: invocation(1), operation: control })).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("persists only token hashes and provides one explicit private delivery without serializing its secret", async () => {
    const svc = service(), source = await svc.register(context());
    const delivery = await svc.issue(source, { invocationId: invocation(1), operation: list });
    const safe = JSON.stringify(delivery), token = delivery.takeToken();
    expect(token).toMatch(/^rcli_[A-Za-z0-9_-]{43}$/);
    expect(safe).not.toContain(token); expect(safe).not.toContain("rcli_");
    await expect(Promise.resolve().then(() => delivery.takeToken())).rejects.toMatchObject({ code: "permission_denied" });
    const rows = await db.selectFrom("routine_cli_capabilities").selectAll().execute();
    expect(JSON.stringify(rows)).not.toContain(token); expect(rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    await expect(svc.issue(source, { invocationId: invocation(1), operation: list })).rejects.toMatchObject({ code: "revision_conflict" });
  });
  it("rejects an expired invocation while its source generation is still live", async () => {
    const svc = service(), ref = await svc.register(context());
    const token = (await svc.issue(ref, { invocationId: invocation(1), operation: list })).takeToken();
    clock = at(60_000);
    await db.transaction().execute(async trx => { expect(await svc.revalidateSource(context(), "read", trx)).toBe(true); });
    await expect(consume(svc, token)).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("expiry is short and clamped to source lifetime, including while a transactional callback awaits", async () => {
    const svc = service(), source = await svc.register({ ...context(), expiresAt: at(500) });
    const delivery = await svc.issue(source, { invocationId: invocation(1), operation: list });
    expect(delivery.toJSON()).toEqual({ expiresAt: at(500) });
    const token = delivery.takeToken();
    await expect(db.transaction().execute(trx => svc.consumeWithin(trx, { token, operation: list }, async () => { clock = at(500); return true; })))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(consume(svc, token)).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("rolls token consumption and related DB work back together, preserving safe errors", async () => {
    const svc = service(), source = await svc.register(context()), token = (await svc.issue(source, { invocationId: invocation(1), operation: list })).takeToken();
    await expect(db.transaction().execute(trx => svc.consumeWithin(trx, { token, operation: list }, async () => {
      await trx.insertInto("routine_cli_preferences").values({ owner_id: OWNER, computer_id: scope.computerId, bot_id: null, chat_id: null, binding_created_at: null, revision: 1, updated_at: NOW }).execute();
      throw new Error("private-provider-secret");
    }))).rejects.toMatchObject({ code: "unavailable", message: "Routine request unavailable" });
    expect(await db.selectFrom("routine_cli_preferences").selectAll().execute()).toHaveLength(0);
    expect(await consume(svc, token)).toEqual(context());
  });
  it.each(["lifecycle", "operation policy"])("rolls admission back when current %s rejects after awaited DB work", async boundary => {
    const svc = service(), ref = await svc.register(context());
    const token = (await svc.issue(ref, { invocationId: invocation(1), operation: list })).takeToken();
    await expect(db.transaction().execute(trx => svc.consumeWithin(trx, { token, operation: list }, async () => {
      await trx.insertInto("routine_cli_preferences").values({ owner_id: OWNER, computer_id: scope.computerId, bot_id: null,
        chat_id: null, binding_created_at: null, revision: 1, updated_at: NOW }).execute();
      if (boundary === "lifecycle") live = false;
      else allowed = false;
      return "must not commit";
    }))).rejects.toMatchObject({ code: "permission_denied" });
    expect(await db.selectFrom("routine_cli_preferences").selectAll().execute()).toHaveLength(0);
    expect((await db.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirst())?.consumed_at).toBeNull();
    live = true; allowed = true;
    expect(await consume(svc, token)).toEqual(context());
  });
  it("uses the same transaction-aware generation validator as target resolution", async () => {
    const svc = service(), source = await svc.register(context());
    await db.transaction().execute(async trx => { expect(await svc.revalidateSource(context(), "read", trx)).toBe(true); });
    await svc.revoke(source);
    await db.transaction().execute(async trx => { expect(await svc.revalidateSource(context(), "read", trx)).toBe(false); });
  });
  it("caps active sources and capabilities, excluding historical tombstones and expired resources", async () => {
    const svc = service({ maxActiveSources: 1, maxCapabilitiesPerSource: 1, maxCapabilitiesPerScope: 1 });
    const source = await svc.register(context());
    await expect(svc.register({ ...context(), identity: { kind: "terminal_launch", sessionId: "s", incarnationId: "i", launchId: "l" } })).rejects.toMatchObject({ code: "unavailable" });
    const token = (await svc.issue(source, { invocationId: invocation(1), operation: list })).takeToken();
    await expect(svc.issue(source, { invocationId: invocation(2), operation: list })).rejects.toMatchObject({ code: "unavailable" });
    await consume(svc, token);
    await svc.issue(source, { invocationId: invocation(2), operation: list });
    await svc.revoke(source);
    const next = await svc.register({ ...context("generation_two"), identity: { kind: "terminal_launch", sessionId: "s", incarnationId: "i", launchId: "l" } });
    await expect(svc.issue(next, { invocationId: invocation(3), operation: list })).resolves.toHaveProperty("expiresAt");
  });
  it("performs bounded expired-hash cleanup during new capability issuance", async () => {
    const svc = service({ cleanupBatchSize: 2 }), ref = await svc.register(context());
    for (let n = 1; n <= 3; n++) await svc.issue(ref, { invocationId: invocation(n), operation: list });
    clock = at(60_000);
    await svc.issue(ref, { invocationId: invocation(4), operation: list });
    expect(await db.selectFrom("routine_cli_capabilities").selectAll().where("token_hash", "is not", null).execute()).toHaveLength(2);
    expect(await db.selectFrom("routine_cli_capabilities").selectAll().execute()).toHaveLength(4);
  });
  it("deletes expired capability hashes in bounded batches, retaining generation tombstones", async () => {
    const svc = service({ cleanupBatchSize: 2 }); const ref = await svc.register(context());
    const tokens: string[] = [];
    for (let n = 1; n <= 3; n++) tokens.push((await svc.issue(ref, { invocationId: invocation(n), operation: list })).takeToken());
    clock = at(60_000);
    expect(await svc.cleanup()).toEqual({ deleted: 2 });
    expect(await db.selectFrom("routine_cli_capabilities").selectAll().where("token_hash", "is not", null).execute()).toHaveLength(1);
    expect(await svc.cleanup()).toEqual({ deleted: 1 });
    for (const token of tokens) await expect(consume(svc, token)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(svc.issue(ref, { invocationId: invocation(1), operation: list })).rejects.toMatchObject({ code: "revision_conflict" });
    await svc.revoke(ref); await svc.cleanup();
    await expect(service().register(context())).rejects.toMatchObject({ code: "permission_denied" });
  });
});
