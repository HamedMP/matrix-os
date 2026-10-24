import { afterEach, expect, it, vi } from "vitest";
import type { CanonicalChatMessagePart, CanonicalProviderCatalog } from "@matrix-os/contracts";
import { createMatrixBotChatProviderAdapter } from "../../../packages/gateway/src/bots/chat-adapter.js";
import { createManagedPiRuntime } from "../../../packages/gateway/src/chat/managed-pi-runtime.js";
import { MANAGED_PI_CHAT_SUPPORTS } from "../../../packages/gateway/src/chat/managed-chat-catalog.js";
import { resolveManagedPiRoute } from "../../../packages/gateway/src/bots/route-resolver.js";
import { ChatSteerNotDeliveredError } from "../../../packages/gateway/src/chat/steer-delivery-error.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import { createTestPGlite } from "../../helpers/pglite-test-helper.js";

const owner = { type: "personal" as const, ownerId: "owner_attachment_steering" };
const text: CanonicalChatMessagePart = { type: "text", text: "Inspect the queued upload" };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function upload(kind: "image" | "file"): CanonicalChatMessagePart {
  return { type: "attachment_reference", attachmentId: `att_steer_${kind}`, kind,
    label: kind === "image" ? "photo.png" : "marker.txt",
    mimeType: kind === "image" ? "image/png" : "text/plain",
    ownerReference: `temporary/desktop-chat/${kind}`, sizeBytes: 8 };
}

function fixture(mode: "Chat" | "Bot", acknowledged = true) {
  let complete!: () => void;
  const held = new Promise<void>(resolve => { complete = resolve; });
  const selection = { instanceId: mode === "Chat" ? "matrix_pi_default" : "matrix_bot_default", model: "claude-sonnet-5" };
  const delivered = vi.fn(async (_request: unknown) => acknowledged);
  if (mode === "Bot") {
    const adapter = createMatrixBotChatProviderAdapter({
      orchestrator: {
        start: () => ({
          events: (async function* () { await held; })(),
          result: held.then(() => ({ status: "completed" as const, toolActions: 0 })),
        }),
        steer: delivered,
        cancel: async () => { complete(); },
        abandon: async () => undefined,
      }, stopRuntime: async () => undefined,
    });
    return { adapter, selection, delivered, complete };
  }
  const snapshot = makeAiProviderSnapshot();
  const runBot = vi.fn(async (request: { command: { kind: string; runId: string } }) => {
    if (request.command.kind === "bot.run") await held;
    else await delivered(request);
    return { ok: true, reply: request.command.kind === "bot.steer" ? { acknowledged }
      : { runId: request.command.runId, status: "completed", toolActions: 0 } };
  });
  const runtime = createManagedPiRuntime({
    admission: {
      admit: async request => ({ kind: "managed_chat" as const, ownerId: request.ownerId,
        chatId: request.chatId, runId: request.runId, runtimeHandle: `runtime_${"a".repeat(32)}`,
        executionGeneration: "1", workspace: { kind: "chat_workspace" as const }, rootFingerprint: "a".repeat(64),
        ...resolveManagedPiRoute(snapshot, selection), capabilities: ["artifact.read"], requestClass: "interactive" as const }),
      toolAuthority: async () => ({ permissionMode: "supervised" as const }),
      release: async () => undefined, workspace: async () => "/owned/chat",
      startRenewal: () => ({ stop: async () => undefined }),
    },
    host: { client: { runBot } } as unknown as ScopeRuntimeHost,
    providers: { getSnapshot: async () => snapshot }, lifetime: new AbortController().signal,
    forgetRun: () => undefined, cancelInference: () => undefined,
  });
  cleanup.push(async () => { complete(); await runtime.close(); });
  return { adapter: runtime.adapter, selection, delivered, complete };
}

it.each(["Chat", "Bot"] as const)("rejects attachment steering before %s delivery and retains text steering", async mode => {
  const f = fixture(mode);
  const input = { owner, chatId: "chat_attachment_steering", runId: "run_attachment_steering",
    turnId: "cturn_attachment_steering", prompt: text.text, parts: [text], selection: f.selection,
    interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal };
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const drain = (async () => { for await (const event of f.adapter.start(input)) if (event.type === "state.updated") began(); })();
  if (mode === "Chat") await started;
  try {
    for (const kind of ["image", "file"] as const) {
      await expect(f.adapter.steer!({ ...input, clientRequestId: `req_steer_${kind}`, parts: [text, upload(kind)] }))
        .rejects.toBeInstanceOf(ChatSteerNotDeliveredError);
    }
    expect(f.delivered).not.toHaveBeenCalled();
    await f.adapter.steer!({ ...input, clientRequestId: "req_steer_text" });
    expect(f.delivered).toHaveBeenCalledOnce();
  } finally { f.complete(); await drain; }
});

it.each(["Chat", "Bot"] as const)("keeps queued %s uploads unclaimed when text-only steering refuses them", async mode => {
  const f = fixture(mode);
  const pglite = await createTestPGlite();
  const repository = new ChatRepository(pglite.dialect);
  await repository.bootstrap();
  cleanup.push(() => repository.kysely.destroy());
  const driverKind = f.adapter.driverKind;
  const catalog: CanonicalProviderCatalog = {
    revision: "catalog_attachment_steering",
    drivers: [{ kind: driverKind, displayName: mode, adapterVersion: "1", capabilityClass: "coding_agent" }],
    instances: [{ id: f.selection.instanceId, driverKind, displayName: mode, availability: "available",
      workspaceRequirement: "project_optional", catalogRevision: "catalog_attachment_steering",
      models: [{ id: f.selection.model, displayName: "Fixture", availability: "available", capabilities: ["tools", "vision"],
        supportsVision: true, supportsToolUse: true }],
      options: [], skills: [], commands: [], setupActions: [], supports: MANAGED_PI_CHAT_SUPPORTS }],
  };
  const orchestrator = new CanonicalChatOrchestrator({ repository, catalog: { getCatalog: async () => catalog },
    adapters: new CanonicalChatProviderRegistry([f.adapter]) });
  cleanup.push(async () => { f.complete(); await orchestrator.close(); });
  const principal = { userId: owner.ownerId, source: "jwt" as const };
  const chatId = `chat_queued_attachment_${mode.toLowerCase()}`;
  await repository.create(owner, { id: chatId, clientRequestId: `req_create_${mode}`, title: mode });
  const current = (await repository.get(owner, chatId))!;
  const admitted = await orchestrator.admitTurn(principal, owner, chatId, {
    clientRequestId: `req_start_${mode}`, baseRevision: current.chat.revision,
    parts: [text], selection: f.selection, interactionMode: "default", permissionMode: "supervised",
  });
  await vi.waitFor(async () => expect((await repository.get(owner, chatId))?.activeRun?.status).toBe("running"));
  const parts = [text, upload("image"), upload("file")];
  const before = (await repository.get(owner, chatId))!;
  const queued = await orchestrator.enqueueQueuedTurn(principal, owner, chatId, {
    clientRequestId: `req_queue_${mode}`, baseRevision: before.chat.revision, parts,
    selection: f.selection, interactionMode: "default", permissionMode: "supervised",
  });
  const revision = (await repository.get(owner, chatId))!.chat.revision;
  await expect(orchestrator.steerQueuedTurn(owner, chatId, admitted.run.id, queued.queuedTurn.id, {
    clientRequestId: `req_steer_queue_${mode}`, baseRevision: revision, expectedTurnId: admitted.turn.id,
  })).rejects.toMatchObject({ status: 503 });
  expect(f.delivered).not.toHaveBeenCalled();
  expect(await repository.listQueuedTurns(owner, chatId)).toEqual([expect.objectContaining({
    id: queued.queuedTurn.id, parts,
  })]);
  expect(await repository.kysely.selectFrom("chat_queued_turns").select("status")
    .where("id", "=", queued.queuedTurn.id).executeTakeFirstOrThrow()).toEqual({ status: "queued" });
  expect((await repository.getDetailPage(owner, chatId, { limit: 50 }))?.messages.filter(message =>
    message.parts.some(part => part.type === "attachment_reference"))).toHaveLength(0);
});

it.each(["Chat", "Bot"] as const)("rejects a transport-successful but worker-refused %s steer", async mode => {
  const f = fixture(mode, false);
  const input = { owner, chatId: "chat_refused", runId: "run_refused", turnId: "cturn_refused",
    prompt: text.text, parts: [text], selection: f.selection, clientRequestId: "req_refused",
    interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal };
  const ready = Promise.withResolvers<void>();
  const running = (async () => { for await (const event of f.adapter.start(input)) if (event.type === "state.updated") ready.resolve(); })();
  try {
    if (mode === "Chat") await ready.promise;
    await expect(f.adapter.steer!(input)).rejects.toThrow();
    expect(f.delivered).toHaveBeenCalledOnce();
  } finally { f.complete(); await running; }
});
