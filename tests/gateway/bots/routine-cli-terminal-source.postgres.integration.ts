import type { RoutineCliOperation } from "@matrix-os/contracts/routine-cli";
import { afterEach, expect, it } from "vitest";
import { terminalFixture } from "./routine-cli-terminal-support.js";
import { proposal, scope, TARGET_A } from "./routine-cli-request-support.js";
let f: Awaited<ReturnType<typeof terminalFixture>> | undefined;
afterEach(async () => {
  try {
    if (f) {
      expect(f.routines.list(f.f.principal)).toEqual([]);
      expect(f.platformCalls()).toBe(0);
    }
  } finally { await f?.close(); f = undefined; }
});
it.each(["claude", "codex", "hermes", "opencode", "pi"] as const)("canonical %s Terminal reaches target schedule approval through the published CLI/IPC/Hono/PG without an operation prompt", async harness => {
  f = await terminalFixture(); const tab = await f.launch(harness), requestId = crypto.randomUUID();
  expect(await f.data.db.selectFrom("routine_cli_sources").selectAll().execute()).toEqual([]);
  const result = await f.port().invoke({ operation: "propose", requestId, proposal }, f.writer, new AbortController().signal);
  expect(result).toMatchObject({ v: 1, ok: true, data: { receipt: { requestId, disposition: "queued" } } });
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

it("prepared workspace Terminal has the same prompt-free proposal path and independent schedule approval", async () => {
  f = await terminalFixture(); const tab = await f.launchPrepared(), requestId = crypto.randomUUID();
  const result = await f.port().invoke({ operation: "propose", requestId, proposal }, f.writer, new AbortController().signal);
  expect(result).toMatchObject({ v: 1, ok: true, data: { receipt: { requestId, disposition: "queued" } } });
  await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(1);
  const source = await f.data.db.selectFrom("routine_cli_sources").select("source_context").executeTakeFirstOrThrow();
  expect(source.source_context).toMatchObject({ ownerId: scope.ownerId, computerId: scope.computerId, harness: "pi",
    identity: { kind: "terminal_launch", sessionId: `${tab.workspaceId}:${tab.id}`, incarnationId: tab.incarnation } });
  expect(await f.data.db.selectFrom("bot_approvals").select("status").execute()).toEqual([{ status: "pending" }]);
  expect(await f.data.db.selectFrom("bot_routines").selectAll().execute()).toEqual([]);
}, 20_000);

it("rejects forged or ended writer proof before registering a Full Access mutation", async () => {
  f = await terminalFixture(); await f.launch();
  const propose = () => ({ operation: "propose" as const, requestId: crypto.randomUUID(), proposal });
  const signal = new AbortController().signal;
  const operation = propose();
  await expect(f.port().invoke(operation, { ...f.writer, start: "999" }, signal)).resolves.toMatchObject({
    ok: true, data: { kind: "unknown", requestId: operation.requestId },
  });
  f.endWriter();
  const ended = propose();
  await expect(f.port().invoke(ended, f.writer, signal)).resolves.toMatchObject({
    ok: true, data: { kind: "unknown", requestId: ended.requestId },
  });
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_sources").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
}, 20_000);

it.each(["before issue", "after issue"])("Terminal caller cancellation %s keeps root I/O alive and tombstones any unused capability", async phase => {
  f = await terminalFixture(); const tab = await f.launch(), requestId = crypto.randomUUID(), caller = new AbortController();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), settled = Promise.withResolvers<void>();
  const hold = <Args extends unknown[], Result>(next: (...args: Args) => Promise<Result>) => async (...args: Args) => {
    entered.resolve();
    await release.promise;
    try { return await next(...args); } finally { settled.resolve(); }
  };
  if (phase === "before issue") {
    const register = f.routines.register;
    f.routines.register = async producer => {
      const port = await register(producer);
      return { ...port, issue: hold(port.issue) };
    };
  } else f.routines.execute = hold(f.routines.execute);
  const pending = f.port().invoke({ operation: "propose", requestId, proposal }, f.writer, caller.signal);
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error("Terminal invocation ended before the cancellation checkpoint"); })]);
    expect(f.httpCalls()).toBe(phase === "after issue" ? 1 : 0);
    expect(f.routines.list(f.f.principal)).toEqual([]);
    if (phase === "after issue") {
      const capability = await f.data.db.selectFrom("routine_cli_capabilities").select("token_hash").executeTakeFirstOrThrow();
      expect(capability.token_hash).not.toBeNull();
    }
    caller.abort();
    expect(await pending).toMatchObject({ ok: true, data: { kind: "unknown", requestId, reconcile: true } });
    release.resolve();
    await settled.promise;
    const capabilities = await f.data.db.selectFrom("routine_cli_capabilities").select("token_hash").execute();
    expect(capabilities).toEqual(phase === "after issue" ? [{ token_hash: null }] : []);
    expect(await f.coordinator.available({ workspaceId: tab.workspaceId, tabId: tab.id })).toBe(true);
    expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
    expect(await f.data.db.selectFrom("bot_approvals").selectAll().execute()).toEqual([]);
    expect((await f.data.db.selectFrom("routine_cli_sources").select("revoked_at").execute())[0]!.revoked_at).toBeNull();
  } finally { caller.abort(); release.resolve(); }
}, 20_000);

it.each(["root end", "held proof loss", "canonical stop fence", "target collaboration", "target owner"])("current %s at capability consumption denies the mutation", async reason => {
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
  const result = await f.port().invoke({ operation: "propose", requestId, proposal }, f.writer, new AbortController().signal);
  expect(result).not.toMatchObject({ data: { receipt: { disposition: "queued" } } });
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]);
}, 20_000);

it.each(["before issue", "after issue"])("sharing the exact Terminal %s retires personal authority while keeping the tab live", async phase => {
  f = await terminalFixture(); const fixture = f, tab = await f.launch(), requestId = crypto.randomUUID();
  const ref = { workspaceId: tab.workspaceId, tabId: tab.id };
  let sharing: ReturnType<typeof fixture.shareTab> | undefined;
  if (phase === "after issue") {
    const execute = fixture.routines.execute;
    fixture.routines.execute = async input => {
      // Exercise the durable check independently from the same-Gateway synchronous retirement hook.
      await (sharing = fixture.shareTab(tab, false));
      return execute(input);
    };
  } else {
    const register = fixture.routines.register;
    fixture.routines.register = async producer => {
      const port = await register(producer);
      return { ...port, async issue(input) {
        await (sharing = fixture.shareTab(tab));
        return port.issue(input);
      } };
    };
  }
  const result = await fixture.port().invoke({ operation: "propose", requestId, proposal }, fixture.writer, new AbortController().signal);
  expect(sharing).toBeDefined();
  expect(await sharing).toMatchObject({ sharedControlMode: "shared", contributorControl: true });
  expect(fixture.httpCalls()).toBe(phase === "after issue" ? 1 : 0);
  expect(result).not.toMatchObject({ data: { receipt: { disposition: "queued" } } });
  expect(await f.coordinator.available(ref)).toBe(false);
  expect(await f.store.getTab(ref)).toMatchObject({ status: "running", accessScope: "owner" });
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_approvals").selectAll().execute()).toEqual([]);
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
  await pending; await f.f.canonical.drain();
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
  const call = (operation: RoutineCliOperation) => f!.port().invoke(operation, f!.writer, new AbortController().signal);
  const propose = { operation: "propose" as const, requestId, proposal };
  expect(await call(propose)).toMatchObject({ ok: true, data: { receipt: { requestId } } }); await f.f.canonical.drain();
  expect(await call(propose)).toMatchObject({ ok: true, data: { receipt: { requestId } } });
  expect(await f.port().invoke({ ...propose, proposal: { ...proposal, name: "Changed" } }, f.writer, new AbortController().signal)).toMatchObject({ error: { code: "request_conflict" } });
  expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(1);
  const interaction = await f.data.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  await f.f.interactions.resolve(scope.ownerId, TARGET_A.chatId, interaction.interaction_id, { kind: "approval", decision: "approve", baseRevision: Number(interaction.revision) });
  const routine = await f.data.db.selectFrom("bot_routines").selectAll().executeTakeFirstOrThrow();
  const baseRevision = Number(routine.revision), routineId = routine.routine_id;
  const pause = { operation: "pause" as const, requestId: crypto.randomUUID(), routineId, baseRevision };
  const paused = { ok: true, data: { receipt: { routine: { status: "paused", revision: baseRevision + 1 } } } };
  expect(await call(pause)).toMatchObject(paused);
  expect(await call(pause)).toMatchObject(paused);
  expect(await call({ operation: "resume", requestId: crypto.randomUUID(), routineId: routine.routine_id, baseRevision: Number(routine.revision) })).toMatchObject({ error: { code: "revision_conflict" } });
  expect(await call({ operation: "resume", requestId: crypto.randomUUID(), routineId, baseRevision: baseRevision + 1 })).toMatchObject({ ok: true, data: { receipt: { routine: { status: "active", revision: baseRevision + 2 } } } });
  expect(await call({ operation: "archive", requestId: crypto.randomUUID(), routineId, baseRevision: baseRevision + 2 })).toMatchObject({ ok: true, data: { receipt: { routine: { status: "archived", revision: baseRevision + 3 } } } });
  expect(await call({ operation: "resume", requestId: crypto.randomUUID(), routineId, baseRevision: baseRevision + 3 })).toMatchObject({ error: { code: "invalid_input" } });
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
  expect(await pending).toMatchObject({ ok: true, data: { receipt: { disposition: "queued" } } }); await f.f.canonical.drain();
  expect(managerChecks).toBeGreaterThanOrEqual(3);
  expect(managerDuringValidation).toBe(false);
  expect(await f.data.db.selectFrom("bot_approvals").select("status").execute()).toEqual([{ status: "pending" }]);
}, 20_000);
