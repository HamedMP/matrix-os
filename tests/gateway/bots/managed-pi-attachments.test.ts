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
import { OWNER, createBotStateDatabase } from "./bot-state-support.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
it("delivers subscription Chat pixels and submitted-file tool contents through canonical admission, real broker, worker and Pi on fresh/subsequent turns", async () => {
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
  for (let index = 0; index < 2; index++) faux.appendResponses([
    context => {
      const user = [...context.messages].reverse().find(message => message.role === "user")!;
      const content = user.content as Array<{ type: string; data?: string; text?: string }>;
      expect(content.find(item => item.type === "image")).toMatchObject({ data: PNG.toString("base64"), mimeType: "image/png" });
      observed.push(content);
      const alias = content.find(item => item.type === "text")!.text!.match(/read_artifact path=(submitted-inputs\/[a-f0-9-]+)/)![1]!;
      return fauxAssistantMessage(fauxToolCall("read_artifact", { path: alias }, { id: `read_${index}` }), { stopReason: "toolUse" });
    },
    context => { expect(JSON.stringify(context.messages.at(-1))).toContain("FILE_CONTENT_CANARY_6291"); return fauxAssistantMessage(fauxText("FILE_CONTENT_CANARY_6291")); },
  ]);
  const registry = new BotRuntimeRegistry(); let serial = 0;
  let actions: ReturnType<typeof createBotBrokerActions>;
  const stopRuntime = vi.fn(async () => undefined);
  const host = { available: true, client: {
    createRuntime: async () => ({ runtimeHandle: `runtime_${(++serial).toString(16).padStart(32, "0")}`, executionGeneration: "1" }), stopRuntime,
    runBot: async (request: { runtimeHandle: string; executionGeneration: string; command: { kind: string; runId: string } }) => {
      const call = async (body: Record<string, unknown>) => {
        const reply = await actions.handleFrame({ version: 1, requestId: randomUUID(), runtimeHandle: request.runtimeHandle, executionGeneration: request.executionGeneration, runId: request.command.runId, ...body });
        if (!reply?.ok) throw new BotBrokerError((reply?.code ?? "unavailable") as never); return reply.result;
      };
      const broker: BotWorkerBrokerClient = { loadRun: () => call({ action: "bot.run.load" }) as never,
        readImageChunk: image => call({ action: "bot.input.image", image }) as never,
        loadSession: () => call({ action: "bot.session.load" }) as never, saveSession: session => call({ action: "bot.session.save", session }) as never,
        tool: tool => call({ action: "bot.tool", tool }) as never, event: async event => { await call({ action: "bot.event", event }); } };
      const worker = createBotWorker({ brokerFor: () => broker, bridgeOrigin: "http://127.0.0.1:41000", route: { provider: faux.provider, model: faux.getModel() } });
      return { ok: true, reply: await worker.handle({ version: 1, kind: "bot.run", runId: request.command.runId }) };
    },
  } } as unknown as ScopeRuntimeHost;
  const admission = createManagedPiAdmission({ db, homePath: home, host, registry, chatgptPlan: authority, roots: { resolve: async () => { throw new Error("No project"); } } });
  const lifetime = new AbortController();
  const runtime = createManagedPiRuntime({ homePath: home, expectedOwnerId: OWNER, admission, chatgptPlan: authority, host,
    providers: { getSnapshot: async () => makeAiProviderSnapshot() }, lifetime: lifetime.signal,
    forgetRun: runId => actions.forgetRun(runId), cancelInference: binding => registry.cancelInference(binding) });
  actions = createBotBrokerActions({ db, registry, sessions: createBotSessionsRepository(db), checkpoints: createBotCheckpointsRepository(db),
    managedSessions: createManagedPiSessionsRepository(db), managedCheckpoints: createManagedPiCheckpointsRepository(db), runs: runtime.runs, events: runtime.events,
    tools: createBotToolDispatcher({ homePath: home, managedWorkspace: admission.workspace, submittedArtifact: runtime.readSubmittedArtifact }), inference: { homePath: home, lifetime: lifetime.signal } });
  const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const catalog = withChatGptPlanProviderInstance({ getCatalog: async () => ({ revision: "base", drivers: [], instances: [] }) }, authority, () => true);
  const orchestrator = new CanonicalChatOrchestrator({ repository, catalog, adapters: new CanonicalChatProviderRegistry([runtime.adapter]) });
  cleanup.push(async () => { await orchestrator.close(); await runtime.close(); });
  const owner = { type: "personal" as const, ownerId: OWNER }; const principal = { userId: OWNER, source: "jwt" as const };
  const chat = await repository.create(owner, { id: "chat_inputs", clientRequestId: "req_inputs", title: "Inputs" });
  const parts = [{ type: "text" as const, text: "Inspect and read" },
    { type: "attachment_reference" as const, attachmentId: "att_photo", label: "photo.png", kind: "image" as const, mimeType: "image/png", sizeBytes: PNG.length, ownerReference: "temporary/desktop-chat/photo.png" },
    { type: "attachment_reference" as const, attachmentId: "att_marker", label: "marker.txt", kind: "file" as const, mimeType: "text/plain", ownerReference: "temporary/desktop-chat/marker.txt" }];
  for (let index = 0; index < 2; index++) {
    const current = await repository.get(owner, chat.chat.id);
    await orchestrator.admitTurn(principal, owner, chat.chat.id, { clientRequestId: `req_input_${index}`, baseRevision: current!.chat.revision, parts: parts.map(part => part.type === "attachment_reference" ? { ...part, attachmentId: `${part.attachmentId}_${index}` } : part), selection, interactionMode: "default", permissionMode: "full_access" });
    await vi.waitFor(async () => expect((await repository.get(owner, chat.chat.id))?.activeRun).toBeUndefined(), { timeout: 5000 });
  }
  expect(observed).toHaveLength(2); expect(faux.state.callCount).toBe(4); expect(registry.size).toBe(0); expect(stopRuntime).toHaveBeenCalledTimes(2);
  const detail = await repository.getDetailPage(owner, chat.chat.id, { limit: 200 });
  expect(JSON.stringify(detail)).toContain("att_photo"); expect(JSON.stringify(detail)).toContain("FILE_CONTENT_CANARY_6291");
  expect(JSON.stringify(await createManagedPiSessionsRepository(db).load({ ownerId: OWNER, chatId: chat.chat.id }))).not.toContain(PNG.toString("base64"));
});
