import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { chatGptPlanPeerProof } from "@matrix-os/contracts";
import { createChatGptPlanPeers } from "../../../packages/gateway/src/bots/chatgpt-plan-peers.js";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import { createBotRoutineScheduler } from "../../../packages/gateway/src/bots/routine-scheduler.js";
import { createBotRoutineCanonicalRunner } from "../../../packages/gateway/src/bots/continuations.js";
import { createBotRoutinesRepository } from "../../../packages/gateway/src/bots/repositories/routines.js";
import { forwardBotInference } from "../../../packages/gateway/src/bots/broker-inference.js";
import { withChatGptPlanProviderInstance } from "../../../packages/gateway/src/bots/chatgpt-plan-provider-instance.js";
import { claudeFixture, nativeProtocol, proposal, scope, TARGET_A } from "./routine-cli-claude-support.js";
import { BOT, OWNER } from "./bot-state-support.js";

let x: Awaited<ReturnType<typeof claudeFixture>>;
let peers: ReturnType<typeof createChatGptPlanPeers>;
let scheduler: ReturnType<typeof createBotRoutineScheduler>;
const bounded = async <T>(promise: Promise<T>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error("Combined-path boundary not reached")), 5000); })]); }
  finally { clearTimeout(timer); }
};
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Combined-path condition not reached");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
afterEach(async () => { await scheduler?.stop(); peers?.close(); await x?.close(); vi.unstubAllGlobals(); });

// Named faults: proposal reinference, broad-background routing, omitted native occurrence proof,
// fabricated source/target lineage, or skipping canonical fire settlement must fail this one path.
// Source native protocol, runtime host/root and final native/model reply are bounded fixtures.
// CLI process/private IPC, source controller/HTTP/auth, owner PG, approvals, scheduler, canonical
// admission/adapter/orchestrator/registry and inference broker/peer authority are production code.
it("runs one actual source CLI proposal through owner approval and a background-off canonical occurrence to the native inference boundary", async () => {
  x = await claudeFixture(); const f = x.f;
  const execution = createBotRoutineExecution({ db: f.db, transact: f.transact, approvals: f.approvals, now: () => new Date(f.state.clock) });
  f.adapterOptions.routines = execution; f.taskDependencies.routineExecution = execution;
  const canonical = { repository: f.chats, orchestrator: f.canonical }; execution.connect(canonical);
  peers = createChatGptPlanPeers({ db: f.db, ownerId: OWNER, computerId: scope.computerId,
    authorizeRoutine: (binding, signal) => { signal.throwIfAborted(); return execution.assertOccurrencePhase(binding as Parameters<typeof execution.assertOccurrencePhase>[0]); } });
  const keys = generateKeyPairSync("ed25519"), der = keys.publicKey.export({ type: "spki", format: "der" });
  const snapshot = { deviceId: createHash("sha256").update(der).digest("hex"), accountId: "fixture-account", grantRevision: 1,
    enabled: true, background: false, models: [{ id: proposal.selection.model, displayName: "Fixture", input: ["text" as const], contextWindow: 8192, maxOutputTokens: 256 }] };
  const challenge = peers.challenge(OWNER);
  const session = await peers.connect(OWNER, { version: 1, challenge: challenge.challenge, snapshot, publicKey: der.toString("base64url"),
    signature: sign(null, Buffer.from(chatGptPlanPeerProof({ ...challenge, snapshot })), keys.privateKey).toString("base64url") });
  expect(peers.capabilities(OWNER, session, false, false, true)).toMatchObject({ approvedRoutines: true });
  if (!f.catalog) throw new Error("Canonical fixture catalog required");
  Object.assign(f.catalog, await withChatGptPlanProviderInstance({ getCatalog: async () => f.catalog! }, peers).getCatalog(f.principal));
  const selected = { ...proposal.selection, options: [{ id: "accountId", value: snapshot.accountId }, { id: "grantRevision", value: "1" }] };
  const owner = { type: "personal" as const, ownerId: OWNER }, agent = (await f.agents.get(owner, BOT))!;
  await f.agents.update(owner, BOT, { baseRevision: agent.revision, selection: selected });
  const resolvedClasses: string[] = [];
  f.taskDependencies.resolveRoute = (selection, requestClass = "interactive") => {
    if (!selection) throw new Error("Real source selection required");
    resolvedClasses.push(requestClass); return peers.resolve(selection, OWNER, requestClass);
  };
  f.hooks.resolveRoutineSource = peers.resolve;
  f.taskDependencies.assertSource = async (binding, signal) => {
    if (binding.requestClass === "background") await execution.assertOccurrencePhase(binding as Parameters<typeof execution.assertOccurrencePhase>[0]);
    if (!await peers.revalidate(binding, signal)) throw new Error("Current native source required");
  };
  await expect(peers.resolve(selected, OWNER, "background")).rejects.toThrow();
  expect((await peers.observe(OWNER)).authorization).toMatchObject({ background: false });

  const requestId = "de000000-0000-4000-8000-000000000811", sourceChat = "chat_eng93_combined_source";
  const native = nativeProtocol(`matrix routines propose --input - --request-id ${requestId} <<'MATRIX_ROUTINE_JSON'\n${JSON.stringify(proposal)}\nMATRIX_ROUTINE_JSON`);
  x.adapter(native.spawn); const sourceTurn = await x.start(sourceChat);
  await until(() => x.sourceEvents.some(event => event.type === "approval.requested"));
  const sourceAction = x.sourceEvents.find(event => event.type === "approval.requested");
  if (sourceAction?.type !== "approval.requested") throw new Error("Exact source action approval required");
  await x.approve(sourceAction, sourceChat, sourceTurn.run.id);
  await until(() => Boolean(native.display()));
  expect(native.display()).toMatchObject({ ok: true, data: { receipt: { requestId, disposition: "queued" } } });
  expect(native.promptCount()).toBe(1); expect(x.httpCalls()).toBe(1);
  await until(async () => Boolean(await f.db.selectFrom("bot_interactions").select("interaction_id").executeTakeFirst()));
  native.end(); await bounded(f.canonical.drain());
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
  const receipt = await f.db.selectFrom("routine_cli_requests").selectAll().executeTakeFirstOrThrow();
  expect(receipt.source_context).toMatchObject({ harness: "claude", identity: { kind: "chat_run", chatId: sourceChat, runId: sourceTurn.run.id } });
  const dispatch = await f.db.selectFrom("routine_cli_proposals").selectAll().executeTakeFirstOrThrow();
  const interaction = await f.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  expect(interaction).toMatchObject({ interaction_id: dispatch.interaction_id, source_run_id: dispatch.run_id, task_id: dispatch.task_id, chat_id: TARGET_A.chatId });
  expect(dispatch.run_id).not.toBe(sourceTurn.run.id);
  await f.interactions.resolve(OWNER, interaction.chat_id, interaction.interaction_id,
    { kind: "approval", decision: "approve", baseRevision: Number(interaction.revision) });
  const repo = createBotRoutinesRepository(f.db), routine = (await repo.list(OWNER, BOT))[0]!;
  expect(routine).toMatchObject({ approvalId: interaction.interaction_id, status: "active", authorization: { accountId: snapshot.accountId, computerId: scope.computerId, grantRevision: 1 } });

  let workerRuns = 0;
  vi.mocked(f.runBot).mockImplementation(async input => {
    if (input.command.kind !== "bot.run") throw new Error("Unexpected worker control");
    workerRuns++;
    const binding = f.registry.lookupRun({ ...input, runId: input.command.runId });
    if (!binding || "kind" in binding) throw new Error("Actual admitted canonical binding required");
    expect(binding).toMatchObject({ ownerId: OWNER, botId: BOT, chatId: TARGET_A.chatId, requestClass: "background" });
    const spec = await f.tasks.runSource.loadRunSpec(binding);
    if (spec.turn.kind !== "prompt") throw new Error("Scheduled occurrence prompt required");
    expect(spec.systemPrompt).toContain("This turn executes one occurrence of an existing routine");
    expect(spec.turn).toMatchObject({ text: proposal.prompt });
    const result = await forwardBotInference({ version: 1, requestId: randomUUID(), runtimeHandle: binding.runtimeHandle, executionGeneration: binding.executionGeneration,
      action: "inference.responses", path: "/v1/responses", method: "POST", headers: {},
      body: JSON.stringify({ model: proposal.selection.model, input: [{ role: "user", content: spec.turn.text }], store: false, stream: true }) }, binding,
    modelId => f.registry.authorize({ ...binding, action: "inference.responses", modelId }),
    { homePath: f.home, chatgptPlan: peers, lifetime: new AbortController().signal, runSignal: f.registry.inferenceSignal(binding)!,
      revalidateBinding: candidate => peers.revalidate(candidate, new AbortController().signal) });
    expect(result).toMatchObject({ ok: true, status: 200 });
    if (!result.ok || !result.body.includes("composed fixture result")) throw new Error("Bounded synthetic native result required");
    await f.tasks.eventSink.publish(binding, { seq: 1, event: { type: "assistant_delta", text: "composed fixture result" } } as never);
    return { ok: true, reply: { runId: binding.runId, status: "completed", toolActions: 0, sessionRevision: 1 } };
  });
  scheduler = createBotRoutineScheduler({ repository: repo, authorize: f.approvals.authorize, run: createBotRoutineCanonicalRunner(canonical), now: () => new Date(f.state.clock) });
  f.state.clock = routine.nextFireAt!; await bounded(scheduler.tick());
  const fire = (await repo.fires(OWNER, routine.routineId))[0]!;
  const delivery = await bounded(peers.poll(OWNER, session));
  expect(delivery.requests).toHaveLength(1);
  const request = delivery.requests[0]!;
  const occurrenceTask = await f.db.selectFrom("bot_tasks").selectAll().where("task_id", "=", fire.taskId).executeTakeFirstOrThrow();
  expect(request).toMatchObject({ action: "infer", requestClass: "background", model: proposal.selection.model, runId: occurrenceTask.run_id, accountId: snapshot.accountId, computerId: scope.computerId, grantRevision: 1,
    approvedRoutine: { ownerId: OWNER, botId: BOT, chatId: TARGET_A.chatId, taskId: fire.taskId, runId: occurrenceTask.run_id,
      routineId: routine.routineId, fireId: fire.fireId, approvalId: interaction.interaction_id } });
  expect(fire.taskId).not.toBe(dispatch.task_id); expect(occurrenceTask.run_id).not.toBe(dispatch.run_id);
  const body = `data: {"type":"response.output_text.delta","delta":"composed fixture result"}\n\ndata: {"type":"response.completed","response":{"status":"completed","model":"${proposal.selection.model}"}}\n\n`;
  peers.reply(OWNER, { ...session, id: request.id, ok: true, status: 200, headers: { "content-type": "text/event-stream" }, body });
  await bounded(f.canonical.drain()); await bounded(scheduler.tick());
  expect(resolvedClasses).toEqual(["interactive", "routine"]); expect(workerRuns).toBe(1);
  expect((await peers.observe(OWNER)).authorization).toMatchObject({ background: false, revision: 1 });
  expect(await repo.fires(OWNER, routine.routineId)).toMatchObject([{ fireId: fire.fireId, taskId: fire.taskId, status: "completed" }]);
  expect(await f.db.selectFrom("bot_tasks").selectAll().where("task_id", "=", fire.taskId).executeTakeFirstOrThrow()).toMatchObject({ status: "completed" });
  const occurrenceRun = await f.db.selectFrom("chat_runs").selectAll().where("id", "=", occurrenceTask.run_id!).executeTakeFirstOrThrow();
  expect(occurrenceRun).toMatchObject({ status: "completed", outcome: "completed", client_request_id: "req_routine_" + fire.fireId });
  expect(await f.db.selectFrom("bot_routines").selectAll().execute()).toHaveLength(1);
  expect(await f.db.selectFrom("bot_interactions").selectAll().execute()).toHaveLength(1);
  expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(1);
  expect(await f.db.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(2);
  expect(await f.db.selectFrom("chat_runs").selectAll().where("chat_id", "=", TARGET_A.chatId).execute()).toHaveLength(2);
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toEqual([receipt]);
  expect(await f.db.selectFrom("bot_grants").selectAll().execute()).toHaveLength(0);
  const transcript = await f.chats.getMessages(owner, TARGET_A.chatId, { afterSeq: 0, limit: 20 });
  expect(JSON.stringify(transcript)).toContain("composed fixture result");
});
