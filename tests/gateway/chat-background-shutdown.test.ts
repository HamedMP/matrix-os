import {
  CanonicalProviderCatalogSchema,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatExecutionRootResolver } from "../../packages/gateway/src/chat/execution-root.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import {
  CanonicalChatProviderRegistry,
  type CanonicalChatProviderAdapter,
} from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

const owner = { type: "personal" as const, ownerId: "owner_orchestrator" };
const principal = { userId: owner.ownerId, source: "jwt" as const };

function catalog(): CanonicalProviderCatalog {
  return CanonicalProviderCatalogSchema.parse({
    revision: "catalog_orchestrator",
    drivers: [{
      kind: "codex",
      displayName: "Codex",
      adapterVersion: "1.0.0",
      capabilityClass: "coding_agent",
    }],
    instances: [{
      id: "codex_default",
      driverKind: "codex",
      displayName: "Codex",
      availability: "available",
      workspaceRequirement: "project_optional",
      catalogRevision: "catalog_orchestrator",
      models: [{
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        availability: "available",
        capabilities: ["reasoning", "tools"],
        supportsVision: false,
        supportsToolUse: true,
      }],
      options: [],
      skills: [],
      commands: [],
      setupActions: [],
      supports: {
        rootChat: true,
        resume: true,
        cancellation: true,
        steering: "same_run",
        attachments: ["file", "image", "structured_ref"],
        tools: [],
        approvals: true,
        userInput: true,
        worktrees: "optional",
        resources: ["file", "folder", "project", "task", "app", "terminal_session"],
        interactionModes: ["default"],
        permissionModes: ["supervised"],
      },
    }],
  });
}

function adapter(
  start: CanonicalChatProviderAdapter<{ sessionId: string }>["start"],
): CanonicalChatProviderAdapter<{ sessionId: string }> {
  return {
    driverKind: "codex",
    stateSchemaVersion: 1,
    parseState(value) {
      if (!value || typeof value !== "object" || typeof (value as { sessionId?: unknown }).sessionId !== "string") {
        throw new Error("invalid state");
      }
      return value as { sessionId: string };
    },
    serializeState: (value) => value,
    start,
  };
}

it("graceful shutdown preserves a background run with durable identity", async () => {
  const db = await KyselyPGlite.create();
  const repository = new ChatRepository(db.dialect);
  await repository.bootstrap();
  const cancel = vi.fn();
  const provider = { ...adapter(async function* (input) {
    yield { type: "state.updated" as const, state: { sessionId: "native_shutdown" } };
    await new Promise<void>(resolve => input.signal.aborted ? resolve() : input.signal.addEventListener("abort", () => resolve(), { once: true }));
  }), detachOnShutdown: true, cancel };
  const orchestrator = new CanonicalChatOrchestrator({ repository, catalog: { getCatalog: async () => catalog() }, adapters: new CanonicalChatProviderRegistry([provider]) });
  try {
    await repository.create(owner, { id: "chat_shutdown", clientRequestId: "req_create_shutdown", title: "Shutdown" });
    const accepted = await orchestrator.admitTurn(principal, owner, "chat_shutdown", {
      clientRequestId: "req_shutdown_turn", baseRevision: 0, parts: [{ type: "text", text: "work" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" }, interactionMode: "default", permissionMode: "supervised",
    });
    await vi.waitFor(async () => expect(await repository.getAdapterState(owner, { runId: accepted.run.id, driverKind: "codex", instanceId: "codex_default" })).not.toBeNull());
    await orchestrator.close();
    expect(cancel).not.toHaveBeenCalled();
    expect((await repository.exportChat(owner, "chat_shutdown"))?.runs[0]?.status).toBe("running");
  } finally { await orchestrator.close(); await repository.kysely.destroy(); }
});
