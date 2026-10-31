import { BotBrokerError } from "../../../packages/bot-runtime/src/broker-client.js";
import { createConnection } from "node:net";
import { RoutineCliError } from "../../../packages/gateway/src/bots/routine-cli-errors.js";
import { afterEach, expect, it, vi } from "vitest";
import { managedPiFixture } from "./routine-cli-managed-pi-support.js";
import { proposal, TARGET_A } from "./routine-cli-request-support.js";
let f: Awaited<ReturnType<typeof managedPiFixture>> | undefined;
afterEach(async () => { await f?.close(); f = undefined; vi.unstubAllGlobals(); });
it("actual registered managed Pi worker/broker invokes published CLI and real canonical target with exact owner proof", async () => {
  const chatId = "chat_managed_routines", requestId = "de000000-0000-4000-8000-000000000a01";
  f = await managedPiFixture({ operation: "propose", requestId, proposal }, { hold: true });
  const admitted = await f.start(chatId, { permission: "supervised", interaction: "default" });
  await expect.poll(() => f!.sourceEvents.find(e => e.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  expect(f.bindings).toHaveLength(1); expect(f.bindings[0]).toMatchObject({ kind: "managed_chat", runId: admitted.run.id, capabilities: ["artifact.read", "routine.cli"] });
  expect(f.bindings[0]).not.toHaveProperty("taskId"); expect(f.bindings[0]).not.toHaveProperty("botId");
  const decision = f.sourceEvents.find(e => e.type === "approval.requested")!;
  if (decision.type !== "approval.requested") throw new Error("Missing owner decision");
  expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]);
  await f.approve(decision, chatId, admitted.run.id);
  await expect.poll(() => f!.result(), { timeout: 5000 }).toMatchObject({ ok: true });
  const result = f.result()!; if (!result.ok) throw new Error("Missing worker result");
  expect(JSON.parse(result.content.map(c => c.text).join(""))).toMatchObject({ ok: true, data: { receipt: { requestId, disposition: "queued" } } });
  await expect.poll(async () => await f!.data.db.selectFrom("bot_interactions").select("chat_id").execute()).toEqual([{ chat_id: TARGET_A.chatId }]);
  expect(await f.data.db.selectFrom("bot_tasks").select("chat_id").execute()).toEqual([{ chat_id: TARGET_A.chatId }]);
  const source = await f.data.db.selectFrom("routine_cli_sources").select(["source_context", "revoked_at"]).executeTakeFirstOrThrow();
  expect(source.source_context).toMatchObject({ harness: "pi", identity: { kind: "chat_run", route: "managed", chatId, runId: admitted.run.id } });
  expect(source.revoked_at).toBeNull(); expect(f.httpCalls()).toBe(1);
  f.finish(); await f.f.canonical.drain();
  expect((await f.data.db.selectFrom("routine_cli_sources").select("revoked_at").executeTakeFirstOrThrow()).revoked_at).not.toBeNull();
}, 15000);

it("managed metadata request creates no target task and retains read checkpoint semantics", async () => {
  f = await managedPiFixture({ operation: "request", requestId: "de000000-0000-4000-8000-000000000a02" });
  await f.start("chat_managed_read", { permission: "supervised", interaction: "default" }); await f.f.canonical.drain();
  expect(f.result()).toMatchObject({ ok: true, content: [{ text: expect.stringContaining('"not_observed"') }] });
  expect(f.httpCalls()).toBe(1);
  expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("managed_pi_tool_checkpoints").select(["effect_class", "phase"]).execute()).toEqual([{ effect_class: "read", phase: "observed_complete" }]);
}, 10000);

it.each(["owner", "Chat", "run", "turn", "provider", "scope", "worker", "generation"])("rejects wrong trusted %s instead of fabricating managed authority", async field => {
  f = await managedPiFixture({ operation: "list" });
  const register = f.runtime.registerManagedChat;
  f.runtime.registerManagedChat = async input => {
    if (field === "provider") await f!.data.db.updateTable("chat_runs").set({ driver_kind: "pi" }).where("id", "=", input.input.runId).execute();
    return register({ ...input,
    binding: { ...input.binding, ...(field === "worker" ? { runtimeHandle: `runtime_${"f".repeat(32)}` } : {}), ...(field === "generation" ? { executionGeneration: "99" } : {}) },
    input: { ...input.input, ...(field === "owner" ? { owner: { type: "personal", ownerId: "user_foreign" } as const } : {}),
      ...(field === "scope" ? { sharedScopeId: "shared_foreign" } : {}), ...(field === "Chat" ? { chatId: TARGET_A.chatId } : {}),
      ...(field === "run" ? { runId: "run_foreign" } : {}), ...(field === "turn" ? { turnId: "cturn_foreign" } : {}) } }); };
  await f.start("chat_managed_wrong", { permission: "supervised", interaction: "default" });
  await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(0);
  expect(await f.data.db.selectFrom("routine_cli_sources").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]);
}, 10000);

it.each(["cancel", "terminal", "parent", "worker-release"])("%s during exact owner wait fences authority independently of worker drainage", async ending => {
  const chatId = "chat_managed_wait", requestId = "de000000-0000-4000-8000-000000000a03";
  f = await managedPiFixture({ operation: "propose", requestId, proposal }, { hold: true });
  const admitted = await f.start(chatId, { permission: "supervised", interaction: "default" });
  await expect.poll(() => f!.sourceEvents.find(e => e.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const decision = f.sourceEvents.find(e => e.type === "approval.requested")!;
  if (decision.type !== "approval.requested") throw new Error("Missing exact decision");
  const binding = f.bindings[0]!;
  if (ending === "cancel") f.controls[0]!.abort();
  else if (ending === "terminal") await f.managed.events.publish(binding, { seq: 0, event: { type: "tool_progress", capability: "routine.cli", toolCallId: "call_managed_routine", phase: "cancelled" } });
  else if (ending === "worker-release") f.f.registry.release(binding.runtimeHandle);
  else await f.managed.adapter.cancel!({ owner: { type: "personal", ownerId: binding.ownerId }, chatId, runId: admitted.run.id });
  await expect(f.approve(decision, chatId, admitted.run.id)).rejects.toThrow();
  await expect.poll(async () => await f!.data.db.selectFrom("routine_cli_capabilities").selectAll().execute()).toEqual([]);
  expect(f.httpCalls()).toBe(0); expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
  if (ending === "terminal") {
    await expect.poll(() => f!.result(), { timeout: 5000 }).toMatchObject({ ok: true, content: [{ text: expect.stringContaining(requestId) }] });
    expect((await f.data.db.selectFrom("routine_cli_sources").select("revoked_at").executeTakeFirstOrThrow()).revoked_at).toBeNull();
  } else if (ending === "worker-release") {
    await expect.poll(async () => (await f!.data.db.selectFrom("routine_cli_sources").select("revoked_at").executeTakeFirstOrThrow()).revoked_at).not.toBeNull();
  }
  f.finish();
}, 15000);

it("raw forged source/task/Computer fields, unregistered worker and replay cannot create authority", async () => {
  f = await managedPiFixture({ operation: "list" }, { hold: true });
  await f.start("chat_managed_raw", { permission: "full_access", interaction: "default" });
  await expect.poll(() => f!.result(), { timeout: 5000 }).toMatchObject({ ok: true });
  const binding = f.bindings[0]!, base = { version: 1, requestId: "de000000-0000-4000-8000-000000000a04", action: "bot.tool", transport: "live", runtimeHandle: binding.runtimeHandle, executionGeneration: binding.executionGeneration, runId: binding.runId,
    tool: { toolCallId: "raw_call", capability: "routine.cli", args: { operation: "list" } } };
  for (const forged of [{ sourceId: "forged" }, { taskId: "task_fake" }, { computerId: "foreign" }, { ownerId: "foreign" }, { accepted: true }]) {
    expect(await f.actions.handleFrame({ ...base, tool: { ...base.tool, args: { ...base.tool.args, ...forged } } })).toBeUndefined();
  }
  expect(await f.actions.handleFrame({ ...base, runtimeHandle: `runtime_${"e".repeat(32)}` })).toMatchObject({ ok: false, code: "stale_generation" });
  expect(await f.actions.handleFrame({ ...base, executionGeneration: "99" })).toMatchObject({ ok: false, code: "stale_generation" });
  expect(await f.actions.handleFrame({ ...base, tool: { ...base.tool, toolCallId: "call_managed_routine" } })).toMatchObject({ ok: false, code: "denied" });
  const before = f.httpCalls(); f.finish(); await f.f.canonical.drain();
  expect(await f.actions.handleFrame(base)).toMatchObject({ ok: false, code: "stale_generation" });
  expect(f.httpCalls()).toBe(before);
}, 10000);

it.each(["tool completed", "parent ended"])("committed managed receipt survives %s only at the accepted claim boundary", async ending => {
  const chatId = "chat_managed_claim", requestId = "de000000-0000-4000-8000-000000000a05";
  f = await managedPiFixture({ operation: "propose", requestId, proposal }, { hold: true });
  let release!: () => void, entered = false, accepted = false, sourceSignal: AbortSignal | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const begin = f.runtime.proposals.beginWithin;
  f.runtime.proposals.beginWithin = async (tx, input) => { entered = true; await gate; return begin(tx, input); };
  const register = f.runtime.registerManagedChat;
  f.runtime.registerManagedChat = input => { sourceSignal = input.signal; return register({ ...input, current(invocation) { if (invocation?.accepted) accepted = true; return input.current(invocation); } }); };
  try {
    const admitted = await f.start(chatId, { permission: "supervised", interaction: "default" });
    await expect.poll(() => f!.sourceEvents.find(e => e.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
    const decision = f.sourceEvents.find(e => e.type === "approval.requested")!;
    if (decision.type !== "approval.requested") throw new Error("Missing owner decision");
    await f.approve(decision, chatId, admitted.run.id);
    await expect.poll(() => entered, { timeout: 5000 }).toBe(true);
    await expect.poll(() => f!.result(), { timeout: 5000 }).toMatchObject({ ok: true });
    expect((await f.data.db.selectFrom("routine_cli_requests").select("source_invocation").executeTakeFirstOrThrow()).source_invocation).not.toHaveProperty("accepted");
    if (ending === "parent ended") { f.f.registry.cancelInference(f.bindings[0]!); expect(sourceSignal?.aborted).toBe(true); }
    release();
    if (ending === "tool completed") {
      await expect.poll(async () => await f!.data.db.selectFrom("bot_interactions").select("chat_id").execute(), { timeout: 5000 }).toEqual([{ chat_id: TARGET_A.chatId }]);
      expect(accepted).toBe(true);
    } else {
      f.finish(); await f.f.canonical.drain();
      expect(await f.data.db.selectFrom("bot_interactions").selectAll().execute()).toEqual([]);
    }
  } finally { release(); }
}, 15000);

it("real issued unconsumed capability is retired at managed call end without waiting for CLI drain", async () => {
  const chatId = "chat_managed_issued", requestId = "de000000-0000-4000-8000-000000000a06";
  f = await managedPiFixture({ operation: "propose", requestId, proposal }, { hold: true });
  const execute = f.runtime.execute; let rejected: string | undefined;
  f.runtime.execute = async input => {
    expect(await f!.data.db.selectFrom("routine_cli_capabilities").select("consumed_at").execute()).toEqual([{ consumed_at: null }]);
    await f!.managed.events.publish(f!.bindings[0]!, { seq: 0, event: { type: "tool_progress", capability: "routine.cli", toolCallId: "call_managed_routine", phase: "completed" } });
    try { return await execute(input); } catch (error) { rejected = (error as { code: string }).code; throw error; }
  };
  const admitted = await f.start(chatId, { permission: "supervised", interaction: "default" });
  await expect.poll(() => f!.sourceEvents.find(e => e.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const decision = f.sourceEvents.find(e => e.type === "approval.requested")!;
  if (decision.type !== "approval.requested") throw new Error("Missing owner decision");
  await f.approve(decision, chatId, admitted.run.id);
  await expect.poll(() => rejected, { timeout: 5000 }).toBe("permission_denied");
  await expect.poll(async () => await f!.data.db.selectFrom("routine_cli_capabilities").select(["token_hash", "consumed_at"]).execute()).toEqual([{ token_hash: null, consumed_at: null }]);
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
}, 15000);

it("parent end after the real target claim preserves canonical target intent", async () => {
  const chatId = "chat_managed_claimed", requestId = "de000000-0000-4000-8000-000000000a07";
  f = await managedPiFixture({ operation: "propose", requestId, proposal }, { hold: true });
  const consume = f.runtime.proposals.consume;
  f.runtime.proposals.consume = async (binding, signal) => {
    expect(await f!.data.db.selectFrom("routine_cli_proposals").select("stage").where("client_request_id", "=", requestId).executeTakeFirstOrThrow()).toMatchObject({ stage: "target_task_claimed" });
    f!.f.registry.cancelInference(f!.bindings[0]!);
    return consume(binding, signal);
  };
  const admitted = await f.start(chatId, { permission: "supervised", interaction: "default" });
  await expect.poll(() => f!.sourceEvents.find(e => e.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const decision = f.sourceEvents.find(e => e.type === "approval.requested")!;
  if (decision.type !== "approval.requested") throw new Error("Missing owner decision");
  await f.approve(decision, chatId, admitted.run.id);
  await expect.poll(async () => await f!.data.db.selectFrom("bot_interactions").select("chat_id").execute(), { timeout: 5000 }).toEqual([{ chat_id: TARGET_A.chatId }]);
}, 15000);

it("default switch invalidates an exact displayed managed action with no fallback", async () => {
  const chatId = "chat_managed_switch";
  f = await managedPiFixture({ operation: "propose", requestId: "de000000-0000-4000-8000-000000000a08", proposal }, { hold: true });
  const admitted = await f.start(chatId, { permission: "supervised", interaction: "default" });
  await expect.poll(() => f!.sourceEvents.find(e => e.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
  const decision = f.sourceEvents.find(e => e.type === "approval.requested")!;
  if (decision.type !== "approval.requested") throw new Error("Missing owner decision");
  await f.f.switchDefault();
  await expect(f.approve(decision, chatId, admitted.run.id)).rejects.toMatchObject({ code: "revision_conflict" });
  expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
}, 15000);

it.each(["target archived", "missing authority"])("managed %s remains denied without a target task", async denial => {
  f = await managedPiFixture({ operation: "list" }, { omitAuthority: denial === "missing authority" });
  if (denial === "target archived") await f.data.db.updateTable("chats").set({ lifecycle: "archived" }).where("id", "=", TARGET_A.chatId).execute();
  await f.start("chat_managed_no_authority", { permission: "supervised", interaction: "default" }); await f.f.canonical.drain();
  expect(f.httpCalls()).toBe(0); expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]);
  expect(await f.data.db.selectFrom("routine_cli_capabilities").selectAll().execute()).toEqual([]);
}, 10000);

it("managed receipt reconciliation, real activation and CAS controls keep UUID dedup and current state truthful", async () => {
  const chatId = "chat_managed_control", requestId = "de000000-0000-4000-8000-000000000a10";
  f = await managedPiFixture({ operation: "propose", requestId, proposal }, { hold: true });
  const admitted = await f.start(chatId, { permission: "full_access", interaction: "default" });
  const approvals = () => f!.sourceEvents.filter(e => e.type === "approval.requested");
  await expect.poll(() => approvals().length, { timeout: 5000 }).toBe(1);
  const first = approvals()[0]!; if (first.type !== "approval.requested") throw new Error("Missing exact owner decision");
  await f.approve(first, chatId, admitted.run.id);
  await expect.poll(() => f!.result(), { timeout: 5000 }).toMatchObject({ ok: true });
  await expect.poll(async () => await f!.data.db.selectFrom("bot_interactions").selectAll().execute(), { timeout: 5000 }).toHaveLength(1);
  const pending = await f.data.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  await f.f.interactions.resolve(f.bindings[0]!.ownerId, TARGET_A.chatId, pending.interaction_id, { kind: "approval", decision: "approve", baseRevision: Number(pending.revision) });
  const binding = f.bindings[0]!;
  async function call(operation: import("@matrix-os/contracts").RoutineCliOperation, id: string) {
    const value = await f!.broker(binding).tool({ toolCallId: id, capability: "routine.cli", args: operation });
    if (!value.ok) throw new Error(value.code);
    return JSON.parse(value.content.map(c => c.text).join(""));
  }
  async function mutation(operation: import("@matrix-os/contracts").RoutineCliOperation, id: string) {
    const count = approvals().length, waiting = call(operation, id);
    await expect.poll(() => approvals().length, { timeout: 5000 }).toBe(count + 1);
    const decision = approvals()[count]!; if (decision.type !== "approval.requested") throw new Error("Missing exact owner decision");
    await f!.approve(decision, chatId, admitted.run.id); return waiting;
  }
  expect(await call({ operation: "request", requestId }, "call_request")).toMatchObject({ ok: true, data: { proposal: { approval: "approved", routine: { status: "active" } } } });
  const routine = await f.data.db.selectFrom("bot_routines").select(["routine_id", "revision"]).executeTakeFirstOrThrow();
  const pause = { operation: "pause" as const, routineId: routine.routine_id, baseRevision: Number(routine.revision), requestId: "de000000-0000-4000-8000-000000000a11" };
  expect(await mutation(pause, "call_pause")).toMatchObject({ ok: true, data: { receipt: { disposition: "applied", routine: { status: "paused", revision: Number(routine.revision) + 1 } } } });
  expect(await mutation(pause, "call_pause_duplicate")).toMatchObject({ ok: true, data: { receipt: { disposition: "applied" } } });
  expect(await mutation({ ...pause, requestId: "de000000-0000-4000-8000-000000000a12" }, "call_stale")).toMatchObject({ error: { code: "revision_conflict" } });
  await f.f.switchDefault();
  expect(await call({ operation: "request", requestId }, "call_original_receipt")).toMatchObject({ ok: true, data: { receipt: { requestId, disposition: "queued" }, proposal: { routine: { status: "paused" } } } });
  expect((await f.data.db.selectFrom("bot_routines").select("revision").execute()).map(row => Number(row.revision))).toEqual([Number(routine.revision) + 1]);
  expect(await f.data.db.selectFrom("bot_tasks").select("chat_id").execute()).toEqual([{ chat_id: TARGET_A.chatId }]);
  expect(binding.capabilities).toEqual(["artifact.read", "artifact.write", "routine.cli"]);
}, 20000);

it("managed review cannot turn existing file permissions into a remote routine action", async () => {
  f = await managedPiFixture({ operation: "propose", requestId: "de000000-0000-4000-8000-000000000a13", proposal });
  await f.start("chat_managed_review", { permission: "supervised", interaction: "review" }); await f.f.canonical.drain();
  expect(f.sourceEvents.some(e => e.type === "approval.requested")).toBe(false);
  expect(f.httpCalls()).toBe(0); expect(await f.data.db.selectFrom("routine_cli_capabilities").selectAll().execute()).toEqual([]);
}, 10000);

it.each(["owner wait", "issued capability"])("transport ONLY abort at %s retires the call while its real managed parent remains live", async boundary => {
  const chatId = "chat_managed_transport_only", requestId = "de000000-0000-4000-8000-000000000b01";
  f = await managedPiFixture({ operation: "list" }, { hold: true });
  const admitted = await f.start(chatId, { permission: "supervised", interaction: "default" });
  await expect.poll(() => f!.result(), { timeout: 5000 }).toMatchObject({ ok: true });
  await expect.poll(() => f!.workerLoopSettled(), { timeout: 5000 }).toBe(true);
  expect(f.workerEvents.some(e => e.type === "tool_progress" && e.phase === "completed")).toBe(true);
  const binding = f.bindings[0]!, parentSignal = f.f.registry.inferenceSignal(binding)!;
  const source = await f.data.db.selectFrom("routine_cli_sources").select("source_id").executeTakeFirstOrThrow();
  let release!: () => void, entered = false, denied: string | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const execute = f.runtime.execute;
  if (boundary === "issued capability") f.runtime.execute = async input => {
    if (input.operation.operation !== "propose") return execute(input);
    entered = true; await gate;
    try { return await execute(input); } catch (error) { denied = (error as { code: string }).code; throw error; }
  };
  const terminalBefore = f.workerEvents.filter(e => e.type === "tool_progress").length;
  const control = new AbortController();
  const pending = f.broker(binding).tool({ capability: "routine.cli", toolCallId: "call_transport_only", args: { operation: "propose", requestId, proposal } }, control.signal);
  void pending.catch((error: unknown) => {
    if (!(error instanceof BotBrokerError) || error.code !== "stale_generation") console.warn("[managed transport fixture] Unexpected call failure", error instanceof Error ? error.name : "UnknownError");
  });
  try {
    await expect.poll(() => f!.sourceEvents.find(e => e.type === "approval.requested"), { timeout: 5000 }).toMatchObject({ type: "approval.requested" });
    const decision = f.sourceEvents.find(e => e.type === "approval.requested")!;
    if (decision.type !== "approval.requested") throw new Error("Missing exact owner decision");
    expect(f.runtime.get(f.f.principal, decision.approvalId)).toMatchObject({ status: "pending" });
    if (boundary === "issued capability") {
      await f.approve(decision, chatId, admitted.run.id);
      await expect.poll(() => entered, { timeout: 5000 }).toBe(true);
      expect(await f.data.db.selectFrom("routine_cli_capabilities").select("consumed_at").where("source_id", "=", source.source_id).where("consumed_at", "is", null).execute()).toEqual([{ consumed_at: null }]);
    }
    control.abort(); await expect(pending).rejects.toMatchObject({ code: "stale_generation" });
    if (boundary === "owner wait") {
      await expect.poll(() => {
        try { f!.runtime.get(f!.f.principal, decision.approvalId); return false; } catch (error) { if (error instanceof RoutineCliError && error.code === "not_found") return true; throw error; }
      }, { timeout: 1500 }).toBe(true);
      await expect(f.approve(decision, chatId, admitted.run.id)).rejects.toThrow();
    } else {
      await expect.poll(async () => await f!.data.db.selectFrom("routine_cli_capabilities").select(["token_hash", "consumed_at"]).where("source_id", "=", source.source_id).where("consumed_at", "is", null).execute(), { timeout: 1500 }).toEqual([{ token_hash: null, consumed_at: null }]);
      release(); await expect.poll(() => denied, { timeout: 1500 }).toBe("permission_denied");
    }
    expect(parentSignal.aborted).toBe(false); expect(f.f.registry.lookupRun(binding)).toEqual(binding);
    expect((await f.data.db.selectFrom("routine_cli_sources").select("revoked_at").where("source_id", "=", source.source_id).executeTakeFirstOrThrow()).revoked_at).toBeNull();
    expect(f.workerEvents.filter(e => e.type === "tool_progress")).toHaveLength(terminalBefore);
    expect(await f.data.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([]);
    expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]);
  } finally { release(); }
}, 15000);

it("raw routine frame missing required live transport cannot reach owner action, source issuance or CLI", async () => {
  f = await managedPiFixture({ operation: "list" }, { hold: true });
  await f.start("chat_managed_no_live", { permission: "supervised", interaction: "default" });
  await expect.poll(() => f!.workerLoopSettled(), { timeout: 5000 }).toBe(true);
  const binding = f.bindings[0]!, before = f.httpCalls();
  const sourceBefore = await f.data.db.selectFrom("routine_cli_sources").select("source_id").execute();
  const capBefore = await f.data.db.selectFrom("routine_cli_capabilities").select(["source_id", "invocation_id"]).execute();
  const frame = { version: 1, requestId: "de000000-0000-4000-8000-000000000b03", runtimeHandle: binding.runtimeHandle, executionGeneration: binding.executionGeneration, runId: binding.runId,
    action: "bot.tool", tool: { toolCallId: "call_no_live", capability: "routine.cli", args: { operation: "propose", requestId: "de000000-0000-4000-8000-000000000b04", proposal } } };
  const output = await new Promise<string>((resolve, reject) => {
    const socket = createConnection({ path: f!.socketPath }); let text = "";
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("Missing-live fixture did not fail closed")); });
    socket.once("connect", () => socket.end(JSON.stringify(frame) + "\n"));
    socket.on("data", chunk => { text += chunk.toString("utf8"); if (text.length > 1024) { socket.destroy(); reject(new Error("Unexpected fixture output")); } });
    socket.once("error", reject); socket.once("close", () => resolve(text));
  });
  expect(output).toBe(""); expect(f.httpCalls()).toBe(before);
  expect(f.sourceEvents.some(e => e.type === "approval.requested")).toBe(false);
  expect(f.f.registry.inferenceSignal(binding)?.aborted).toBe(false);
  expect(await f.data.db.selectFrom("routine_cli_sources").select("source_id").execute()).toEqual(sourceBefore);
  expect(await f.data.db.selectFrom("routine_cli_capabilities").select(["source_id", "invocation_id"]).execute()).toEqual(capBefore);
  expect(await f.data.db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]);
}, 10000);
