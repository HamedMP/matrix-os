import { afterEach, expect, it, vi } from "vitest";
import { claudeFixture, proposal, TARGET_A } from "./routine-cli-claude-support.js";
import { beginBotTask } from "../../../packages/gateway/src/bots/task-begin.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { context } from "./routine-cli-source-support.js";
const ownedAdmissions: string[] = [];
let f: Awaited<ReturnType<typeof claudeFixture>>;
afterEach(async () => { for (const handle of ownedAdmissions.splice(0)) await f?.f.admission.release(handle); await f?.close(); vi.unstubAllGlobals(); });
async function existing(options: Parameters<typeof claudeFixture>[0] = {}) {
  f = await claudeFixture(options); const input = await f.admit(TARGET_A.chatId, "matrix_bot", { permission: "default", interaction: "default" });
  const { task } = await f.f.transact(input.owner.ownerId, tx => beginBotTask(tx, { ownerId: input.owner.ownerId, ...TARGET_A, runId: input.runId, now: f.f.state.clock, text: "Fixture real parent" }));
  const runtime = await f.f.admission.admit({ ownerId: input.owner.ownerId, ...TARGET_A, taskId: task.taskId, runId: input.runId,
    route: { api: "openai-responses", modelId: proposal.selection.model, input: ["text"], contextWindow: 8192, maxOutputTokens: 256 }, accessSourceId: "matrix_chatgpt_plan",
    subscription: f.f.subscription, capabilities: ["routine.propose", "routine.control", "agent.task"], requestClass: "interactive" });
  ownedAdmissions.push(runtime.runtimeHandle);
  const binding = f.f.registry.lookupRun({ ...runtime, runId: input.runId }); if (!binding || "kind" in binding) throw new Error("Real admission missing binding");
  return { input, task, binding };
}
it("reuses only the actual admitted registered parent binding; proposal/wait/outbox/immutable receipt are atomic without canonical resubmit", async () => {
  const { binding, task } = await existing();
  const source = await f.f.sources.register({ ...context("existing"), harness: "claude", issuedAt: f.f.state.clock, expiresAt: new Date(Date.parse(f.f.state.clock) + 240000).toISOString(), generation: binding.executionGeneration, identity: { kind: "bot_child", taskId: task.taskId, runId: binding.runId, runtimeHandle: binding.runtimeHandle } });
  const operation = { operation: "propose" as const, requestId: "de000000-0000-4000-8000-000000000601", proposal };
  const submit = vi.spyOn(f.f.transport, "admitTurn");
  const result = await f.f.service(f.f.proposals).execute({ operation, token: await f.f.token(operation, source) });
  expect(result).toMatchObject({ kind: "receipt", receipt: { disposition: "pending_approval" }, proposal: { existingBinding: true, handoff: "pending_approval", approval: "pending", routine: null } });
  expect(submit).not.toHaveBeenCalled();
  expect(await f.data.db.selectFrom("bot_tasks").select(["task_id", "status", "run_id"]).execute()).toEqual([{ task_id: task.taskId, run_id: binding.runId, status: "waiting_person" }]);
  expect(await f.data.db.selectFrom("routine_cli_proposals").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
  expect(await f.runtime.proposals.recover({ ownerId: binding.ownerId, taskId: task.taskId, chatId: binding.chatId, runId: binding.runId })).toBe(true);
  const pending = await f.data.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  await f.f.interactions.resolve(binding.ownerId, binding.chatId, pending.interaction_id, { kind: "approval", decision: "approve", baseRevision: Number(pending.revision) });
  const reconciler = await f.f.sources.register({ ...context("reconciler"), issuedAt: f.f.state.clock, expiresAt: new Date(Date.parse(f.f.state.clock) + 240000).toISOString() });
  await f.f.switchDefault();
  const read = { operation: "request" as const, requestId: operation.requestId };
  const projected = await f.f.service(f.f.proposals).execute({ operation: read, token: await f.f.token(read, reconciler) });
  expect(projected).toMatchObject({ receipt: { disposition: "pending_approval" }, proposal: { existingBinding: true, approval: "approved", routine: { status: "active" } } });
  const duplicate = await f.f.service(f.f.proposals).execute({ operation, token: await f.f.token(operation, reconciler) });
  expect(duplicate).toMatchObject({ receipt: { disposition: "pending_approval" }, proposal: { approval: "approved" } });
  expect(submit).not.toHaveBeenCalled(); expect(await f.data.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(1);
});
it("actual delegated invocation and existing typed bridge run the fixed published CLI, not canonical direct routine dispatch", async () => {
  f = await claudeFixture();
  f.f.taskDependencies.executorReady = async () => true; // Native readiness/auth transport fixture only.
  let binding: import("../../../packages/gateway/src/bots/runtime-registry.js").BotRuntimeBinding;
  const started = vi.spyOn(f.f.tasks, "start");
  const { createNativeBotTasks } = await import("../../../packages/gateway/src/bots/native-task-service.js");
  const { createBotToolDispatcher } = await import("../../../packages/gateway/src/bots/tool-dispatcher.js");
  const { createBotBrokerActions } = await import("../../../packages/gateway/src/bots/broker-actions.js");
  const { createBotCheckpointsRepository } = await import("../../../packages/gateway/src/bots/repositories/checkpoints.js");
  const { createBotSessionsRepository } = await import("../../../packages/gateway/src/bots/repositories/sessions.js");
  let actualEnvelope: unknown;
  const direct = vi.fn(async () => { throw new Error("Native routine bypassed CLI"); });
  const requestId = "de000000-0000-4000-8000-000000000702";
  const native = createNativeBotTasks({ homePath: f.f.home, registry: f.f.registry, lifetime: new AbortController().signal,
    routineCli: { runtime: f.runtime, ...f.transport }, publishRoutineAction: (parent, event) => { f.f.tasks.publishRoutineAction(parent, event); if (event.type === "approval.requested") void f.approve(event, parent.chatId, parent.runId); },
    profileGuard: { acquire: async () => () => {} }, connections: { admit: async () => ({ revision: 1, grantRevision: 1, model: "fixture-native-model", sessionId: null }), saveSession: async () => {} },
    callTool: (parent, request, signal) => broker.callTool(parent, request, signal),
    runTask: async input => {
      await input.onStart?.();
      const result = await fetch(input.mcpUrl, { method: "POST", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${input.mcpToken}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "call", tool: { capability: "routine.propose", requestId, args: proposal } }) });
      expect(result.status).toBe(200); const body = await result.json(); actualEnvelope = JSON.parse(body.content[0].text);
      const repeated = await fetch(input.mcpUrl, { method: "POST", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${input.mcpToken}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "call", tool: { capability: "routine.propose", requestId, args: proposal } }) });
      const repeatedBody = await repeated.json(); expect(JSON.parse(repeatedBody.content[0].text)).toMatchObject({ error: { code: "permission_denied" } });
      input.onEnd?.();
      return { text: "Fixture child complete", sessionId: "fixture-native-child" };
    },
  });
  const tools = createBotToolDispatcher({ homePath: f.f.home, routines: { propose: direct, list: direct, control: direct } as never, nativeTask: native });
  const broker = createBotBrokerActions({ db: f.data.db, registry: f.f.registry, sessions: createBotSessionsRepository(f.data.db), checkpoints: createBotCheckpointsRepository(f.data.db), tools,
    runs: f.f.tasks.runSource, events: f.f.tasks.eventSink, inference: { lifetime: new AbortController().signal } as never });
  try {
    vi.mocked(f.f.runBot).mockImplementation(async input => {
      if (input.command.kind !== "bot.run") return { ok: true, reply: {} };
      const actual = f.f.registry.lookupRun({ ...input, runId: input.command.runId });
      if (!actual || "kind" in actual) throw new Error("Real parent registry admission missing"); binding = actual;
      await native.execute(binding, "Fixture delegated request", f.f.home, new AbortController().signal);
      return { ok: true, reply: { runId: binding.runId, status: "completed", toolActions: 1, sessionRevision: 1 } };
    });
    await f.f.canonical.admitTurn(f.f.principal, { type: "personal", ownerId: "user_owner_1" }, TARGET_A.chatId, { clientRequestId: "req_actual_delegated_source", baseRevision: 0, parts: [{ type: "text", text: "Fixture delegated request" }], selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default" });
    await f.f.canonical.drain();
    expect(await started.mock.results[0].value.result).toMatchObject({ status: "waiting_person" });
    expect(actualEnvelope).toMatchObject({ ok: true, data: { receipt: { requestId, disposition: "pending_approval" }, proposal: { existingBinding: true, approval: "pending" } } });
    expect(f.httpCalls()).toBe(1); expect(direct).not.toHaveBeenCalled();
    expect(await createBotTasksRepository(f.data.db).get({ ownerId: binding!.ownerId, taskId: binding!.taskId })).toMatchObject({ status: "waiting_person", runId: binding!.runId });
    const { canonicalChatApprovals } = await import("@matrix-os/contracts");
    expect(canonicalChatApprovals((await f.f.chats.exportChat({ type: "personal", ownerId: binding!.ownerId }, binding!.chatId))!)).toEqual(expect.arrayContaining([expect.objectContaining({ pending: false, decision: "approve" })]));
    expect(await f.data.db.selectFrom("bot_tool_checkpoints").select("phase").execute()).toEqual([{ phase: "observed_complete" }, { phase: "observed_complete" }]);
  } finally { await native.close(); }
});
it.each(["missing", "generation", "task", "target", "capability", "plan", "review", "waiting", "revoked"])("rejects %s existing-binding mismatch without creating another target task", async fault => {
  const { binding, task } = await existing();
  if (fault === "missing") f.f.registry.release(binding.runtimeHandle);
  if (fault === "capability") f.f.registry.bind({ ...binding, capabilities: ["agent.task", "routine.control"] });
  if (fault === "plan") await f.data.db.updateTable("chat_runs").set({ interaction_mode: "plan" }).where("id", "=", binding.runId).execute();
  if (fault === "review") await f.data.db.updateTable("chat_runs").set({ interaction_mode: "review" }).where("id", "=", binding.runId).execute();
  if (fault === "waiting") await createBotTasksRepository(f.data.db).transition({ ownerId: binding.ownerId, taskId: task.taskId, baseRevision: task.revision, to: "waiting_person", now: f.f.state.clock });
  if (fault === "revoked") f.f.registry.cancelInference(binding);
  if (fault === "target") await f.f.switchDefault();
  const source = await f.f.sources.register({ ...context("mismatch"), harness: "claude", issuedAt: f.f.state.clock, expiresAt: new Date(Date.parse(f.f.state.clock) + 240000).toISOString(),
    generation: fault === "generation" ? "999" : binding.executionGeneration, identity: { kind: "bot_child", taskId: fault === "task" ? "task_wrong" : task.taskId, runId: binding.runId, runtimeHandle: binding.runtimeHandle } });
  const operation = { operation: "propose" as const, requestId: "de000000-0000-4000-8000-000000000703", proposal };
  await expect(f.f.service(f.f.proposals).execute({ operation, token: await f.f.token(operation, source) })).rejects.toMatchObject({ code: "permission_denied" });
  expect(await f.data.db.selectFrom("bot_approvals").selectAll().execute()).toEqual([]); expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_tasks").select("task_id").execute()).toEqual([{ task_id: task.taskId }]);
});
it("rolls back approval, own waiting transition, outbox and receipt when the real parent is revoked after A.proposeWithin", async () => {
  const { binding, task } = await existing(), beforeOutbox = await f.data.db.selectFrom("chat_outbox").select("cursor").execute();
  const original = f.f.approvals.proposeWithin;
  f.f.approvals.proposeWithin = async (...args) => { const result = await original(...args); f.f.registry.cancelInference(binding); return result; };
  const source = await f.f.sources.register({ ...context("rollback"), harness: "claude", issuedAt: f.f.state.clock, expiresAt: new Date(Date.parse(f.f.state.clock) + 240000).toISOString(),
    generation: binding.executionGeneration, identity: { kind: "bot_child", taskId: task.taskId, runId: binding.runId, runtimeHandle: binding.runtimeHandle } });
  const operation = { operation: "propose" as const, requestId: "de000000-0000-4000-8000-000000000704", proposal };
  await expect(f.f.service(f.f.proposals).execute({ operation, token: await f.f.token(operation, source) })).rejects.toMatchObject({ code: "permission_denied" });
  expect(await f.data.db.selectFrom("bot_approvals").selectAll().execute()).toEqual([]); expect(await f.data.db.selectFrom("bot_interactions").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]); expect(await f.data.db.selectFrom("chat_outbox").select("cursor").execute()).toEqual(beforeOutbox);
  expect(await createBotTasksRepository(f.data.db).get({ ownerId: binding.ownerId, taskId: task.taskId })).toMatchObject({ status: "running", runId: binding.runId, revision: task.revision });
});
it("actual delegated source cannot borrow another Bot default for list/show/control/request; original A UUID stays attached to A", async () => {
  const { binding } = await existing();
  const fixtureSource = await f.f.sources.register({ ...context("receipt_fixture"), issuedAt: f.f.state.clock, expiresAt: new Date(Date.parse(f.f.state.clock) + 240000).toISOString() });
  const a = { operation: "propose" as const, requestId: "de000000-0000-4000-8000-000000000706", proposal };
  await f.f.service().execute({ operation: a, token: await f.f.token(a, fixtureSource) }); // Explicit ledger admission fixture, not producer qualification.
  await f.f.switchDefault();
  const b = { ...a, requestId: "de000000-0000-4000-8000-000000000707" };
  await f.f.service().execute({ operation: b, token: await f.f.token(b, fixtureSource) });
  const source = await f.runtime.registerBotChild({ binding, signal: new AbortController().signal, current: () => true, publish: () => { throw new Error("Different target must not prompt for widening"); } });
  const { createFixedNativeRoutineCliInvoker } = await import("../../../packages/gateway/src/bots/routine-cli-invoker.js");
  const cli = createFixedNativeRoutineCliInvoker({ ...source, ...f.transport, cwd: f.f.home, homePath: f.f.home });
  try {
    for (const operation of [{ operation: "list" }, { operation: "show", routineId: "rt_000000000000000000000001" },
      { operation: "pause", routineId: "rt_000000000000000000000001", baseRevision: 1, requestId: "de000000-0000-4000-8000-000000000708" }] as const) {
      await expect(source.authorize({ operation, invocationId: crypto.randomUUID(), signal: new AbortController().signal })).rejects.toMatchObject({ code: "permission_denied" });
    }
    expect(await cli.invoke({ args: ["request", a.requestId] })).toMatchObject({ ok: true, data: { kind: "receipt", receipt: { requestId: a.requestId, disposition: "queued" } } });
    expect(await cli.invoke({ args: ["request", b.requestId] })).toMatchObject({ error: { code: "permission_denied" } }); expect(f.httpCalls()).toBe(1);
  } finally { await cli.close(); await source.revoke(); }
});
it("actual delegated executor exit fences an in-flight broker/CLI proposal before close while keeping its profile lease and session drainage", async () => {
  const { binding, task } = await existing();
  const { EventEmitter } = await import("node:events"), { PassThrough } = await import("node:stream");
  const { createNativeBotTasks } = await import("../../../packages/gateway/src/bots/native-task-service.js");
  const { runClaudeBotTask } = await import("../../../packages/gateway/src/bots/claude-task-executor.js");
  const { createBotToolDispatcher } = await import("../../../packages/gateway/src/bots/tool-dispatcher.js");
  const { createBotBrokerActions } = await import("../../../packages/gateway/src/bots/broker-actions.js");
  const { createBotCheckpointsRepository } = await import("../../../packages/gateway/src/bots/repositories/checkpoints.js");
  const { createBotSessionsRepository } = await import("../../../packages/gateway/src/bots/repositories/sessions.js");
  const child = Object.assign(new EventEmitter(), { pid: 127, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  const release = vi.fn(async () => {}), saveSession = vi.fn(async () => {});
  let spawned: Parameters<typeof runClaudeBotTask>[0] | undefined, claimStarted!: () => void, resumeClaim!: () => void;
  const claim = new Promise<void>(resolve => { claimStarted = resolve; }), resume = new Promise<void>(resolve => { resumeClaim = resolve; });
  const execute = f.runtime.execute; let claimed: Promise<unknown> | undefined;
  vi.spyOn(f.runtime, "execute").mockImplementation(input => { const work = execute(input); claimed = work.then(value => ({ value }), error => ({ error })); return work; });
  const propose = f.f.approvals.proposeWithin;
  f.f.approvals.proposeWithin = async (...args) => { claimStarted(); await resume; return propose(...args); };
  const service = createNativeBotTasks({ homePath: f.f.home, registry: f.f.registry, lifetime: new AbortController().signal,
    routineCli: { runtime: f.runtime, ...f.transport }, publishRoutineAction: (_parent, event) => { if (event.type === "approval.requested") void f.approve(event, binding.chatId, binding.runId); },
    profileGuard: { acquire: async () => release }, connections: { admit: async () => ({ revision: 1, grantRevision: 1, model: "fixture-native-model", sessionId: null }), saveSession },
    callTool: (parent, request, signal) => broker.callTool(parent, request, signal),
    runTask: input => { spawned = input; return runClaudeBotTask({ ...input, spawn: () => child }); },
  });
  const tools = createBotToolDispatcher({ homePath: f.f.home, nativeTask: service });
  const broker = createBotBrokerActions({ db: f.data.db, registry: f.f.registry, sessions: createBotSessionsRepository(f.data.db), checkpoints: createBotCheckpointsRepository(f.data.db), tools,
    runs: f.f.tasks.runSource, events: f.f.tasks.eventSink, inference: { lifetime: new AbortController().signal } as never });
  let settled = false;
  const work = service.execute(binding, "Fixture lifecycle", f.f.home, new AbortController().signal).then(value => { settled = true; return value; });
  let request: Promise<Response> | undefined;
  try {
    await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true));
    request = fetch(spawned!.mcpUrl, { method: "POST", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${spawned!.mcpToken}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "call", tool: { capability: "routine.propose", requestId: "de000000-0000-4000-8000-000000000709", args: proposal } }) });
    await claim;
    child.emit("exit", 0, null); // Keep inherited/open stdout and stderr alive: close has NOT occurred.
    child.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "drained child result", session_id: "fixture_drain_session" }) + "\n");
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(release).not.toHaveBeenCalled(); expect(saveSession).not.toHaveBeenCalled();
    resumeClaim(); await request;
    // Await the actual HTTP transaction even if its CLI transport has already cancelled.
    const outcome = await claimed!;
    expect(await f.data.db.selectFrom("bot_interactions").selectAll().execute()).toEqual([]);
    expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
    expect(outcome).toMatchObject({ error: { code: "permission_denied" } });
    expect(await createBotTasksRepository(f.data.db).get({ ownerId: binding.ownerId, taskId: task.taskId })).toMatchObject({ status: "running", revision: task.revision });
  } finally {
    resumeClaim(); child.emit("close", 0, null); await work; await request; await service.close();
  }
  expect(release).toHaveBeenCalledOnce(); expect(saveSession).toHaveBeenCalledWith(binding.ownerId, binding.botId, 1, "fixture_drain_session");
});
it("delegated source authorization and remembered-target mutation retain a consistent preference/owner/Chat order on two PG connections", async () => {
  const { LockOrderTrace, barrier, bounded } = await import("./routine-cli-lock-order-support.js");
  const trace = new LockOrderTrace(), held = barrier(), progress = barrier(), release = barrier();
  const { binding } = await existing({ dbPlugin: trace });
  const source = await f.runtime.registerBotChild({ binding, signal: new AbortController().signal, current: () => true, publish: () => {} });
  const preference = await f.f.targets.getStoredPreference(f.f.principal);
  trace.after = async event => {
    if (event.tag === "remember" && event.kind === "preference") { held.release(); await bounded(release.ready); }
    if (event.tag === "delegated" && event.kind === "sourceChat") progress.release();
  };
  trace.before = event => { if (event.tag === "delegated" && event.kind === "preference") progress.release(); };
  trace.active = true;
  const remember = trace.run("remember", () => f.f.targets.remember(f.f.principal, { ...TARGET_A, baseRevision: preference.revision })).then(value => ({ value }), error => ({ error }));
  let authorize: Promise<unknown> | undefined;
  try {
    await bounded(held.ready); // The real preference gate is held before the delegated transaction starts.
    authorize = trace.run("delegated", () => source.authorize({ invocationId: "de000000-0000-4000-8000-000000000801", operation: { operation: "list" }, signal: new AbortController().signal })).then(value => ({ value }), error => ({ error }));
    await bounded(progress.ready); release.release();
    expect(await remember).toMatchObject({ value: { revision: preference.revision + 1 } });
    expect(await authorize).toEqual({ value: true });
    const policyLock = trace.events.findIndex(event => event.tag === "delegated" && event.kind === "preference" && event.phase === "locked");
    expect(policyLock).toBeGreaterThanOrEqual(0);
    expect(trace.events.findIndex(event => event.tag === "delegated" && event.kind === "sourceChat" && event.phase === "locked")).toBeGreaterThan(policyLock);
  } finally { release.release(); await remember; await authorize; trace.close(); await source.revoke(); }
});
it("delegated and ordinary authorized source controls serialize routine-first on two PG connections without a Chat/routine deadlock", async () => {
  const { LockOrderTrace, barrier, bounded } = await import("./routine-cli-lock-order-support.js");
  const { insertRoutine } = await import("./routine-cli-request-support.js");
  const trace = new LockOrderTrace(), held = barrier(), progress = barrier(), release = barrier();
  const { binding } = await existing({ dbPlugin: trace });
  const source = await f.runtime.registerBotChild({ binding, signal: new AbortController().signal, current: () => true,
    publish: event => { if (event.type === "approval.requested") void f.approve(event, binding.chatId, binding.runId); } });
  const ordinaryInput = await f.admit("chat_other_control_source");
  const ordinary = await f.runtime.registerChat({ input: ordinaryInput, signal: ordinaryInput.signal, current: () => true,
    publish: event => { if (event.type === "approval.requested") void f.approve(event, ordinaryInput.chatId, ordinaryInput.runId); } });
  const routineId = await insertRoutine(f.data.db, 802);
  const operation = { operation: "pause" as const, requestId: "de000000-0000-4000-8000-000000000802", routineId, baseRevision: 1 };
  const otherOperation = { ...operation, requestId: "de000000-0000-4000-8000-000000000803" };
  const delegatedCall = { operation, invocationId: "de000000-0000-4000-8000-000000000804", signal: new AbortController().signal };
  const otherCall = { operation: otherOperation, invocationId: "de000000-0000-4000-8000-000000000805", signal: new AbortController().signal };
  expect(await source.authorize(delegatedCall)).toBe(true); expect(await ordinary.authorize(otherCall)).toBe(true);
  const token = (await source.issue(delegatedCall)).takeToken(), otherToken = (await ordinary.issue(otherCall)).takeToken();
  trace.after = async event => {
    if (event.tag === "ordinary" && event.kind === "routine") { held.release(); await bounded(release.ready); }
    if (event.tag === "delegated" && event.kind === "sourceChat") progress.release();
  };
  trace.before = event => { if (event.tag === "delegated" && event.kind === "routine") progress.release(); };
  trace.active = true;
  const other = trace.run("ordinary", () => f.runtime.execute({ operation: otherOperation, token: otherToken })).then(value => ({ value }), error => ({ error }));
  let delegated: Promise<unknown> | undefined;
  try {
    await bounded(held.ready); // Other real RequestService has acquired the actual routine row lock.
    delegated = trace.run("delegated", () => f.runtime.execute({ operation, token })).then(value => ({ value }), error => ({ error }));
    await bounded(progress.ready); release.release();
    expect(await other).toMatchObject({ value: { kind: "receipt", receipt: { disposition: "applied" } } });
    expect(await delegated).toMatchObject({ error: { code: "revision_conflict" } });
    const stored = await f.data.db.selectFrom("bot_routines").select(["revision", "status"]).where("routine_id", "=", routineId).executeTakeFirstOrThrow();
    expect({ ...stored, revision: Number(stored.revision) }).toEqual({ revision: 2, status: "paused" });
    expect(await f.data.db.selectFrom("routine_cli_requests").select("client_request_id").execute()).toEqual([{ client_request_id: otherOperation.requestId }]);
  } finally { release.release(); await other; await delegated; trace.close(); await source.revoke(); await ordinary.revoke(); }
});
