import { expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { ChatAgentContext } from "../../packages/gateway/src/chat/agent-context.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../packages/gateway/src/chat/provider-adapter.js";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat.js";

it.each(["immediate", "queued"])("admits resolved memory for %s turns without requiring provider-native memory support", async (mode) => {
  const repository = new ChatRepository((await KyselyPGlite.create()).dialect);
  await repository.bootstrap();
  const owner = { type: "personal" as const, ownerId: "alice" };
  const principal = { userId: "alice", source: "jwt" as const };
  const memory = { sourceId: "00000000-0000-4000-8000-000000000001", revision: 1, title: "Note", text: "Selected original", truncated: false };
  const context = new ChatAgentContext({ repository, agents: { get: vi.fn() }, enabled: () => true,
    memories: { resolve: vi.fn(async () => [memory]), revalidate: vi.fn(async () => {}) } });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const prompts: string[] = [];
  const provider: CanonicalChatProviderAdapter = { driverKind: "codex", stateSchemaVersion: 1, parseState: (state) => state, serializeState: (state) => state,
    start: async function* (input) { prompts.push(input.prompt); await gate; yield { type: "run.completed", outcome: "completed" }; } };
  const catalog = createCanonicalProviderCatalogFixture();
  expect(catalog.instances[0].supports.resources).not.toContain("memory_source");
  const orchestrator = new CanonicalChatOrchestrator({ repository, agentContext: context,
    catalog: { getCatalog: async () => catalog }, adapters: new CanonicalChatProviderRegistry([provider]) });
  const input = { clientRequestId: "req_now", baseRevision: 0,
    parts: [{ type: "text" as const, text: "Use my note" }, { type: "resource_reference" as const, resource: { kind: "memory_source" as const, id: memory.sourceId, label: memory.title, revision: "1" } }],
    selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" }, interactionMode: "default", permissionMode: "supervised" };
  try {
    await repository.create(owner, { id: "chat_memory_admission", clientRequestId: "req_create", title: "Memory" });
    const admitted = await orchestrator.admitTurn(principal, owner, "chat_memory_admission", { ...input, parts: mode === "queued" ? [input.parts[0]] : input.parts });
    if (mode === "immediate") expect(admitted.run.context?.memories).toEqual([memory]);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    const active = (await repository.get(owner, "chat_memory_admission"))!;
    const queued = await orchestrator.enqueueQueuedTurn(principal, owner, "chat_memory_admission", { ...input, clientRequestId: "req_next", baseRevision: active.chat.revision });
    expect(queued.queuedTurn.context?.memories).toEqual([memory]);
    release();
    await orchestrator.drain();
    expect(prompts).toHaveLength(2);
    expect(prompts.at(-1)).toContain("Selected original");
  } finally {
    release();
    await orchestrator.drain(); await orchestrator.close(); await repository.kysely.destroy();
  }
});
