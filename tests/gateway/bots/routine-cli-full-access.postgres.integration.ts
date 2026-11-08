import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql, type Kysely, type Transaction } from "kysely";
import { lockRoutineCliPreference, createRoutineCliPreferencesRepository } from "../../../packages/gateway/src/bots/repositories/routine-cli-preferences.js";
import { createRoutineCliRuntime } from "../../../packages/gateway/src/bots/routine-cli-runtime.js";
import { createRoutineCliExecutionRoutes } from "../../../packages/gateway/src/bots/routine-cli-routes.js";
import { createFixedNativeRoutineCliInvoker } from "../../../packages/gateway/src/bots/routine-cli-invoker.js";
import { createBotRoutineControl } from "../../../packages/gateway/src/bots/routine-control.js";
import { createBotRoutineApprovals } from "../../../packages/gateway/src/bots/routine-approval.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import type { OwnerCollaborationDatabase } from "../../../packages/gateway/src/collaboration/database.js";
import { createProjectInheritanceResolver } from "../../../packages/gateway/src/collaboration/project-inheritance.js";
import { reconcileProjectMembershipAtPublication } from "../../../packages/gateway/src/collaboration/project-membership-transition.js";
import { fullAccessFixture } from "./routine-full-access-support.js";
import { createRealBotStateDatabase, OTHER_OWNER } from "./bot-state-support.js";
import { insertRoutine, routineId } from "./routine-cli-request-support.js";
import { invocation } from "./routine-cli-source-support.js";

let data: Awaited<ReturnType<typeof createRealBotStateDatabase>>, f: Awaited<ReturnType<typeof fullAccessFixture>>;
let runtime: ReturnType<typeof createRoutineCliRuntime>, registry: BotRuntimeRegistry;
const closers: Array<() => Promise<unknown>> = [];
let timeOffset: number, httpCalls: number;
beforeEach(async () => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required for Full Access final issue/consume qualification");
  data = await createRealBotStateDatabase(url, { routineAuthority: true }); f = await fullAccessFixture(data); timeOffset = 0; httpCalls = 0;
  const transact = createBotStateTransactions(f.chats);
  const approvals = createBotRoutineApprovals({ db: f.db, transact, definitionRevision: async () => 1,
    source: { resolve: async () => { throw new Error("No background authorization in this isolated fixture"); } } });
  const control = createBotRoutineControl({ db: f.db, approvals, now: () => new Date().toISOString(), stopFire: async () => {} });
  registry = new BotRuntimeRegistry();
  runtime = createRoutineCliRuntime({ db: f.db, computerId: f.scope.computerId, configuredOwnerIds: [f.scope.ownerId, OTHER_OWNER],
    agents: f.agents, repository: f.chats, transact, approvals, control, registry, now: () => new Date(Date.now() + timeOffset),
    platform: { platformUrl: "https://platform.example.test", handle: "computer-one", machineId: "machine_one", runtimeSlot: "primary", token: "fixture-transport-only" } });
  runtime.bindCanonical({ admitTurn: async () => { throw new Error("This control fixture must not dispatch a proposal"); },
    enqueueQueuedTurn: async () => { throw new Error("This control fixture must not enqueue a proposal"); } });
  // Named proof-transport fixture only. The actual Gateway verification client still parses,
  // compares and bounds the response; Platform signing and native OS process proof are separate lanes.
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://platform.example.test/internal/containers/computer-one/routine-full-access/verify");
    const tuple = JSON.parse(String(init?.body));
    const proof = new Headers(init?.headers).get("x-matrix-routine-full-access-proof")!;
    return Response.json({ verified: await f.verify(tuple, proof) });
  });
});
afterEach(async () => {
  try {
    for (const close of closers.splice(0)) await close();
  } finally {
    try { await runtime?.close(); registry?.shutdown(); }
    finally { try { await f?.close(); } finally { await data?.destroy(); vi.unstubAllGlobals(); } }
  }
});
async function approveScope() {
  const created = await runtime.fullAccess.createChallenge(f.principal, f.chatId, { baseRevision: 0 }), challenge = created.challenge!;
  return runtime.fullAccess.submitDecision(f.principal, f.chatId, challenge.challengeId,
    { scopeDigest: challenge.scopeDigest, decision: "approve", clientRequestId: invocation(700) }, "browser-proof-fixture");
}
async function admittedSource() {
  const approved = await approveScope();
  const input = await f.admission(approved.consent!.scopeId);
  const release = await runtime.beforeRoutineFullAccessDispatch(input); if (release) closers.push(async () => release());
  const controller = new AbortController(), events: unknown[] = [];
  const source = await runtime.registerChat({ input: { owner: input.owner, chatId: input.chatId, turnId: input.turnId, runId: input.runId,
    prompt: "Fixture", parts: input.body.parts, selection: input.body.selection, permissionMode: input.run.permissionMode,
    interactionMode: input.run.interactionMode, signal: controller.signal }, signal: controller.signal, current: () => true, publish: event => events.push(event) });
  closers.push(source.revoke);
  return { source, controller, input, approved, events };
}
async function cli(source: Awaited<ReturnType<typeof admittedSource>>["source"]) {
  const app = new Hono(); app.route("/", createRoutineCliExecutionRoutes({ requests: { execute: input => { httpCalls++; return runtime.execute(input); } } }));
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  await new Promise<void>(done => { if (server.listening) done(); else server.once("listening", done); });
  closers.unshift(() => new Promise<void>((done, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : done()); }));
  const invoker = createFixedNativeRoutineCliInvoker({ binPath: resolve("packages/sync-client/bin/matrix.mjs"),
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/routine-cli/execute`, ...source });
  closers.unshift(invoker.close); return invoker;
}

async function stageProjectPublication() {
  const db = f.db as unknown as Kysely<OwnerCollaborationDatabase>;
  const projectScopeId = randomUUID(), authorityRuntimeId = "vps:full_access_scope_test", now = new Date();
  await db.insertInto("collaboration_scopes").values({
    id: projectScopeId, owner_type: "personal", owner_id: f.scope.ownerId, organization_id: "org_scope_test",
    kind: "project", resource_id: "project_full_access", parent_scope_id: null, membership_mode: "direct",
    lifecycle: "preparing", revision: 1, auth_epoch: 1, authority_runtime_id: authorityRuntimeId, authority_generation: 1,
    created_at: now, updated_at: now, deleted_at: null,
  }).execute();
  await createProjectInheritanceResolver({ db }).bindOwnedResource({
    projectScopeId, ownerId: f.scope.ownerId, kind: "chat", resourceId: f.chatId,
    authorityRuntimeId, authorityGeneration: 1, revision: 1, readiness: "ready",
  });
  return async (holdBeforeCommit?: (trx: Transaction<OwnerCollaborationDatabase>) => Promise<void>) => {
    await db.transaction().execute(async trx => {
      await trx.selectFrom("collaboration_scopes").select("id").where("id", "=", projectScopeId).forUpdate().executeTakeFirstOrThrow();
      await reconcileProjectMembershipAtPublication(trx, { projectScopeId, ownerType: "personal",
        ownerId: f.scope.ownerId, requestedBy: f.scope.ownerId, destinationAuthorityRuntimeId: authorityRuntimeId,
        destinationAuthorityGeneration: 1, now, createEventId: randomUUID });
      await trx.updateTable("collaboration_scopes").set({ lifecycle: "shared" }).where("id", "=", projectScopeId).execute();
      await holdBeforeCommit?.(trx);
    });
    expect(await db.selectFrom("chats").select("collaboration").where("id", "=", f.chatId).executeTakeFirstOrThrow())
      .toEqual({ collaboration: null });
    expect(await db.selectFrom("collaboration_scopes").select(["lifecycle", "membership_mode"])
      .where("kind", "=", "chat").where("resource_id", "=", f.chatId).executeTakeFirstOrThrow())
      .toEqual({ lifecycle: "shared", membership_mode: "inherited" });
  };
}

it("refuses Full Access consent for a project-published source Chat", async () => {
  const publish = await stageProjectPublication();
  await publish();
  await expect(runtime.fullAccess.status(f.principal, f.chatId)).resolves.toMatchObject({
    eligibility: "ineligible", consent: null, challenge: null,
  });
  await expect(runtime.fullAccess.createChallenge(f.principal, f.chatId, { baseRevision: 0 })).rejects.toMatchObject({
    code: "permission_denied",
  });
  expect(f.verify).not.toHaveBeenCalled();
});

it.each(["consent", "turn admission"] as const)("rechecks %s after proof if the Project publishes while verification is in flight", async phase => {
  const publish = await stageProjectPublication();
  const installPublicationDuringProof = () => {
    const verify = f.verify.getMockImplementation()!;
    f.verify.mockImplementationOnce(async (tuple, proof) => {
      const verified = await verify(tuple, proof);
      await publish();
      return verified;
    });
  };
  if (phase === "consent") {
    installPublicationDuringProof();
    await expect(approveScope()).rejects.toMatchObject({ code: "permission_denied" });
  } else {
    const approved = await approveScope(), input = await f.admission(approved.consent!.scopeId);
    installPublicationDuringProof();
    await expect(runtime.beforeRoutineFullAccessDispatch(input)).rejects.toMatchObject({ code: "permission_denied" });
  }
  expect(f.verify).toHaveBeenCalledTimes(phase === "consent" ? 1 : 2);
  await expect(runtime.fullAccess.status(f.principal, f.chatId)).resolves.toMatchObject({
    eligibility: "ineligible", consent: null, challenge: null,
  });
});

it("published CLI uses canonical pause/archive/history while Full Access cannot create background authorization", async () => {
  const { source, events } = await admittedSource();
  await insertRoutine(f.db, 901, { botId: f.target.botId, chatId: f.target.chatId });
  const invoker = await cli(source), requestId = invocation(901);
  const result = await invoker.invoke({ args: ["pause", routineId(901), "--revision", "1", "--request-id", requestId] });
  expect(result).toMatchObject({ ok: true, data: { kind: "receipt", receipt: { disposition: "applied", requestId, routine: { status: "paused", revision: 2 } } } });
  expect(await invoker.invoke({ args: ["pause", routineId(901), "--revision", "1", "--request-id", requestId] })).toMatchObject({ ok: true, data: { receipt: { disposition: "applied" } } });
  expect(await invoker.invoke({ args: ["resume", routineId(901), "--revision", "2", "--request-id", invocation(908)] })).toMatchObject({ error: { code: "invalid_input" } });
  expect(await invoker.invoke({ args: ["archive", routineId(901), "--revision", "2", "--request-id", invocation(909)] })).toMatchObject({ ok: true,
    data: { receipt: { disposition: "applied", routine: { status: "archived", revision: 3 } } } });
  expect(events).toEqual([]); // No exact-operation card when all three genuine host gates are present.
  expect(httpCalls).toBe(4);
  expect((await f.db.selectFrom("bot_routines").select(["status", "revision"]).execute()).map(row => ({ ...row, revision: Number(row.revision) }))).toEqual([{ status: "archived", revision: 3 }]);
  expect(await f.db.selectFrom("routine_cli_requests").select("client_request_id").orderBy("client_request_id").execute()).toEqual([{ client_request_id: requestId }, { client_request_id: invocation(909) }]);
  expect(await f.db.selectFrom("bot_grants").selectAll().execute()).toEqual([]);
});

it("keeps published CLI list and show live in native plan mode while fencing every prior write", async () => {
  const { source, events } = await admittedSource();
  const id = routineId(917);
  await insertRoutine(f.db, 917, { botId: f.target.botId, chatId: f.target.chatId });
  const pause = { operation: "pause" as const, routineId: id, baseRevision: 1, requestId: invocation(917) };
  const signal = new AbortController().signal;
  const issued = { operation: pause, invocationId: invocation(918), signal };
  const approved = { operation: { ...pause, requestId: invocation(919) }, invocationId: invocation(920), signal };
  expect(await source.authorize(issued)).toBe(true);
  const token = (await source.issue(issued)).takeToken();
  expect(await source.authorize(approved)).toBe(true);

  source.narrowNativeMode("plan");
  await expect(source.issue(approved)).rejects.toMatchObject({ code: "permission_denied" });
  await expect(runtime.execute({ token, operation: pause })).rejects.toMatchObject({ code: "permission_denied" });
  source.narrowNativeMode("default");
  await expect(source.authorize({ ...issued, invocationId: invocation(921) })).rejects.toMatchObject({ code: "permission_denied" });

  const invoker = await cli(source);
  await expect(invoker.invoke({ args: ["list"] })).resolves.toMatchObject({
    ok: true, data: { kind: "list", routines: [{ routineId: id, status: "active", revision: 1 }] },
  });
  await expect(invoker.invoke({ args: ["show", id] })).resolves.toMatchObject({
    ok: true, data: { kind: "show", routine: { routineId: id, status: "active", revision: 1 } },
  });
  expect(httpCalls).toBe(2);
  expect(events).toEqual([]);
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
});

it.each(["project publication", "run completion", "target revision"] as const)(
  "revalidates a plan-mode read when %s occurs after capability issue", async change => {
    const { source, input } = await admittedSource();
    source.narrowNativeMode("plan");
    const operation = { operation: "list" as const };
    const call = { operation, invocationId: invocation(922), signal: new AbortController().signal };
    expect(await source.authorize(call)).toBe(true);
    const token = (await source.issue(call)).takeToken();
    if (change === "project publication") await (await stageProjectPublication())();
    if (change === "run completion") {
      await f.chats.finishRun(input.owner, { chatId: input.chatId, runId: input.runId, outcome: "completed", completedAt: new Date().toISOString() });
    }
    if (change === "target revision") await f.targets.remember(f.principal, { ...f.target, baseRevision: 1 });
    await expect(runtime.execute({ token, operation })).rejects.toMatchObject({ code: "permission_denied" });
  },
);

it("does not revive a source whose Full Access was already revoked before entering plan mode", async () => {
  const { source, approved } = await admittedSource();
  await runtime.fullAccess.revoke(f.principal, f.chatId, { baseRevision: approved.revision });
  source.narrowNativeMode("plan");
  await expect(source.authorize({ operation: { operation: "list" }, invocationId: invocation(923), signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: "permission_denied" });
});

it("holds the real preference gate through canonical consume and rejects a concurrent committed target revision", async () => {
  const { source } = await admittedSource(); await insertRoutine(f.db, 910, { botId: f.target.botId, chatId: f.target.chatId });
  const operation = { operation: "pause" as const, routineId: routineId(910), baseRevision: 1, requestId: invocation(910) };
  const call = { operation, invocationId: invocation(911), signal: new AbortController().signal };
  expect(await source.authorize(call)).toBe(true); const token = (await source.issue(call)).takeToken();
  const preference = await f.targets.getDefault(f.principal), held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const writer = f.db.transaction().execute(async trx => {
    await lockRoutineCliPreference(trx, f.scope);
    await createRoutineCliPreferencesRepository(trx).save({ ...f.scope, target: preference.target!, baseRevision: 1, now: new Date().toISOString() }, trx);
    held.resolve(); await release.promise;
  });
  let consumer: Promise<unknown> | undefined;
  try {
    await held.promise; let state = "pending";
    consumer = runtime.execute({ token, operation }).then(result => { state = "committed"; return result; }, error => { state = "rejected"; throw error; });
    void consumer.catch(() => undefined);
    await vi.waitFor(async () => {
      const locks = await sql<{ count: string }>`SELECT count(*)::text AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%'`.execute(f.db);
      expect(Number(locks.rows[0]?.count)).toBeGreaterThan(0);
    }, { timeout: 3000, interval: 20 });
    expect(state).toBe("pending"); release.resolve(); await writer;
    await expect(consumer).rejects.toMatchObject({ code: "permission_denied" });
    expect((await f.db.selectFrom("bot_routines").select("revision").execute()).map(row => Number(row.revision))).toEqual([1]);
  } finally { release.resolve(); await Promise.allSettled([writer, ...(consumer ? [consumer] : [])]); }
});

it.each(["revoke", "expiry", "source close", "target preference", "target incarnation", "project publication"])("rejects %s between authorization and final capability issue", async condition => {
  const { source, controller, approved } = await admittedSource();
  await insertRoutine(f.db, 902, { botId: f.target.botId, chatId: f.target.chatId });
  const operation = { operation: "pause" as const, routineId: routineId(902), baseRevision: 1, requestId: invocation(902) };
  const call = { operation, invocationId: invocation(903), signal: new AbortController().signal };
  expect(await source.authorize(call)).toBe(true);
  if (condition === "revoke") await runtime.fullAccess.revoke(f.principal, f.chatId, { baseRevision: approved.revision });
  if (condition === "expiry") timeOffset = 30 * 60_000 + 1;
  if (condition === "source close") controller.abort();
  if (condition === "target preference") await f.targets.remember(f.principal, { ...f.target, baseRevision: 1 });
  if (condition === "target incarnation") {
    await f.bindings.remove({ ...f.scope, ...f.target, now: new Date().toISOString() });
    await f.bindings.bindDirect({ ...f.scope, ...f.target, now: new Date(Date.now() + 1).toISOString() });
  }
  if (condition === "project publication") await (await stageProjectPublication())();
  await expect(source.issue(call)).rejects.toMatchObject({ code: "permission_denied" });
  if (condition === "project publication") {
    await expect(source.authorize({ ...call, invocationId: invocation(913) })).rejects.toMatchObject({ code: "permission_denied" });
  }
  expect((await f.db.selectFrom("bot_routines").select("revision").execute()).map(row => Number(row.revision))).toEqual([1]);
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
});

it("blocks capability consume behind real Project publication and refuses the stale lease after commit", async () => {
  const { source } = await admittedSource();
  await insertRoutine(f.db, 911, { botId: f.target.botId, chatId: f.target.chatId });
  const operation = { operation: "pause" as const, routineId: routineId(911), baseRevision: 1, requestId: invocation(914) };
  const call = { operation, invocationId: invocation(915), signal: new AbortController().signal };
  expect(await source.authorize(call)).toBe(true);
  const token = (await source.issue(call)).takeToken(), publish = await stageProjectPublication();
  const entered = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
  const publisher = publish(async trx => {
    const pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid;
    entered.resolve(pid); await release.promise;
  });
  let consumer: Promise<unknown> | undefined;
  try {
    const pid = await Promise.race([entered.promise, publisher.then(() => { throw new Error("Publication did not hold the Chat lock"); })]);
    consumer = runtime.execute({ token, operation });
    void consumer.catch(() => undefined);
    await vi.waitFor(async () => {
      const state = await sql<{ blocked: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
      ) AS blocked`.execute(f.db);
      expect(state.rows[0]?.blocked).toBe(true);
    }, { timeout: 3000, interval: 20 });
    release.resolve(); await publisher;
    await expect(consumer).rejects.toMatchObject({ code: "permission_denied" });
    await expect(source.authorize({ ...call, invocationId: invocation(916) })).rejects.toMatchObject({ code: "permission_denied" });
    expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
    expect(await f.db.selectFrom("bot_routines").select(["status", "revision"]).executeTakeFirstOrThrow())
      .toMatchObject({ status: "active", revision: "1" });
  } finally { release.resolve(); await Promise.allSettled([publisher, ...(consumer ? [consumer] : [])]); }
});

it("revalidates target preference and consent after capability issuance, before canonical mutation", async () => {
  const { source } = await admittedSource();
  await insertRoutine(f.db, 904, { botId: f.target.botId, chatId: f.target.chatId });
  const operation = { operation: "pause" as const, routineId: routineId(904), baseRevision: 1, requestId: invocation(904) };
  const call = { operation, invocationId: invocation(905), signal: new AbortController().signal };
  expect(await source.authorize(call)).toBe(true); const token = (await source.issue(call)).takeToken();
  await f.targets.remember(f.principal, { ...f.target, baseRevision: 1 });
  await expect(runtime.execute({ token, operation })).rejects.toMatchObject({ code: "permission_denied" });
  expect((await f.db.selectFrom("bot_routines").select("revision").execute()).map(row => Number(row.revision))).toEqual([1]);
});

it("cannot inspect or approve another owner's scope, nor reuse a recovered Run as a new full origin", async () => {
  const { source, input } = await admittedSource();
  await expect(runtime.fullAccess.status({ userId: OTHER_OWNER, source: "jwt" }, f.chatId)).resolves.toMatchObject({ eligibility: "ineligible", consent: null });
  await source.revoke();
  const events: string[] = [];
  const recovered = await runtime.registerChat({ input: { owner: input.owner, chatId: input.chatId, turnId: input.turnId, runId: input.runId,
    prompt: "Fixture", parts: input.body.parts, selection: input.body.selection, permissionMode: "full_access", interactionMode: "default", signal: new AbortController().signal },
    signal: new AbortController().signal, current: () => true, publish(event) { events.push(event.type); } });
  closers.push(recovered.revoke);
  const abort = new AbortController(), pending = recovered.authorize({ operation: { operation: "pause", routineId: routineId(906), baseRevision: 1, requestId: invocation(906) },
    invocationId: invocation(907), signal: abort.signal });
  // Recovered source can still use the old exact-confirmation path; it cannot auto-allow.
  await vi.waitFor(() => expect(events).toContain("approval.requested"), { timeout: 3000 });
  abort.abort(); expect(await pending).toBe(false);
});
