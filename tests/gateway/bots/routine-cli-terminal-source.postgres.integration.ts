import { afterEach, expect, it } from "vitest";
import { terminalFixture } from "./routine-cli-terminal-support.js";
import { proposal, scope, TARGET_A } from "./routine-cli-request-support.js";
let f: Awaited<ReturnType<typeof terminalFixture>> | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
it.each(["claude", "codex", "hermes", "opencode", "pi"] as const)("canonical %s Terminal produces actual source, published CLI/IPC/Hono/PG and real target approval", async harness => {
  f = await terminalFixture(); const tab = await f.launch(harness), requestId = crypto.randomUUID();
  expect(await f.data.db.selectFrom("routine_cli_sources").selectAll().execute()).toEqual([]);
  const pending = f.port().invoke({ operation: "propose", requestId, proposal }, f.writer, new AbortController().signal);
  await f.approve();
  expect(await pending).toMatchObject({ v: 1, ok: true, data: { receipt: { requestId, disposition: "queued" } } });
  await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(1);
  const sources = await f.data.db.selectFrom("routine_cli_sources").select("source_context").execute();
  expect(sources).toHaveLength(1);
  expect(sources[0]!.source_context).toMatchObject({ ownerId: scope.ownerId, computerId: scope.computerId, harness, identity: { kind: "terminal_launch", sessionId: `${tab.workspaceId}:${tab.id}`, incarnationId: tab.incarnation } });
  expect(await f.data.db.selectFrom("bot_tasks").select(["chat_id", "status"]).execute()).toEqual([{ chat_id: TARGET_A.chatId, status: "waiting_person" }]);
  expect(await f.data.db.selectFrom("bot_approvals").select("status").execute()).toEqual([{ status: "pending" }]);
  expect(await f.data.db.selectFrom("bot_routines").selectAll().execute()).toEqual([]);
  expect(JSON.stringify(await f.store.listWorkspaces())).not.toMatch(/rcli_|RoutineCapability|fixture-owner|held-private/);
}, 20_000);

it.each(["pending", "issued"])("Terminal caller cancellation at %s keeps root I/O alive and tombstones any unused capability", async phase => {
  f = await terminalFixture(); const tab = await f.launch(), requestId = crypto.randomUUID(), caller = new AbortController();
  let continueConsume!: () => void;
  const consumeGate = new Promise<void>(done => { continueConsume = done; });
  if (phase === "issued") {
    const execute = f.routines.execute;
    f.routines.execute = async input => { await consumeGate; return execute(input); };
  }
  const pending = f.port().invoke({ operation: "propose", requestId, proposal }, f.writer, caller.signal);
  await expect.poll(() => f!.routines.list(f!.f.principal).length).toBe(1);
  if (phase === "issued") { await f.approve(); await expect.poll(() => f!.httpCalls(), { timeout: 5000 }).toBe(1); }
  caller.abort();
  try {
    expect(await pending).toMatchObject({ ok: true, data: { kind: "unknown", requestId, reconcile: true } });
    if (phase === "issued") await expect.poll(async () => (await f!.data.db.selectFrom("routine_cli_capabilities").select("token_hash").execute())[0]?.token_hash).toBeNull();
    expect(await f.coordinator.available({ workspaceId: tab.workspaceId, tabId: tab.id })).toBe(true);
    expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
    expect(await f.data.db.selectFrom("bot_approvals").selectAll().execute()).toEqual([]);
    expect((await f.data.db.selectFrom("routine_cli_sources").select("revoked_at").execute())[0]!.revoked_at).toBeNull();
  } finally { continueConsume(); }
}, 20_000);

it.each(["root end", "held proof loss", "canonical stop fence", "target collaboration", "target owner"])("current %s after exact owner wait denies actual consume", async reason => {
  f = await terminalFixture(); const tab = await f.launch(), requestId = crypto.randomUUID();
  const execute = f.routines.execute;
  f.routines.execute = async input => {
    if (reason === "root end") f!.endRoot();
    if (reason === "held proof loss") f!.loseProof();
    if (reason === "canonical stop fence") await f!.store.fenceNativeHost({ workspaceId: tab.workspaceId, tabId: tab.id });
    if (reason === "target collaboration") await f!.data.db.updateTable("chats").set({ collaboration: { kind: "group" } as never }).where("id", "=", TARGET_A.chatId).execute();
    if (reason === "target owner") await f!.data.db.updateTable("chats").set({ owner_id: "user_other" }).where("id", "=", TARGET_A.chatId).execute();
    return execute(input);
  };
  const pending = f.port().invoke({ operation: "propose", requestId, proposal }, f.writer, new AbortController().signal);
  await f.approve(); const result = await pending;
  expect(result).not.toMatchObject({ data: { receipt: { disposition: "queued" } } });
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]);
}, 20_000);

it.each(["before claim", "after claim"])("actual root end %s respects canonical target independence", async phase => {
  f = await terminalFixture(); await f.launch(); const requestId = crypto.randomUUID();
  if (phase === "before claim") {
    const begin = f.routines.proposals.beginWithin;
    f.routines.proposals.beginWithin = async (tx, input) => { f!.endRoot(); return begin(tx, input); };
  } else {
    const consume = f.routines.proposals.consume;
    f.routines.proposals.consume = async (binding, signal) => { f!.endRoot(); return consume(binding, signal); };
  }
  const pending = f.port().invoke({ operation: "propose", requestId, proposal }, f.writer, new AbortController().signal);
  await f.approve(); await pending; await f.f.canonical.drain();
  expect(await f.data.db.selectFrom("bot_approvals").select("status").execute()).toEqual(phase === "after claim" ? [{ status: "pending" }] : []);
  expect(await f.data.db.selectFrom("bot_routines").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("routine_cli_requests").select("client_request_id").execute()).toEqual([{ client_request_id: requestId }]);
}, 20_000);

it.each(["live root", "ended root", "observed manager change"])("completed outer CLI accepts no new writer proof and claims only with %s", async state => {
  f = await terminalFixture(); await f.launch(); const requestId = crypto.randomUUID();
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  // Named target scheduling delay. Canonical admission, task and approval stay actual.
  const start = f.f.adapter.start.bind(f.f.adapter);
  f.f.adapter.start = async function* (input) { await gate; yield* start(input); };
  const pending = f.port().invoke({ operation: "propose", requestId, proposal }, f.writer, new AbortController().signal);
  try {
    await f.approve();
    expect(await pending).toMatchObject({ ok: true, data: { receipt: { requestId, disposition: "queued" } } });
    expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]);
    expect((await f.data.db.selectFrom("routine_cli_capabilities").select("consumed_at").execute())[0]!.consumed_at).not.toBeNull();
    f.endWriter(); if (state === "ended root") f.endRoot();
    if (state === "observed manager change") { f.changeManager(); expect(await f.observeManager()).toBe(false); }
  } finally { release(); }
  await f.f.canonical.drain();
  expect(await f.data.db.selectFrom("bot_approvals").select("status").execute()).toEqual(state === "live root" ? [{ status: "pending" }] : []);
  expect(await f.data.db.selectFrom("bot_routines").selectAll().execute()).toEqual([]);
}, 20_000);

it("same UUID reconciles once, changed payload conflicts, and control revisions/archive history remain canonical", async () => {
  f = await terminalFixture(); await f.launch(); const requestId = crypto.randomUUID();
  async function call(operation: import("@matrix-os/contracts/routine-cli").RoutineCliOperation) {
    const pending = f!.port().invoke(operation, f!.writer, new AbortController().signal); await f!.approve(); return pending;
  }
  const propose = { operation: "propose" as const, requestId, proposal };
  expect(await call(propose)).toMatchObject({ ok: true, data: { receipt: { requestId } } }); await f.f.canonical.drain();
  expect(await call(propose)).toMatchObject({ ok: true, data: { receipt: { requestId } } });
  expect(await f.port().invoke({ ...propose, proposal: { ...proposal, name: "Changed" } }, f.writer, new AbortController().signal)).toMatchObject({ error: { code: "request_conflict" } });
  expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(1);
  const interaction = await f.data.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  await f.f.interactions.resolve(scope.ownerId, TARGET_A.chatId, interaction.interaction_id, { kind: "approval", decision: "approve", baseRevision: Number(interaction.revision) });
  const routine = await f.data.db.selectFrom("bot_routines").selectAll().executeTakeFirstOrThrow();
  expect(await call({ operation: "pause", requestId: crypto.randomUUID(), routineId: routine.routine_id, baseRevision: Number(routine.revision) })).toMatchObject({ ok: true, data: { receipt: { routine: { status: "paused", revision: Number(routine.revision) + 1 } } } });
  expect(await call({ operation: "resume", requestId: crypto.randomUUID(), routineId: routine.routine_id, baseRevision: Number(routine.revision) })).toMatchObject({ error: { code: "revision_conflict" } });
  expect(await call({ operation: "archive", requestId: crypto.randomUUID(), routineId: routine.routine_id, baseRevision: Number(routine.revision) + 1 })).toMatchObject({ ok: true, data: { receipt: { routine: { status: "archived" } } } });
  expect(await call({ operation: "resume", requestId: crypto.randomUUID(), routineId: routine.routine_id, baseRevision: Number(routine.revision) + 2 })).toMatchObject({ error: { code: "invalid_input" } });
  expect(await f.data.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(1);
  expect(await f.data.db.selectFrom("bot_routines").select("status").execute()).toEqual([{ status: "archived" }]);
}, 30_000);

it("manager preflight stays outside source-generation transactions while local current checks retain the durable gate", async () => {
  f = await terminalFixture(); let inValidation = false, managerDuringValidation = false, managerChecks = 0;
  const register = f.routines.register;
  f.routines.register = producer => register({ ...producer, async validateWithin(...args) { inValidation = true; try { return await producer.validateWithin(...args); } finally { inValidation = false; } } });
  const verify = f.startup.verifyCurrent;
  f.startup.verifyCurrent = async () => { managerChecks++; if (inValidation) managerDuringValidation = true; return verify(); };
  await f.launch();
  const pending = f.port().invoke({ operation: "propose", requestId: crypto.randomUUID(), proposal }, f.writer, new AbortController().signal);
  await f.approve(); expect(await pending).toMatchObject({ ok: true, data: { receipt: { disposition: "queued" } } }); await f.f.canonical.drain();
  expect(managerChecks).toBeGreaterThanOrEqual(3);
  expect(managerDuringValidation).toBe(false);
  expect(await f.data.db.selectFrom("bot_approvals").select("status").execute()).toEqual([{ status: "pending" }]);
}, 20_000);
