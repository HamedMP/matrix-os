import type {ChatProviderCatalogService} from "../../../packages/gateway/src/chat/provider-catalog.js";
import { createBotContinuationAdmitter } from "../../../packages/gateway/src/bots/continuations.js";
import { withChatGptPlanProviderInstance } from "../../../packages/gateway/src/bots/chatgpt-plan-provider-instance.js";
import type { CanonicalChatModelSelection } from "@matrix-os/contracts";
import { managedPiChatInstances } from "../../../packages/gateway/src/chat/managed-chat-catalog.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withBotProviderInstance } from "../../../packages/gateway/src/bots/provider-instance.js";
import { ChatAgentContext } from "../../../packages/gateway/src/chat/agent-context.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";

const owner = { type: "personal" as const, ownerId: "owner_bot_turns" };
const principal = { userId: owner.ownerId, source: "jwt" as const };
const BOT_CHAT = "chat_bot_direct";

let repository: ChatRepository;
let orchestrator: CanonicalChatOrchestrator;
let finishBlockedRun: (() => void) | undefined;
let blockedRun: Promise<void> | undefined;
let getCatalog: ReturnType<typeof vi.fn<ChatProviderCatalogService["getCatalog"]>>;
let savedSelection: CanonicalChatModelSelection = { instanceId: "matrix_bot_default", model: "auto" };
let started: Array<{ selection: unknown; permissionMode: string }>;

beforeEach(async () => {
  repository = new ChatRepository((await KyselyPGlite.create()).dialect);
  await repository.bootstrap();
  started = [];
  savedSelection = { instanceId: "matrix_bot_default", model: "auto" };
  finishBlockedRun = undefined;
  blockedRun = undefined;
  getCatalog = vi.fn(async () => ({ revision: "rev_bots", drivers: [], instances: [] }));
  const bot: CanonicalChatProviderAdapter<{ taskId: string }> = {
    driverKind: "matrix_bot",
    stateSchemaVersion: 1,
    parseState: (value) => value as { taskId: string },
    serializeState: (value) => value,
    async *start(input) {
      started.push({ selection: input.selection, permissionMode: input.permissionMode });
      if (blockedRun) await blockedRun;
      yield { type: "assistant.delta", delta: "Hello" };
      yield { type: "run.completed", outcome: "completed" };
    },
  };
  orchestrator = new CanonicalChatOrchestrator({
    repository,
    catalog: withBotProviderInstance({ getCatalog }),
    adapters: new CanonicalChatProviderRegistry([bot]),
    agentContext: new ChatAgentContext({
      repository, agents: { get: vi.fn(async () => ({ id: "bot_0123456789abcdef01234567", archived: false, recipeRef: {recipeId:"writing-bot",version:"1"}, selection: savedSelection }) as never) }, enabled: () => true,
      botChats: { directBot: async (_owner, chatId) => (chatId === BOT_CHAT ? "bot_0123456789abcdef01234567" : null) },
    }),
  });
  for (const id of [BOT_CHAT, "chat_ordinary"]) await repository.create(owner, { id, clientRequestId: `req_${id}`, title: id });
});
afterEach(async () => {
  finishBlockedRun?.();
  await orchestrator.drain();
  await orchestrator.close();
  await repository.kysely.destroy();
});

describe("turns in a bot's chat", () => {
  it("run on the bot runtime with the bot's permission mode, whatever the client sent", async () => {
    const admitted = await orchestrator.admitTurn(principal, owner, BOT_CHAT, {
      clientRequestId: "req_turn_1", baseRevision: 0, parts: [{ type: "text", text: "Tighten my intro" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" }, interactionMode: "plan", permissionMode: "read_only",
    });
    expect(admitted.run).toMatchObject({ driverKind: "matrix_bot", instanceId: "matrix_bot_default", permissionMode: "default", interactionMode: "default" });
    await vi.waitFor(async () => expect((await repository.get(owner, BOT_CHAT))?.activeRun).toBeUndefined());
    expect(started).toEqual([{ selection: { instanceId: "matrix_bot_default", model: "auto" }, permissionMode: "default" }]);
  });

  it("admit direct bot turns while the ordinary harness catalog is unavailable", async () => {
    getCatalog.mockRejectedValue(new Error("Harness settings unavailable"));
    const admitted = await orchestrator.admitTurn(principal, owner, BOT_CHAT, {
      clientRequestId: "req_harness_down", baseRevision: 0, parts: [{ type: "text", text: "hi" }],
      selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default",
    });
    expect(admitted.run.driverKind).toBe("matrix_bot");
    expect(getCatalog).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(started).toHaveLength(1));
  });

  it("retry a stored bot selection without reading the ordinary harness catalog", async () => {
    getCatalog.mockRejectedValue(new Error("Harness settings unavailable"));
    const first = await orchestrator.admitTurn(principal, owner, BOT_CHAT, {
      clientRequestId: "req_bot_retry_first", baseRevision: 0, parts: [{ type: "text", text: "first" }],
      selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default",
    });
    await vi.waitFor(async () => expect((await repository.get(owner, BOT_CHAT))?.activeRun).toBeUndefined());
    const current = await repository.get(owner, BOT_CHAT);
    const retry = await orchestrator.retryTurn(principal, owner, BOT_CHAT, first.turn.id, {
      clientRequestId: "req_bot_retry", baseRevision: current!.chat.revision,
    });
    expect(retry.run.driverKind).toBe("matrix_bot");
    expect(getCatalog).not.toHaveBeenCalled();
  });

  it("queue a server-selected bot turn while ordinary harness settings are unavailable", async () => {
    blockedRun = new Promise<void>((resolve) => { finishBlockedRun = resolve; });
    getCatalog.mockRejectedValue(new Error("Harness settings unavailable"));
    await orchestrator.admitTurn(principal, owner, BOT_CHAT, {
      clientRequestId: "req_active_bot", baseRevision: 0, parts: [{ type: "text", text: "first" }],
      selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default",
    });
    await vi.waitFor(() => expect(started).toHaveLength(1));
    const current = await repository.get(owner, BOT_CHAT);
    const queued = await orchestrator.enqueueQueuedTurn(principal, owner, BOT_CHAT, {
      clientRequestId: "req_queued_bot", baseRevision: current!.chat.revision, parts: [{ type: "text", text: "next" }],
      selection: { instanceId: "codex_default", model: "auto" }, interactionMode: "plan", permissionMode: "read_only",
    });
    expect(queued.queuedTurn.selection).toEqual({ instanceId: "matrix_bot_default", model: "auto" });
    expect(getCatalog).not.toHaveBeenCalled();
  });

  it("preserve ordinary catalog failures and reject forged bot routing", async () => {
    getCatalog.mockRejectedValue(new Error("Harness settings unavailable"));
    await expect(orchestrator.admitTurn(principal, owner, "chat_ordinary", {
      clientRequestId: "req_ordinary_down", baseRevision: 0, parts: [{ type: "text", text: "hi" }],
      selection: { instanceId: "codex_default", model: "auto" }, interactionMode: "default", permissionMode: "default",
    })).rejects.toThrow("Harness settings unavailable");
    getCatalog.mockClear();
    await expect(orchestrator.admitTurn(principal, owner, "chat_ordinary", {
      clientRequestId: "req_forged_down", baseRevision: 0, parts: [{ type: "text", text: "hi" }],
      selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default",
    })).rejects.toMatchObject({ status: 400 });
    expect(getCatalog).not.toHaveBeenCalled();
    expect(started).toEqual([]);
  });

  it("are the only turns that can reach the bot runtime", async () => {
    await expect(orchestrator.admitTurn(principal, owner, "chat_ordinary", {
      clientRequestId: "req_turn_2", baseRevision: 0, parts: [{ type: "text", text: "hi" }],
      selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default",
    })).rejects.toMatchObject({ status: 400 });
    expect(started).toEqual([]);
  });
});

it("keeps a saved managed bot choice and its exact per-turn model in canonical admission", async () => {
  savedSelection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
  getCatalog.mockImplementation(async () => ({ revision: "managed", drivers: [{ kind: "matrix_pi", displayName: "Pi", adapterVersion: "1", capabilityClass: "system_agent" }],
    instances: managedPiChatInstances(makeAiProviderSnapshot()).map((instance) => ({ ...instance, catalogRevision: "managed" })) }));
  const result = await orchestrator.admitTurn(principal, owner, BOT_CHAT, { clientRequestId: "req_concrete", baseRevision: 0,
    parts: [{ type: "text", text: "Hi" }], selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default" });
  expect(result.run.selection).toEqual({ instanceId: "matrix_bot_default", model: "claude-sonnet-5" });
  await vi.waitFor(() => expect(started).toHaveLength(1));
  expect(started[0]).toEqual({ selection: { instanceId: "matrix_bot_default", model: "claude-sonnet-5" }, permissionMode: "default" });
});
it("refuses an unavailable explicit bot model without falling back to Automatic", async () => {
  await expect(orchestrator.admitTurn(principal, owner, BOT_CHAT, { clientRequestId: "req_concrete_bad", baseRevision: 0,
    parts: [{ type: "text", text: "Hi" }], selection: { instanceId: "matrix_pi_default", model: "forged-model" }, interactionMode: "default", permissionMode: "default" })).rejects.toMatchObject({ status: 400 });
  expect(started).toEqual([]);
});

const planSelection = { instanceId: "matrix_chatgpt_plan", model: "gpt-account-model",
  options: [{ id: "accountId", value: "account-own" }, { id: "grantRevision", value: "3" }] };
function installPlanCatalog() {
  const wrapped = withChatGptPlanProviderInstance({ getCatalog: async () => ({ revision: "base_plan", drivers: [], instances: [] }) }, {
    observe: async () => ({ id: "matrix_chatgpt_plan", providerId: "openai", executionKind: "direct_pi", availability: "available",
      accountId: "account-own", models: [{ id: "gpt-account-model", displayName: "Account model" }],
      authorization: { revision: 3, enabled: true, background: false }, coordinatorFunding: "subscription" }),
  });
  getCatalog.mockImplementation((actor, selection) => wrapped.getCatalog(actor, selection));
}
it("admits a saved subscription Bot through real catalog projection and preserves exact account/grant", async () => {
  savedSelection = planSelection;
  installPlanCatalog();
  const admitted = await orchestrator.admitTurn(principal, owner, BOT_CHAT, { clientRequestId: "req_plan_actual_descriptor", baseRevision: 0,
    parts: [{ type: "text", text: "Hello" }], selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default" });
  expect(admitted.run.selection).toEqual({ ...planSelection, instanceId: "matrix_bot_default" });
  await vi.waitFor(() => expect(started).toHaveLength(1));
  expect(started[0]?.selection).toEqual({ ...planSelection, instanceId: "matrix_bot_default" });
});
it("refuses stale account/grant subscription intent without substituting the managed Bot route", async () => {
  savedSelection = planSelection;
  installPlanCatalog();
  await expect(orchestrator.admitTurn(principal, owner, BOT_CHAT, { clientRequestId: "req_plan_stale_grant", baseRevision: 0,
    parts: [{ type: "text", text: "Hello" }], selection: { ...planSelection, options: [{ id: "accountId", value: "account-own" }, { id: "grantRevision", value: "2" }] },
    interactionMode: "default", permissionMode: "default" })).rejects.toMatchObject({ status: 400 });
  expect(started).toEqual([]);
});
it("refuses private subscription source in ordinary Chat before catalog or adapter dispatch", async () => {
  installPlanCatalog();
  await expect(orchestrator.admitTurn(principal, owner, "chat_ordinary", { clientRequestId: "req_plan_nonbot", baseRevision: 0,
    parts: [{ type: "text", text: "Hello" }], selection: planSelection, interactionMode: "default", permissionMode: "default" })).rejects.toMatchObject({ status: 400 });
  expect(getCatalog).not.toHaveBeenCalled();
  expect(started).toEqual([]);
});

it('admits image/file parts for a vision model and rejects images for text-only managed Bot models', async () => {
  const snapshot = makeAiProviderSnapshot();
  snapshot.models[0]!.capabilities = ['tools', 'vision'];
  const model = snapshot.models[0]!.id;
  savedSelection = { instanceId: 'matrix_pi_default', model };
  getCatalog.mockImplementation(async () => ({ revision: 'managed', drivers: [], instances: managedPiChatInstances(snapshot).map(instance => ({ ...instance, catalogRevision: 'managed' })) }));
  const parts = [{ type: 'attachment_reference' as const, attachmentId: 'att_input', kind: 'image' as const, label: 'photo.png', mimeType: 'image/png', ownerReference: 'temporary/desktop-chat/photo.png' }];
  await orchestrator.admitTurn(principal, owner, BOT_CHAT, { clientRequestId: 'req_vision_bot', baseRevision: 0, parts,
    selection: savedSelection, interactionMode: 'default', permissionMode: 'default' });
  await vi.waitFor(async () => expect((await repository.get(owner, BOT_CHAT))?.activeRun).toBeUndefined());
  snapshot.models[0]!.capabilities = ['tools'];
  const current = await repository.get(owner, BOT_CHAT);
  await expect(orchestrator.admitTurn(principal, owner, BOT_CHAT, { clientRequestId: 'req_text_bot', baseRevision: current!.chat.revision, parts,
    selection: savedSelection, interactionMode: 'default', permissionMode: 'default' })).rejects.toMatchObject({ status: 400 });
});
it.each([
  { kind: "image" as const, mimeType: "image/gif", sizeBytes: 10, reason: "PNG, JPEG or WebP" },
  { kind: "image" as const, mimeType: "image/png", sizeBytes: 2 * 1024 * 1024 + 1, reason: "2 MiB" },
])("rejects managed $reason metadata before storing or starting a turn", async part => {
  const snapshot = makeAiProviderSnapshot(); snapshot.models[0]!.capabilities = ["tools", "vision"];
  savedSelection = { instanceId: "matrix_pi_default", model: snapshot.models[0]!.id };
  getCatalog.mockImplementation(async () => ({ revision: "inputs", drivers: [], instances: managedPiChatInstances(snapshot).map(instance => ({ ...instance, catalogRevision: "inputs" })) }));
  const request = { clientRequestId: "req_input_limit", baseRevision: 0, parts: [{ type: "attachment_reference" as const, attachmentId: "att_bounded", label: "upload", kind: part.kind, mimeType: part.mimeType, sizeBytes: part.sizeBytes, ownerReference: "temporary/desktop-chat/input" }],
    selection: savedSelection, interactionMode: "default", permissionMode: "default" };
  await expect(orchestrator.admitTurn(principal, owner, BOT_CHAT, request)).rejects.toMatchObject({ status: 400, safeError: { safeMessage: expect.stringContaining(part.reason) } });
  expect(started).toEqual([]); expect((await repository.get(owner, BOT_CHAT))?.chat.messageCount).toBe(0);
});
it("rejects 20 MiB plus one byte of managed file metadata before storing or starting a turn", async () => {
  const snapshot = makeAiProviderSnapshot();
  savedSelection = { instanceId: "matrix_pi_default", model: snapshot.models[0]!.id };
  getCatalog.mockImplementation(async () => ({ revision: "file_total", drivers: [], instances: managedPiChatInstances(snapshot).map(instance => ({ ...instance, catalogRevision: "file_total" })) }));
  const parts = [10 * 1024 * 1024, 10 * 1024 * 1024, 1].map((sizeBytes, index) => ({ type: "attachment_reference" as const,
    attachmentId: `att_total_${index}`, label: `upload-${index}`, kind: "file" as const, mimeType: "application/octet-stream", sizeBytes, ownerReference: `temporary/desktop-chat/input-${index}` }));
  await expect(orchestrator.admitTurn(principal, owner, BOT_CHAT, { clientRequestId: "req_file_total", baseRevision: 0, parts,
    selection: savedSelection, interactionMode: "default", permissionMode: "default" })).rejects.toMatchObject({ status: 400, safeError: { safeMessage: expect.stringContaining("20 MiB") } });
  expect(started).toEqual([]); expect((await repository.get(owner, BOT_CHAT))?.chat.messageCount).toBe(0);
});
it("rechecks model image suitability on retry and queue without storing rejected metadata", async () => {
  const snapshot = makeAiProviderSnapshot(); snapshot.models[0]!.capabilities = ["tools", "vision"];
  savedSelection = { instanceId: "matrix_pi_default", model: snapshot.models[0]!.id };
  getCatalog.mockImplementation(async () => ({ revision: "image_retry", drivers: [], instances: managedPiChatInstances(snapshot).map(instance => ({ ...instance, catalogRevision: "image_retry" })) }));
  const parts = [{ type: "attachment_reference" as const, attachmentId: "att_retry_image", kind: "image" as const, label: "photo.png", mimeType: "image/png", sizeBytes: 100, ownerReference: "temporary/desktop-chat/photo.png" }];
  const first = await orchestrator.admitTurn(principal, owner, BOT_CHAT, { clientRequestId: "req_image_retry_first", baseRevision: 0, parts, selection: savedSelection, interactionMode: "default", permissionMode: "default" });
  await vi.waitFor(async () => expect((await repository.get(owner, BOT_CHAT))?.activeRun).toBeUndefined());
  snapshot.models[0]!.capabilities = ["tools"];
  let current = await repository.get(owner, BOT_CHAT);
  await expect(orchestrator.retryTurn(principal, owner, BOT_CHAT, first.turn.id, { clientRequestId: "req_image_retry_second", baseRevision: current!.chat.revision })).rejects.toMatchObject({ status: 400 });
  blockedRun = new Promise<void>(resolve => { finishBlockedRun = resolve; });
  await orchestrator.admitTurn(principal, owner, BOT_CHAT, { clientRequestId: "req_queue_active", baseRevision: current!.chat.revision, parts: [{ type: "text", text: "Active" }], selection: savedSelection, interactionMode: "default", permissionMode: "default" });
  await vi.waitFor(() => expect(started).toHaveLength(2)); current = await repository.get(owner, BOT_CHAT);
  await expect(orchestrator.enqueueQueuedTurn(principal, owner, BOT_CHAT, { clientRequestId: "req_queue_bad_image", baseRevision: current!.chat.revision, parts, selection: savedSelection, interactionMode: "default", permissionMode: "default" })).rejects.toMatchObject({ status: 400 });
});
it("rejects funded image metadata above the conservative Relay aggregate before dispatch", async () => {
  const snapshot = makeAiProviderSnapshot(); snapshot.models[0]!.capabilities = ["tools", "vision"];
  savedSelection = { instanceId: "matrix_pi_default", model: snapshot.models[0]!.id };
  getCatalog.mockImplementation(async () => ({ revision: "funded_image", drivers: [], instances: managedPiChatInstances(snapshot).map(instance => ({ ...instance, catalogRevision: "funded_image" })) }));
  await expect(orchestrator.admitTurn(principal, owner, BOT_CHAT, { clientRequestId: "req_funded_image", baseRevision: 0,
    parts: [{ type: "attachment_reference", attachmentId: "att_funded_image", kind: "image", label: "photo.png", mimeType: "image/png", sizeBytes: 1024 * 1024 + 1, ownerReference: "temporary/desktop-chat/photo.png" }],
    selection: savedSelection, interactionMode: "default", permissionMode: "default" })).rejects.toMatchObject({ status: 400, safeError: { safeMessage: expect.stringContaining("1 MiB") } });
  expect(started).toEqual([]); expect((await repository.get(owner, BOT_CHAT))?.chat.messageCount).toBe(0);
});

it("queues a routine through the same canonical Chat and deduplicates its fire request",async()=>{
  const {createBotRoutineCanonicalRunner}=await import("../../../packages/gateway/src/bots/continuations.js");
  blockedRun=new Promise(resolve=>{finishBlockedRun=resolve;});
  await orchestrator.admitTurn(principal,owner,BOT_CHAT,{clientRequestId:"req_foreground_fixture",baseRevision:0,parts:[{type:"text",text:"foreground"}],selection:{instanceId:"matrix_bot_default",model:"auto"},interactionMode:"default",permissionMode:"default"});
  await vi.waitFor(()=>expect(started).toHaveLength(1));
  const run=createBotRoutineCanonicalRunner({repository,orchestrator});
  const routine={ownerId:owner.ownerId,chatId:BOT_CHAT,proposal:{prompt:"approved scheduled fixture"}};
  const fire={fireId:"fire_0123456789abcdef01234567"};
  expect(await run(routine,fire,new AbortController().signal)).toEqual({status:"accepted"});
  expect(await run(routine,fire,new AbortController().signal)).toEqual({status:"accepted"});
  const queued=await repository.kysely.selectFrom("chat_queued_turns").selectAll().where("chat_id","=",BOT_CHAT).execute();
  expect(queued).toHaveLength(1);expect(queued[0].client_request_id).toBe("req_routine_"+fire.fireId);
  await run(routine,{...fire,attempts:2},new AbortController().signal);await run(routine,{...fire,attempts:2},new AbortController().signal);
  const retries=await repository.kysely.selectFrom("chat_queued_turns").select("client_request_id").where("chat_id","=",BOT_CHAT).execute();
  expect(retries.map(row=>row.client_request_id).sort()).toEqual(["req_routine_"+fire.fireId,"req_routine_"+fire.fireId+"_a2"]);

  expect(started).toHaveLength(1);
});

it.each([1,2])("pauses a queued routine attempt %i through canonical queue cancellation without stopping foreground work",async(attempt)=>{
 const {createBotRoutineCanonicalRunner}=await import("../../../packages/gateway/src/bots/continuations.js"),{createBotRoutineExecution}=await import("../../../packages/gateway/src/bots/routine-execution.js"),{bootstrapBotDatabase}=await import("../../../packages/gateway/src/bots/database.js"),{createBotRoutinesRepository}=await import("../../../packages/gateway/src/bots/repositories/routines.js"),{createBotBindingsRepository}=await import("../../../packages/gateway/src/bots/repositories/bindings.js");
 const db=repository.kysely as unknown as import("kysely").Kysely<import("../../../packages/gateway/src/bots/database.js").OwnerBotDatabase>;await bootstrapBotDatabase(db);
 const botId="bot_0123456789abcdef01234567",now=new Date().toISOString(),at=new Date(Date.now()+60000).toISOString();
 await createBotBindingsRepository(db).bindDirect({ownerId:owner.ownerId,botId,chatId:BOT_CHAT,now});
 const repo=createBotRoutinesRepository(db),routine=await repo.create({ownerId:owner.ownerId,botId,chatId:BOT_CHAT,proposal:{name:"Fixture",prompt:"Scheduled fixture",schedule:{kind:"interval",everyMs:60000},selection:{instanceId:"matrix_chatgpt_plan",model:"fixture"},authorizedEffects:["read"]},nextFireAt:at,now});
 let fire=(await repo.claim({ownerId:owner.ownerId,routineId:routine.routineId,scheduledFor:at,nextFireAt:null,now:at}))!;fire=(await repo.dispatch({ownerId:owner.ownerId,fireId:fire.fireId,now:at}))!;
 if(attempt===2){
  const {createBotTasksRepository}=await import("../../../packages/gateway/src/bots/repositories/tasks.js"),tasks=createBotTasksRepository(db),task=(await tasks.get({ownerId:owner.ownerId,taskId:fire.taskId}))!;
  await tasks.transition({ownerId:owner.ownerId,taskId:fire.taskId,baseRevision:task.revision,to:"running",runId:"run_capacity_old",now:at});
  await tasks.transition({ownerId:owner.ownerId,taskId:fire.taskId,baseRevision:task.revision+1,to:"blocked",blockedReason:"capacity_unavailable",now:at});
  await repo.defer({ownerId:owner.ownerId,fireId:fire.fireId,retryAfter:at,now:at});fire=(await repo.dispatch({ownerId:owner.ownerId,fireId:fire.fireId,now:at}))!;
 }

 blockedRun=new Promise(resolve=>{finishBlockedRun=resolve;});
 const foreground=await orchestrator.admitTurn(principal,owner,BOT_CHAT,{clientRequestId:"req_control_foreground",baseRevision:0,parts:[{type:"text",text:"Foreground fixture"}],selection:{instanceId:"matrix_bot_default",model:"auto"},interactionMode:"default",permissionMode:"default"});await vi.waitFor(()=>expect(started).toHaveLength(1));
 await createBotRoutineCanonicalRunner({repository,orchestrator})(routine,fire,new AbortController().signal);
 const execution=createBotRoutineExecution({db,approvals:{} as never});execution.connect({repository,orchestrator});
 const latest=(await repo.get(owner.ownerId,routine.routineId))!;await execution.control(owner.ownerId,botId,routine.routineId,{baseRevision:latest.revision,status:"paused"});
 expect((await repo.getFire(owner.ownerId,fire.fireId))?.status).toBe("cancelled");
 expect((await repository.get(owner,BOT_CHAT))?.activeRun?.runId).toBe(foreground.run.id);
 const queue=await db.selectFrom("chat_queued_turns").select("status").where("client_request_id","=","req_routine_"+fire.fireId+(attempt>1?"_a2":"")).executeTakeFirst();expect(queue?.status).toBe("cancelled");
});

it("automatically delivers a blocking answer once, without a manual steer, after the old turn releases", async () => {
  blockedRun = new Promise<void>(resolve => { finishBlockedRun = resolve; });
  await orchestrator.admitTurn(principal, owner, BOT_CHAT, {
    clientRequestId: "req_asking", baseRevision: 0, parts: [{ type: "text", text: "Ask me which format" }],
    selection: savedSelection, interactionMode: "default", permissionMode: "default",
  });
  await vi.waitFor(() => expect(started).toHaveLength(1));
  const continueAnswer = createBotContinuationAdmitter({ repository, orchestrator });
  const answer = { chatId: BOT_CHAT, clientRequestId: "req_answer_in_0123456789abcdef", text: "Plain text" };
  await continueAnswer(principal, answer);
  await continueAnswer(principal, answer);
  expect(await repository.listQueuedTurns(owner, BOT_CHAT)).toHaveLength(1);
  finishBlockedRun!();
  await vi.waitFor(() => expect(started).toHaveLength(2));
  await orchestrator.drain();
  await continueAnswer(principal, answer);
  expect(started).toHaveLength(2);
  expect(await repository.listQueuedTurns(owner, BOT_CHAT)).toHaveLength(0);
  const detail = await repository.getDetailPage(owner, BOT_CHAT, { limit: 50 });
  expect(detail!.messages.filter(message => message.role === "user" && message.parts.some(part =>
    part.type === "text" && part.text === "Plain text"))).toHaveLength(1);
});
