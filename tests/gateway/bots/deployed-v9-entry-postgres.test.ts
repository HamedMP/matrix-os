/** Real PG boundaries with synthetic in-process transports only. No model or scope process. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createCustomBotChats } from "../../../packages/gateway/src/bots/custom-direct-chat.js";
import { BotAdmissionError, createPrivateBotAdmission } from "../../../packages/gateway/src/bots/admission.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { ChatAgentContext } from "../../../packages/gateway/src/chat/agent-context.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { MANAGED_PI_CHAT_SUPPORTS, managedPiChatInstances } from "../../../packages/gateway/src/chat/managed-chat-catalog.js";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import { retainedThreadEntryFailure } from "./deployed-v9-entry-support.js";
import { BOT, OWNER, V9_DIRECT, V9_THREAD, V9_ORDINARY, V9_PROJECT, createDeployedV9Fixture, v9PgEnabled, type DeployedV9Fixture } from "./deployed-v9-postgres-support.js";

describe.skipIf(!v9PgEnabled)("retained v9 thread entry boundaries", () => {
  let fixture: DeployedV9Fixture | undefined;
  let home: string | undefined;
  let orchestrator: CanonicalChatOrchestrator | undefined;
  beforeEach(async () => {
    fixture = await createDeployedV9Fixture();
    const retained = await fixture.chats.getDetailPage({ type: "personal", ownerId: OWNER }, V9_THREAD, { limit: 40 });
    expect(retained?.record.chat.messageCount).toBe(1);
    expect(retained?.messages).toEqual([expect.objectContaining({ id: "msg_v9_historical", seq: 1 })]);
    home = await mkdtemp(join(tmpdir(), "matrix-v9-entry-"));
  });
  afterEach(async () => {
    try {
      if (orchestrator) {
        await orchestrator.drain();
        await orchestrator.close();
      }
    } finally {
      orchestrator = undefined;
      try { if (home) await rm(home, { recursive: true, force: true }); }
      finally { home = undefined; await fixture?.destroy(); fixture = undefined; }
    }
  });
  const owner = { type: "personal" as const, ownerId: OWNER };
  const agents = { get: async () => null };
  const selection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };

  function createCanonicalBoundary() {
    let providerStarts = 0;
    const adapter: CanonicalChatProviderAdapter = {
      driverKind: "matrix_pi", stateSchemaVersion: 1,
      parseState: value => value, serializeState: value => value,
      async *start() {
        providerStarts += 1; // Synthetic transport only; never invokes inference.
        yield { type: "run.completed", outcome: "completed" };
      },
    };
    const catalog = { getCatalog: async () => ({ revision: "v9_fixture",
      drivers: [{ kind: "matrix_pi" as const, displayName: "Pi", adapterVersion: "1", capabilityClass: "system_agent" as const }],
      instances: managedPiChatInstances(makeAiProviderSnapshot()).map(instance => ({ ...instance, catalogRevision: "v9_fixture" })),
    }) };
    const botChats = createCustomBotChats({ chats: fixture!.chats, agents });
    orchestrator = new CanonicalChatOrchestrator({ repository: fixture!.chats, catalog,
      adapters: new CanonicalChatProviderRegistry([adapter]),
      agentContext: new ChatAgentContext({ repository: fixture!.chats, agents, botChats, enabled: () => true }),
    });
    return { botChats, starts: () => providerStarts };
  }

  it("returns the retained thread kind and project metadata without treating it as a direct binding", async () => {
    const repository = createBotBindingsRepository(fixture!.db);
    expect(await repository.forChat({ ownerId: OWNER, chatId: V9_THREAD }))
      .toEqual([expect.objectContaining({ ownerId: OWNER, botId: BOT, chatId: V9_THREAD, kind: "thread", projectId: V9_PROJECT })]);
    expect(await repository.directChatId({ ownerId: OWNER, botId: BOT })).toBe(V9_DIRECT);
  });

  it.each(["supervised", "full_access"] as const)("refuses a retained project thread before canonical admission or provider execution with %s", async permissionMode => {
    expect(MANAGED_PI_CHAT_SUPPORTS.permissionModes).toContain(permissionMode);
    const before = await fixture!.snapshot();
    const boundary = createCanonicalBoundary();
    const record = (await fixture!.chats.get(owner, V9_THREAD))!;
    const outcome = await orchestrator!.admitTurn({ userId: OWNER, source: "jwt" }, owner, V9_THREAD, {
      clientRequestId: `req_thread_${permissionMode}`, baseRevision: record.chat.revision, selection,
      interactionMode: "default", permissionMode, parts: [{ type: "text", text: "Synthetic retained thread request" }],
    }).then(() => ({ accepted: true as const }), retainedThreadEntryFailure);
    await orchestrator!.drain();
    const evidence = { outcome, providerStarts: boundary.starts(),
      runs: await fixture!.db.selectFrom("chat_runs").select("id").where("chat_id", "=", V9_THREAD).execute(),
      snapshot: await fixture!.snapshot(),
    };
    expect(evidence).toEqual({ outcome: { accepted: false, errorType: "BotEntryError", code: "unavailable" },
      providerStarts: 0, runs: [], snapshot: before,
    });
  });

  it("keeps ordinary managed Chat admission usable so the thread denial is not a global fallback outage", async () => {
    const boundary = createCanonicalBoundary();
    expect(await boundary.botChats.directBot(owner, V9_ORDINARY)).toBeNull();
    expect(await boundary.botChats.directBot(owner, V9_DIRECT)).toBe(BOT);
    const record = (await fixture!.chats.get(owner, V9_ORDINARY))!;
    const result = await orchestrator!.admitTurn({ userId: OWNER, source: "jwt" }, owner, V9_ORDINARY, {
      clientRequestId: "req_v9_ordinary", baseRevision: record.chat.revision, selection,
      interactionMode: "default", permissionMode: "full_access", parts: [{ type: "text", text: "Synthetic ordinary request" }],
    });
    await orchestrator!.drain();
    expect(result.run.driverKind).toBe("matrix_pi");
    expect(boundary.starts()).toBe(1);
    expect(await fixture!.db.selectFrom("chat_runs").select("status").where("id", "=", result.run.id).executeTakeFirst())
      .toEqual({ status: "completed" });
  });

  it("refuses the retained thread at private Bot admission before workspace resolution or scope allocation", async () => {
    const registry = new BotRuntimeRegistry();
    let workspaceReads = 0, scopeStarts = 0;
    const host = { available: true, client: {
      createRuntime: async () => { scopeStarts += 1; throw new Error("Synthetic scope boundary must not be reached"); },
      stopRuntime: async () => undefined,
    } } as unknown as ScopeRuntimeHost;
    const admission = createPrivateBotAdmission({ db: fixture!.db, registry, host,
      roots: { resolve: async () => { workspaceReads += 1; throw new Error("Thread must not resolve a Bot workspace"); } },
    });
    const before = await fixture!.snapshot();
    try {
      await expect(admission.admit({ ownerId: OWNER, botId: BOT, chatId: V9_THREAD,
        taskId: "task_v9_fixture_01234567", runId: "run_v9_fixture", requestClass: "interactive",
        route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200000, maxOutputTokens: 256 },
        accessSourceId: "matrix_included", capabilities: ["artifact.read"],
      })).rejects.toEqual(new BotAdmissionError("not_found"));
      expect(workspaceReads).toBe(0);
      expect(scopeStarts).toBe(0);
      expect(registry.size).toBe(0);
      expect(await fixture!.snapshot()).toEqual(before);
    } finally { registry.shutdown(); }
  });
});
