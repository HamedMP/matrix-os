import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createRealBotStateDatabase, OWNER } from "./bot-state-support.js";
import { proposalFixture } from "./routine-cli-proposal-support.js";
let data: Awaited<ReturnType<typeof createRealBotStateDatabase>>, f: Awaited<ReturnType<typeof proposalFixture>>;
beforeEach(async () => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required for actual canonical proposal dispatch/transactions");
  data = await createRealBotStateDatabase(url); f = await proposalFixture(data.db, vi.fn);
});
afterEach(async () => { await f?.close(); await data?.destroy(); });
it("reserves before actual canonical admission dispatch and creates exactly one real pending approval", async () => {
  const receipt = await f.submit(); expect(receipt).toMatchObject({ receipt: { disposition: "queued" } });
  await f.canonical.drain();
  const current = await f.execute({ operation: "request", requestId: "de000000-0000-4000-8000-000000000100" });
  expect(current).toMatchObject({ receipt: { disposition: "queued" }, proposal: { handoff: "pending_approval", approval: "pending", routine: null } });
  expect(await f.db.selectFrom("bot_interactions").selectAll().execute()).toHaveLength(1);
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(1);
  expect(await f.db.selectFrom("bot_tasks").select("status").execute()).toEqual([{ status: "waiting_person" }]);
  expect(await f.db.selectFrom("bot_routines").selectAll().execute()).toHaveLength(0);
  expect(f.host.createRuntime).toHaveBeenCalledTimes(1); expect(f.host.stopRuntime).toHaveBeenCalledTimes(1);
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
});
it("keeps an unrelated waiting task untouched and activates only after the actual human decision", async () => {
  const { createBotTasksRepository } = await import("../../../packages/gateway/src/bots/repositories/tasks.js");
  const { TARGET_A } = await import("./routine-cli-request-support.js");
  const tasks = createBotTasksRepository(f.db), unrelated = await tasks.create({ ownerId: OWNER, ...TARGET_A, now: "2026-09-27T12:00:00.000Z" });
  const running = await tasks.transition({ ownerId: OWNER, taskId: unrelated.taskId, baseRevision: unrelated.revision, to: "running", runId: "run_unrelated", now: "2026-09-27T12:00:00.000Z" });
  await tasks.transition({ ownerId: OWNER, taskId: unrelated.taskId, baseRevision: running.revision, to: "waiting_person", now: "2026-09-27T12:00:00.000Z" });
  await f.submit(); await f.canonical.drain();
  expect(await tasks.get({ ownerId: OWNER, taskId: unrelated.taskId })).toMatchObject({ status: "waiting_person", runId: "run_unrelated" });
  const pending = await f.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  expect(pending.task_id).not.toBe(unrelated.taskId);
  const result = await f.interactions.resolve(OWNER, TARGET_A.chatId, pending.interaction_id, { kind: "approval", decision: "approve", baseRevision: Number(pending.revision) });
  expect(result.continuation?.clientRequestId).toBe("req_answer_" + pending.interaction_id);
  expect(await f.execute({ operation: "request", requestId: "de000000-0000-4000-8000-000000000100" })).toMatchObject({ receipt: { disposition: "queued" }, proposal: { approval: "approved", routine: { status: "active" } } });
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
  vi.mocked(f.runBot).mockImplementation(async input => ({ ok: true, reply: { runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 } }));
  const { createBotContinuationAdmitter } = await import("../../../packages/gateway/src/bots/continuations.js");
  await createBotContinuationAdmitter({ repository: f.chats, orchestrator: f.canonical })(f.principal, result.continuation!);
  await f.canonical.drain();
  expect(await f.db.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(2);
  expect(await tasks.get({ ownerId: OWNER, taskId: pending.task_id })).toMatchObject({ status: "completed" });
  expect(await tasks.get({ ownerId: OWNER, taskId: unrelated.taskId })).toMatchObject({ status: "waiting_person", runId: "run_unrelated" });
});
it("reconciles lost early canonical admission response and duplicate from a new source without a second task/approval", async () => {
  const real = f.transport.admitTurn; let calls = 0;
  f.transport.admitTurn = async (...args) => { calls++; await real(...args); throw new Error("Fixture lost early admission response"); };
  await f.submit(); await f.canonical.drain();
  const { context } = await import("./routine-cli-source-support.js");
  const other = await f.sources.register({ ...context("new_origin"), identity: { kind: "terminal_launch", sessionId: "s", incarnationId: "i", launchId: "l" } });
  const { propose } = await import("./routine-cli-request-support.js"); const operation = propose();
  await f.switchDefault();
  const result = await f.service(f.proposals).execute({ token: await f.token(operation, other), operation });
  expect(result).toMatchObject({ receipt: { disposition: "queued" }, proposal: { approval: "pending" } });
  expect(calls).toBe(1);
  expect(await f.db.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(1);
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(1);
});
it("accepted target task survives normal origin completion, while later target authority still applies", async () => {
  const real = f.proposals.consume;
  f.proposals.consume = async (binding, signal) => { f.state.live = false; return real(binding, signal); };
  await f.submit(); await f.canonical.drain();
  expect(await f.db.selectFrom("bot_interactions").selectAll().execute()).toHaveLength(1);
  expect(await f.db.selectFrom("bot_tasks").select("status").execute()).toEqual([{ status: "waiting_person" }]);
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
});
it.each(["source", "invocation", "target", "operation"] as const)("refuses mutation of verified %s at the actual task-claim policy boundary", async field => {
  let called = false;
  f.hooks.authorizeTarget = async input => {
    called = true;
    if (field === "source") input.source.generation = "changed_origin";
    if (field === "invocation") (input.invocation as { invocationId: string }).invocationId = "de000000-0000-4000-8000-000000000999";
    if (field === "target") input.target.chatId = "chat_target_b";
    if (field === "operation" && input.operation.operation === "propose") input.operation.proposal.prompt = "Changed approved intent";
    return true;
  };
  await f.submit(); await f.canonical.drain();
  expect(called).toBe(true);
  expect(await f.db.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
  expect(f.host.createRuntime).not.toHaveBeenCalled();
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
  expect(await f.execute({ operation: "request", requestId: "de000000-0000-4000-8000-000000000100" })).toMatchObject({
    receipt: { disposition: "queued" }, proposal: { handoff: "rejected", approval: null, routine: null },
  });
});
it.each(["background", "target source"] as const)("does not infer or create approval when %s is unavailable", async kind => {
  if (kind === "background") f.policy.background = false; else f.policy.sourceAllowed = false;
  await f.submit(); await f.canonical.drain();
  expect(await f.db.selectFrom("bot_interactions").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("bot_routines").selectAll().execute()).toHaveLength(0);
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
});
it("does not abandon an atomically committed pending proposal after recovery", async () => {
  await f.submit(); await f.canonical.drain();
  const dispatch = await f.db.selectFrom("routine_cli_proposals").selectAll().executeTakeFirstOrThrow();
  await f.tasks.abandon({ ownerId: OWNER, taskId: dispatch.task_id! });
  await f.adapter.recover!({ owner: { type: "personal", ownerId: OWNER }, runId: dispatch.run_id!, state: { taskId: dispatch.task_id! }, signal: new AbortController().signal });
  expect(await f.db.selectFrom("bot_tasks").select("status").execute()).toEqual([{ status: "waiting_person" }]);
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(1);
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
});
it("rolls pending interaction/approval/waiting/progress back when Stop wins before commit", async () => {
  const real = f.approvals.proposeWithin;
  f.approvals.proposeWithin = async (tx, binding, proposal) => { const result = await real(tx, binding, proposal); await f.tasks.cancel(binding.runId); return result; };
  await f.submit(); await f.canonical.drain();
  expect(await f.db.selectFrom("bot_interactions").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
  expect((await f.db.selectFrom("routine_cli_proposals").select("stage").executeTakeFirst())!.stage).not.toBe("pending_approval");
});
it.each(["owner", "Computer", "Chat", "Bot", "run", "task", "generation", "capability", "mode", "inference signal"] as const)("rejects changed actual registered %s before proposal writes without model fallback", async field => {
  const consume = f.proposals.consume;
  f.proposals.consume = async (binding, signal) => {
    if (field === "inference signal") f.registry.cancelInference(binding);
    else f.registry.bind({ ...binding,
      ...(field === "owner" ? { ownerId: "user_other" } : field === "Computer" ? { subscription: { ...binding.subscription!, computerId: "other_computer" } }
        : field === "Chat" ? { chatId: "chat_other" } : field === "Bot" ? { botId: "bot_abcdefgh" }
        : field === "run" ? { runId: "run_other" } : field === "task" ? { taskId: "task_abcdefgh" }
        : field === "generation" ? { executionGeneration: "2" } : field === "capability" ? { capabilities: [] }
        : { requestClass: "background" }) });
    return consume(binding, signal);
  };
  await f.submit(); await f.canonical.drain();
  expect(await f.db.selectFrom("bot_interactions").selectAll().execute()).toHaveLength(0);
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
});
it.each(["hash", "unknown reservation", "mode"] as const)("rejects actual canonical %s mismatch before target task claim", async field => {
  const begin = f.proposals.beginWithin;
  f.proposals.beginWithin = async (tx, input) => {
    if (field === "unknown reservation") await tx.db.updateTable("routine_cli_proposals").set({ canonical_request_id: "req_cli_routine_" + "f".repeat(32) }).execute();
    else await tx.db.updateTable("chat_runs").set(field === "hash" ? { request_hash: "f".repeat(64) } : { permission_mode: "read_only" }).where("id", "=", input.runId).execute();
    return begin(tx, input);
  };
  await f.submit(); await f.canonical.drain();
  expect(await f.db.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
});
it("reconciles a lost pending-commit ACK before generic failure/recovery and never duplicates the approval", async () => {
  let lost = false;
  f.hooks.transact = async (owner, work) => {
    let pendingWritten = false;
    const result = await f.transact(owner, async tx => {
      const value = await work(tx);
      pendingWritten = !!await tx.db.selectFrom("routine_cli_proposals").select("client_request_id").where("stage", "=", "pending_approval").executeTakeFirst();
      return value;
    });
    if (pendingWritten && !lost) { lost = true; throw new Error("Fixture lost approval commit ACK"); }
    return result;
  };
  await f.submit(); await f.canonical.drain();
  expect(lost).toBe(true);
  expect(await f.db.selectFrom("bot_tasks").select("status").execute()).toEqual([{ status: "waiting_person" }]);
  await f.submit(); await f.canonical.drain();
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(1);
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
});
it("commits waiting task before a fast owner decision and does not stale-settle after that decision", async () => {
  let answered = false;
  f.hooks.transact = async (owner, work) => {
    const result = await f.transact(owner, work);
    const pending = await f.db.selectFrom("routine_cli_proposals").select(["interaction_id", "task_id"]).where("stage", "=", "pending_approval").executeTakeFirst();
    if (pending?.interaction_id && !answered) {
      answered = true;
      expect((await f.db.selectFrom("bot_tasks").select("status").where("task_id", "=", pending.task_id!).executeTakeFirst())!.status).toBe("waiting_person");
      const interaction = await f.db.selectFrom("bot_interactions").selectAll().where("interaction_id", "=", pending.interaction_id).executeTakeFirstOrThrow();
      await f.interactions.resolve(OWNER, interaction.chat_id, interaction.interaction_id, { kind: "approval", decision: "approve", baseRevision: Number(interaction.revision) });
    }
    return result;
  };
  await f.submit(); await f.canonical.drain(); expect(answered).toBe(true);
  expect(await f.db.selectFrom("bot_tasks").select("status").execute()).toEqual([{ status: "waiting_person" }]);
  expect(await f.db.selectFrom("bot_routines").select("status").execute()).toEqual([{ status: "active" }]);
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
});
it("rolls actual approval, waiting, progress and outbox back on final registered-generation rejection, retaining earlier admission audit", async () => {
  const real = f.targets.validateClaimedTargetWithin; let observed = false;
  const consume = f.proposals.consume; let currentBinding: Parameters<typeof consume>[0] | undefined;
  f.proposals.consume = (binding, signal) => { currentBinding = binding; return consume(binding, signal); };
  f.targets.validateClaimedTargetWithin = async (tx, target) => {
    const result = await real(tx, target);
    const dispatch = await tx.selectFrom("routine_cli_proposals").selectAll().executeTakeFirstOrThrow();
    if (dispatch.stage === "pending_approval") {
      expect(await tx.selectFrom("bot_interactions").selectAll().execute()).toHaveLength(1);
      expect(await tx.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(1);
      expect(await tx.selectFrom("bot_tasks").select("status").execute()).toEqual([{ status: "waiting_person" }]);
      expect(await tx.selectFrom("chat_outbox").selectAll().where("event_type", "=", "interaction.requested").execute()).toHaveLength(1);
      observed = true; f.registry.bind({ ...currentBinding!, executionGeneration: "2" });
    }
    return result;
  };
  await f.submit(); await f.canonical.drain(); expect(observed).toBe(true);
  expect(await f.db.selectFrom("bot_interactions").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("chat_outbox").selectAll().where("event_type", "=", "interaction.requested").execute()).toHaveLength(0);
  expect(await f.db.selectFrom("chat_runs").selectAll().execute()).toHaveLength(1);
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
  expect((await f.db.selectFrom("routine_cli_proposals").select("stage").executeTakeFirst())!.stage).toBe("target_task_claimed");
  expect(await f.db.selectFrom("bot_tasks").select("status").execute()).toEqual([{ status: "failed" }]);
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
});

it.each(["binding replacement", "shared", "archived", "archived definition"] as const)("rechecks %s after task claim before proposal commit", async kind => {
  const real = f.proposals.consume;
  f.proposals.consume = async (binding, signal) => {
    if (kind === "archived definition") {
      const agent = (await f.agents.get({ type: "personal", ownerId: OWNER }, binding.botId))!;
      await f.agents.update({ type: "personal", ownerId: OWNER }, binding.botId, { baseRevision: agent.revision, archived: true });
    } else if (kind === "binding replacement") {
      const { createBotBindingsRepository } = await import("../../../packages/gateway/src/bots/repositories/bindings.js");
      const bindings = createBotBindingsRepository(f.db);
      await bindings.remove({ ownerId: OWNER, botId: binding.botId, chatId: binding.chatId, now: "2026-09-27T12:00:01.000Z" });
      await bindings.bindDirect({ ownerId: OWNER, botId: binding.botId, chatId: binding.chatId, now: "2026-09-27T12:00:02.000Z" });
    } else await f.db.updateTable("chats").set(kind === "shared" ? { collaboration: {} } : { lifecycle: "archived" }).where("id", "=", binding.chatId).execute();
    return real(binding, signal);
  };
  await f.submit(); await f.canonical.drain();
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0); expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
});
it.each(["cancel wins", "claim wins", "forged queue hash", "forged claim mapping"] as const)("reconciles exact canonical queue mapping when %s, without replay", async mode => {
  let releaseForeground!: () => void;
  const foreground = new Promise<void>(done => { releaseForeground = done; });
  vi.mocked(f.runBot).mockImplementation(async input => { if (input.command.kind === "bot.run" && input.command.runId === foregroundRun) await foreground;
    return { ok: true, reply: { runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 } }; });
  let foregroundRun = "";
  const { TARGET_A } = await import("./routine-cli-request-support.js");
  if (mode === "forged queue hash" || mode === "forged claim mapping") {
    const begin = f.proposals.beginWithin;
    f.proposals.beginWithin = async (tx, input) => {
      await tx.db.updateTable("chat_queued_turns").set(mode === "forged queue hash" ? { request_hash: "f".repeat(64) } : { claimed_turn_id: initial.turn.id })
        .where("claimed_run_id", "=", input.runId).execute();
      return begin(tx, input);
    };
  }
  const initial = await f.canonical.admitTurn(f.principal, { type: "personal", ownerId: OWNER }, TARGET_A.chatId, { clientRequestId: "req_foreground",
    baseRevision: (await f.chats.get({ type: "personal", ownerId: OWNER }, TARGET_A.chatId))!.chat.revision, parts: [{ type: "text", text: "Foreground fixture" }],
    selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default" });
  foregroundRun = initial.run.id;
  try {
    await f.submit();
    const queued = await f.db.selectFrom("chat_queued_turns").selectAll().where("client_request_id", "like", "req_cli_routine_%").executeTakeFirstOrThrow();
    expect(queued.status).toBe("queued");
    expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
    if (mode === "cancel wins") await f.chats.cancelQueuedTurn({ type: "personal", ownerId: OWNER }, { chatId: TARGET_A.chatId,
      queuedTurnId: queued.id, clientRequestId: "req_cancel_proposal", baseRevision: (await f.chats.get({ type: "personal", ownerId: OWNER }, TARGET_A.chatId))!.chat.revision,
      cancelledAt: "2026-09-27T12:00:01.000Z" });
    releaseForeground(); await f.canonical.drain();
    if (mode === "claim wins") {
      await expect.poll(async () => (await f.db.selectFrom("bot_approvals").selectAll().execute()).length, { timeout: 3000 }).toBe(1);
      await f.canonical.drain();
    }
    if (mode.startsWith("forged")) {
      await expect.poll(async () => (await f.db.selectFrom("chat_runs").selectAll().where("client_request_id", "like", "req_cli_routine_%").where("status", "=", "failed").execute()).length, { timeout: 3000 }).toBe(1);
      await f.canonical.drain();
    }
    const current = await f.execute({ operation: "request", requestId: "de000000-0000-4000-8000-000000000100" });
    expect(current).toMatchObject({ receipt: { disposition: "queued" }, proposal: { handoff: mode === "claim wins" ? "pending_approval" : "rejected" } });
    expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(mode === "claim wins" ? 1 : 0);
    expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run").map(([input]) => input.command.runId)).toEqual([foregroundRun]);
    if (mode === "claim wins") {
      const claimed = await f.db.selectFrom("chat_queued_turns").selectAll().where("id", "=", queued.id).executeTakeFirstOrThrow();
      expect(claimed.claimed_run_id).toBeTruthy();
      await expect(f.chats.cancelQueuedTurn({ type: "personal", ownerId: OWNER }, { chatId: TARGET_A.chatId, queuedTurnId: queued.id,
        clientRequestId: "req_cancel_too_late", baseRevision: (await f.chats.get({ type: "personal", ownerId: OWNER }, TARGET_A.chatId))!.chat.revision,
        cancelledAt: "2026-09-27T12:00:01.000Z" })).rejects.toThrow();
    }
  } finally { releaseForeground(); await f.canonical.drain(); }
});
it.each(["missing offered capability", "foreign route Computer"] as const)("refuses initially admitted %s, without fabricating authority", async kind => {
  if (kind === "missing offered capability") f.taskDependencies.routineTools = false; else f.subscription.computerId = "foreign_computer";
  await f.submit(); await f.canonical.drain();
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("bot_grants").selectAll().execute()).toHaveLength(0);
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
});
it("actual dispatch resolves immutable reservation while canonical response is still pending", async () => {
  let reached!: () => void; const entered = new Promise<void>(done => { reached = done; });
  let returned = false, observed = false; const begin = f.proposals.beginWithin, admit = f.transport.admitTurn;
  f.proposals.beginWithin = async (tx, input) => {
    expect(returned).toBe(false);
    expect(await tx.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
    expect((await tx.db.selectFrom("routine_cli_proposals").select("stage").executeTakeFirst())!.stage).toBe("submitting");
    observed = true; reached(); return begin(tx, input);
  };
  f.transport.admitTurn = async (...args) => { const admitted = await admit(...args); await entered; returned = true; return admitted; };
  await f.submit(); await f.canonical.drain(); expect(observed).toBe(true);
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(1);
});
it.each(["denied", "expired", "cancelled"] as const)("projects actual %s approval separately from immutable admission and never implies activation", async outcome => {
  await f.submit(); await f.canonical.drain();
  const pending = await f.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  if (outcome === "denied") await f.interactions.resolve(OWNER, pending.chat_id, pending.interaction_id, { kind: "approval", decision: "deny", baseRevision: Number(pending.revision) });
  if (outcome === "expired") f.state.clock = "2026-09-28T12:00:01.000Z";
  if (outcome === "cancelled") {
    const { createBotInteractionsRepository } = await import("../../../packages/gateway/src/bots/repositories/interactions.js");
    await createBotInteractionsRepository(f.db).cancel({ ownerId: OWNER, interactionId: pending.interaction_id, now: f.state.clock });
  }
  const { context } = await import("./routine-cli-source-support.js");
  const currentSource = await f.sources.register({ ...context("read_progress"), issuedAt: f.state.clock,
    expiresAt: new Date(Date.parse(f.state.clock) + 300000).toISOString(), identity: { kind: "terminal_launch", sessionId: "s", incarnationId: "i", launchId: "l" } });
  const operation = { operation: "request" as const, requestId: "de000000-0000-4000-8000-000000000100" };
  expect(await f.service().execute({ token: await f.token(operation, currentSource), operation })).toMatchObject({ receipt: { disposition: "queued" }, proposal: { approval: outcome, routine: null } });
  expect(await f.db.selectFrom("bot_routines").selectAll().execute()).toHaveLength(0);
});
it("rolls actual proposal writes back on A's final background-source rejection", async () => {
  const real = f.approvals.proposeWithin; let observed = false;
  f.approvals.proposeWithin = (tx, binding, proposal) => real({ ...tx, publish: async (...args) => {
    await tx.publish(...args);
    if (args[1] === "interaction.requested") { observed = true; f.policy.background = false; }
  } }, binding, proposal);
  await f.submit(); await f.canonical.drain(); expect(observed).toBe(true);
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("bot_interactions").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("bot_tasks").select("status").execute()).toEqual([{ status: "failed" }]);
});
it.each(["bot_child", "same target Chat"] as const)("fails closed for deferred %s existing-target binding reuse", async kind => {
  const { context } = await import("./routine-cli-source-support.js");
  const { propose, TARGET_A } = await import("./routine-cli-request-support.js");
  const source = await f.sources.register({ ...context("deferred_existing_target"), identity: kind === "bot_child"
    ? { kind: "bot_child", taskId: "task_abcdefgh", runId: "run_parent", runtimeHandle: "runtime_" + "f".repeat(32) }
    : { kind: "chat_run", chatId: TARGET_A.chatId, runId: "run_parent", route: "native" } });
  const operation = propose();
  await expect(f.service(f.proposals).execute({ token: await f.token(operation, source), operation })).rejects.toMatchObject({ code: "permission_denied" });
  expect(await f.db.selectFrom("routine_cli_proposals").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
  expect(f.host.createRuntime).not.toHaveBeenCalled();
});
it.each(["run", "run and turn"] as const)("does not fall back to model inference when a claimed intent's %s client identity becomes mismatched", async mode => {
  const consume = f.proposals.consume;
  f.proposals.consume = async (binding, signal) => {
    await f.transact(OWNER, async tx => {
      const run = await tx.db.updateTable("chat_runs").set({ client_request_id: "req_mismatched" }).where("id", "=", binding.runId).returning("turn_id").executeTakeFirstOrThrow();
      if (mode === "run and turn") await tx.db.updateTable("chat_turns").set({ client_request_id: "req_mismatched" }).where("id", "=", run.turn_id).execute();
    });
    return consume(binding, signal);
  };
  await f.submit(); await f.canonical.drain();
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
});
