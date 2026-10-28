import { BotBrokerActionError } from "../../../packages/gateway/src/bots/broker-actions.js";
import { createBotWorkspace, resolveBotWorkspaceRoot } from "../../../packages/gateway/src/chat/bot-workspace-root.js";
import { createBotTaskOrchestrator } from "../../../packages/gateway/src/bots/task-orchestrator.js";
import { createMatrixBotChatProviderAdapter } from "../../../packages/gateway/src/bots/chat-adapter.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { withBotProviderInstance } from "../../../packages/gateway/src/bots/provider-instance.js";
import { MATRIX_BOT_SELECTION } from "../../../packages/gateway/src/bots/selection.js";
import { createBotInputHistoryReader } from "../../../packages/gateway/src/bots/historical-input.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { createBotWorker } from "../../../packages/bot-runtime/src/worker.js";
import { BotBrokerError, type BotWorkerBrokerClient } from "../../../packages/bot-runtime/src/broker-client.js";
import { createManagedPiAdmission } from "../../../packages/gateway/src/chat/managed-pi-admission.js";
import { createManagedPiRuntime } from "../../../packages/gateway/src/chat/managed-pi-runtime.js";
import { withChatGptPlanProviderInstance } from "../../../packages/gateway/src/bots/chatgpt-plan-provider-instance.js";
import { createBotToolDispatcher } from "../../../packages/gateway/src/bots/tool-dispatcher.js";
import { createBotBrokerActions } from "../../../packages/gateway/src/bots/broker-actions.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotCheckpointsRepository } from "../../../packages/gateway/src/bots/repositories/checkpoints.js";
import { createBotSessionsRepository } from "../../../packages/gateway/src/bots/repositories/sessions.js";
import { createManagedPiCheckpointsRepository } from "../../../packages/gateway/src/chat/managed-pi-checkpoints.js";
import { createManagedPiSessionsRepository } from "../../../packages/gateway/src/chat/managed-pi-sessions.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import type { Kysely } from "kysely";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";
import type { ChatGptPlanAuthority } from "../../../packages/gateway/src/bots/chatgpt-plan.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import { BOT, OWNER, createBotStateDatabase } from "./bot-state-support.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  try { for (const fn of cleanup.splice(0).reverse()) await fn(); }
  finally { vi.unstubAllEnvs(); }
});
// Valid equal-size 1x1 PNGs with red, blue and green pixels. Later turns must
// observe newly stored bytes, never reuse the previous run's image/session.
const IMAGES = [
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AAAA//8DAgH/HjyuSQAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AAD/AP8EAQH/91/JVQAAAABJRU5ErkJggg==",
].map(value => Buffer.from(value, "base64"));
const PNG = IMAGES[0]!;
it.each([{ mode: "Chat", revoke: false, steering: false }, { mode: "Bot", revoke: false, steering: false }, { mode: "Chat", revoke: true, steering: false }, { mode: "Bot", revoke: true, steering: false }, { mode: "Chat", revoke: false, steering: true }, { mode: "Bot", revoke: false, steering: true }])("hydrates $mode bytes through canonical broker and Pi worker (revoke=$revoke, steering=$steering)", async ({ mode, revoke, steering }) => {
  vi.stubEnv("MATRIX_BOT_MAX_INFERENCE_CALLS", steering ? "3" : "2");
  const { db, destroy } = await createBotStateDatabase(); cleanup.push(destroy);
  const home = await mkdtemp(join(tmpdir(), "managed-inputs-")); cleanup.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "temporary/desktop-chat"), { recursive: true });
  await writeFile(join(home, "temporary/desktop-chat/photo.png"), PNG);
  await writeFile(join(home, "temporary/desktop-chat/marker.txt"), "FILE_CONTENT_CANARY_6291");
  const route = { api: "openai-responses" as const, modelId: "gpt-6.1-sol", input: ["text", "image"] as ("text" | "image")[], contextWindow: 128000, maxOutputTokens: 8192 };
  const subscription = { peerId: randomUUID(), accountId: "account-own", computerId: "computer-own", grantRevision: 2 };
  const selection = { instanceId: "matrix_pi_chatgpt_plan", model: route.modelId, options: [{ id: "accountId", value: subscription.accountId }, { id: "grantRevision", value: "2" }] };
  const authority: ChatGptPlanAuthority = {
    observe: async ownerId => { expect(ownerId).toBe(OWNER); return { id: "matrix_chatgpt_plan", providerId: "openai", executionKind: "direct_pi", availability: "available", accountId: subscription.accountId,
      models: [{ id: route.modelId, displayName: "GPT 6.1 Sol", input: route.input }], authorization: { revision: 2, enabled: true, background: false }, coordinatorFunding: "subscription" }; },
    resolve: async (selected, ownerId) => { expect(ownerId).toBe(OWNER); expect(selected).toEqual({ ...selection, instanceId: "matrix_chatgpt_plan" }); return { route, subscription, accessSourceId: "matrix_chatgpt_plan" }; },
    revalidate: async () => true, infer: async () => { throw new Error("No paid fixture inference"); },
  };
  const faux = fauxProvider({ models: [{ id: route.modelId, input: route.input, contextWindow: route.contextWindow, maxTokens: route.maxOutputTokens }] });
  const observed: unknown[] = [];
  const aliases: string[] = [];
  for (let index = 0; index < 3; index++) faux.appendResponses([
    context => {
      const user = [...context.messages].reverse().find(message => message.role === "user")!;
      const content = user.content as Array<{ type: string; data?: string; text?: string }>;
      expect(content.find(item => item.type === "image")).toMatchObject({ data: IMAGES[index]!.toString("base64"), mimeType: "image/png" });
      observed.push(content);
      if (index > 0) expect(JSON.stringify(context.messages)).not.toContain(index === 1 ? "FILE_CONTENT_CANARY_8402" : "FILE_CONTENT_CANARY_1739");
      const alias = content.find(item => item.type === "text")!.text!.match(/read_artifact path=(submitted-inputs\/[a-f0-9-]+)/)![1]!;
      expect(aliases).not.toContain(alias); aliases.push(alias);
      return fauxAssistantMessage(fauxToolCall("read_artifact", { path: alias }, { id: `read_${index}` }), { stopReason: "toolUse" });
    },
    context => { const marker = ["FILE_CONTENT_CANARY_6291", "FILE_CONTENT_CANARY_8402", "FILE_CONTENT_CANARY_1739"][index]!; expect(JSON.stringify(context.messages.at(-1))).toContain(marker); return fauxAssistantMessage(fauxText(marker)); },
  ]);
  const registry = new BotRuntimeRegistry(); let serial = 0;
  let actions: ReturnType<typeof createBotBrokerActions>;
  const stopRuntime = vi.fn(async () => undefined);
  const workers = new Map<string, ReturnType<typeof createBotWorker>>(); // one active fixture runtime, evicted in finally.
  const host = { available: true, client: {
    createRuntime: async () => ({ runtimeHandle: `runtime_${(++serial).toString(16).padStart(32, "0")}`, executionGeneration: "1" }), stopRuntime,
    renewRuntime: async (input: { runtimeHandle: string; executionGeneration: string }) => ({ ...input, state: "running" as const }),
    runBot: async (request: { runtimeHandle: string; executionGeneration: string; command: { kind: string; runId: string } }) => {
      if (request.command.kind !== "bot.run") return { ok: true, reply: await workers.get(request.runtimeHandle)!.handle(request.command) };
      const call = async (body: Record<string, unknown>) => {
        const reply = await actions.handleFrame({ version: 1, requestId: randomUUID(), runtimeHandle: request.runtimeHandle, executionGeneration: request.executionGeneration, runId: request.command.runId, ...body });
        if (!reply?.ok) throw new BotBrokerError((reply?.code ?? "unavailable") as never); return reply.result;
      };
      const broker: BotWorkerBrokerClient = { loadRun: async () => {
        const spec = await call({ action: "bot.run.load" });
        if (mode === "Bot") expect(spec).toMatchObject({ limits: { maxToolActions: 60, maxInferenceCalls: steering ? 3 : 2 }, turn: steering ? { kind: "prompt" } : { imageCount: 1 } });
        return spec as never;
      },
        readImageChunk: image => call({ action: "bot.input.image", image }) as never,
        loadSession: () => call({ action: "bot.session.load" }) as never, saveSession: session => call({ action: "bot.session.save", session }) as never,
        tool: tool => call({ action: "bot.tool", tool }) as never, event: async event => { await call({ action: "bot.event", event }); } };
      const worker = createBotWorker({ brokerFor: () => broker, bridgeOrigin: "http://127.0.0.1:41000", route: { provider: faux.provider, model: faux.getModel() } });
      if (workers.size) throw new Error("Fixture runtime already occupied");
      workers.set(request.runtimeHandle, worker);
      try { return { ok: true, reply: await worker.handle({ version: 1, kind: "bot.run", runId: request.command.runId }) }; }
      finally { workers.delete(request.runtimeHandle); }
    },
  } } as unknown as ScopeRuntimeHost;
  const admission = createManagedPiAdmission({ db, homePath: home, host, registry, chatgptPlan: authority, roots: { resolve: async () => { throw new Error("No project"); } } });
  const lifetime = new AbortController();
  const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  let grantLive = true;
  const readHistory = createBotInputHistoryReader(repository);
  const inputHistory: typeof readHistory = async request => { const result = await readHistory(request); if (revoke && result.references.length) grantLive = false; return result; };
  const assertSource = async () => { if (!grantLive) throw new BotBrokerActionError("denied"); };
  const runtime = createManagedPiRuntime({ inputHistory, assertSource, homePath: home, expectedOwnerId: OWNER, admission, chatgptPlan: authority, host,
    providers: { getSnapshot: async () => makeAiProviderSnapshot() }, lifetime: lifetime.signal,
    forgetRun: runId => actions.forgetRun(runId), cancelInference: binding => registry.cancelInference(binding) });
  if (mode === "Bot") await createBotWorkspace({ homePath: home, botId: BOT });
  const recipeRuntime = mode === "Bot" ? createBotTaskOrchestrator({ homePath: home, expectedOwnerId: OWNER, inputHistory, assertSource,
    bindings: createBotBindingsRepository(db), transact: createBotStateTransactions(repository),
    agents: { get: async () => ({ id: BOT, name: "Writing Bot", description: "", instructions: "Inspect only attached inputs", archived: false,
      selection: MATRIX_BOT_SELECTION, recipeRef: { recipeId: "writing-bot", version: "2026-09-27.1" }, revision: 1,
      createdAt: "2026-09-27T12:00:00.000Z", updatedAt: "2026-09-27T12:00:00.000Z" }) },
    recipes: createBotRecipeCatalog(), resolveRoute: async () => ({ route, subscription, accessSourceId: "matrix_chatgpt_plan" }),
    registry, client: host.client,
    admission: { admit: async request => {
      const current = await host.client.createRuntime({} as never);
      const root = await resolveBotWorkspaceRoot({ homePath: home, owner: { type: "personal", ownerId: OWNER }, ref: { kind: "bot_workspace", botId: BOT } });
      registry.bind({ ...request, ...current, rootFingerprint: root.fingerprint }); return { ...current, rootFingerprint: root.fingerprint };
    }, release: async handle => { registry.release(handle); await stopRuntime(handle); },
    startRenewal: () => ({ stop: async () => undefined }) },
    onRunFinished: runId => actions.forgetRun(runId),
  }) : undefined;
  const adapter = recipeRuntime ? createMatrixBotChatProviderAdapter({ orchestrator: recipeRuntime, stopRuntime }) : runtime.adapter;
  actions = createBotBrokerActions({ db, registry, sessions: createBotSessionsRepository(db), checkpoints: createBotCheckpointsRepository(db),
    managedSessions: createManagedPiSessionsRepository(db), managedCheckpoints: createManagedPiCheckpointsRepository(db), runs: recipeRuntime?.runSource ?? runtime.runs, events: recipeRuntime?.eventSink ?? runtime.events,
    tools: createBotToolDispatcher({ homePath: home, managedWorkspace: admission.workspace, submittedArtifact: recipeRuntime?.readSubmittedArtifact ?? runtime.readSubmittedArtifact }), inference: { homePath: home, lifetime: lifetime.signal } });
  const subscriptionCatalog = withChatGptPlanProviderInstance({ getCatalog: async () => ({ revision: "base", drivers: [], instances: [] }) }, authority, () => true);
  const catalog = recipeRuntime ? withBotProviderInstance(subscriptionCatalog) : subscriptionCatalog;
  const adapters = new CanonicalChatProviderRegistry([adapter]);
  let orchestrator = new CanonicalChatOrchestrator({ repository, catalog, adapters });
  cleanup.push(async () => { await orchestrator.close(); await runtime.close(); });
  const owner = { type: "personal" as const, ownerId: OWNER }; const principal = { userId: OWNER, source: "jwt" as const };
  const chat = await repository.create(owner, { id: "chat_inputs", clientRequestId: "req_inputs", title: "Inputs" });
  if (recipeRuntime) await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: chat.chat.id, now: new Date().toISOString() });
  const parts = [{ type: "text" as const, text: "Inspect and read" },
    { type: "attachment_reference" as const, attachmentId: "att_photo", label: "photo.png", kind: "image" as const, mimeType: "image/png", sizeBytes: PNG.length, ownerReference: "temporary/desktop-chat/photo.png" },
    { type: "attachment_reference" as const, attachmentId: "att_marker", label: "marker.txt", kind: "file" as const, mimeType: "text/plain", ownerReference: "temporary/desktop-chat/marker.txt" }];
  if (steering) {
    const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    faux.setResponses([
      async () => { started.resolve(); await release.promise; return fauxAssistantMessage(fauxText("Initial work finished.")); },
      context => {
        const user = [...context.messages].reverse().find(message => message.role === "user")!;
        const content = user.content as Array<{ type: string; data?: string; text?: string }>;
        expect(content.find(item => item.type === "image")).toMatchObject({ data: PNG.toString("base64"), mimeType: "image/png" });
        const alias = content.find(item => item.type === "text")!.text!.match(/read_artifact path=(submitted-inputs\/[a-f0-9-]+)/)![1]!;
        return fauxAssistantMessage(fauxToolCall("read_artifact", { path: alias }, { id: "read_steered" }), { stopReason: "toolUse" });
      },
      context => { expect(JSON.stringify(context.messages.at(-1))).toContain("FILE_CONTENT_CANARY_6291"); return fauxAssistantMessage(fauxText("STEER_ATTACHMENT_RECEIVED")); },
    ]);
    const common = { selection: recipeRuntime ? MATRIX_BOT_SELECTION : selection, interactionMode: "default", permissionMode: recipeRuntime ? "default" : "full_access" };
    const run = await orchestrator.admitTurn(principal, owner, chat.chat.id, { ...common, clientRequestId: "req_steer_start", baseRevision: chat.chat.revision, parts: [{ type: "text", text: "Start working" }] });
    await started.promise;
    try {
      const current = (await repository.get(owner, chat.chat.id))!;
      const queued = await orchestrator.enqueueQueuedTurn(principal, owner, chat.chat.id, { ...common, clientRequestId: "req_attachment_queue", baseRevision: current.chat.revision, parts });
      const revision = (await repository.get(owner, chat.chat.id))!.chat.revision;
      const accepted = await orchestrator.steerQueuedTurn(owner, chat.chat.id, run.run.id, queued.queuedTurn.id, { clientRequestId: "req_attachment_steer", baseRevision: revision, expectedTurnId: run.turn.id });
      expect(accepted.steering).toBe("accepted");
      expect(await repository.listQueuedTurns(owner, chat.chat.id)).toEqual([]);
    } finally { release.resolve(); }
    await vi.waitFor(async () => expect((await repository.get(owner, chat.chat.id))?.activeRun).toBeUndefined(), { timeout: 5000 });
    const detail = (await repository.getDetailPage(owner, chat.chat.id, { limit: 200 }))!;
    expect(detail.runs.at(-1)?.status).toBe("completed");
    expect(JSON.stringify(detail)).toContain("STEER_ATTACHMENT_RECEIVED");
    expect(faux.state.callCount).toBe(3);
    return;
  }
  for (let index = 0; index < (revoke ? 2 : 3); index++) {
    if (index > 0) {
      await writeFile(join(home, "temporary/desktop-chat/marker.txt"), index === 1 ? "FILE_CONTENT_CANARY_8402" : "FILE_CONTENT_CANARY_1739");
      await writeFile(join(home, "temporary/desktop-chat/photo.png"), IMAGES[index]!);
    }
    if (index === 2) { await orchestrator.close(); orchestrator = new CanonicalChatOrchestrator({ repository, catalog, adapters }); }
    const current = await repository.get(owner, chat.chat.id);
    await orchestrator.admitTurn(principal, owner, chat.chat.id, { clientRequestId: `req_input_${index}`, baseRevision: current!.chat.revision, parts: index === 0 ? parts : [{ type: "text", text: "Read the original inputs independently again" }], selection: recipeRuntime ? MATRIX_BOT_SELECTION : selection, interactionMode: "default", permissionMode: recipeRuntime ? "default" : "full_access" });
    await vi.waitFor(async () => expect((await repository.get(owner, chat.chat.id))?.activeRun).toBeUndefined(), { timeout: 5000 });
  }
  expect(observed).toHaveLength(revoke ? 1 : 3); expect(faux.state.callCount).toBe(revoke ? 2 : 6); expect(registry.size).toBe(0); expect(stopRuntime).toHaveBeenCalledTimes(revoke ? 2 : 3);
  const detail = await repository.getDetailPage(owner, chat.chat.id, { limit: 200 });
  expect(detail!.runs.at(-1)?.status).toBe(revoke ? "failed" : "completed");
  expect(JSON.stringify(detail)).toContain("att_photo"); expect(JSON.stringify(detail)).toContain("FILE_CONTENT_CANARY_6291");
  const session = recipeRuntime ? await createBotSessionsRepository(db).load({ ownerId: OWNER, botId: BOT, chatId: chat.chat.id }) : await createManagedPiSessionsRepository(db).load({ ownerId: OWNER, chatId: chat.chat.id });
  for (const image of IMAGES) expect(JSON.stringify(session)).not.toContain(image.toString("base64"));
});
