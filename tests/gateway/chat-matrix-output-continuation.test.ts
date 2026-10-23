import { CanonicalChatMessageSchema, CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { expect, it } from "vitest";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

const catalog = CanonicalProviderCatalogSchema.parse({
  revision: "matrix_output_test",
  drivers: [{ kind: "matrix_pi", displayName: "Matrix AI", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
  instances: [{ id: "matrix_pi_default", driverKind: "matrix_pi", displayName: "Matrix AI", availability: "available",
    workspaceRequirement: "project_optional", catalogRevision: "matrix_output_test",
    models: [{ id: "synthetic-model", displayName: "Synthetic", availability: "available", capabilities: ["tools"], supportsVision: false, supportsToolUse: true }],
    options: [], skills: [], commands: [], setupActions: [],
    supports: { rootChat: true, resume: false, cancellation: true, steering: "none", attachments: ["file"], tools: [],
      approvals: true, userInput: true, worktrees: "none", resources: [], interactionModes: ["default"], permissionModes: ["supervised"] },
  }],
});

it.each(["escaped", "whitespace-boundary", "terminal-refetch"])("saves and reloads an entire Matrix AI reply beyond 96 KiB (%s)", async kind => {
  const pglite = await createTestPGlite();
  const repository = new ChatRepository(pglite.dialect);
  const owner = { type: "personal" as const, ownerId: "owner_output_segments" };
  const chunks = kind === "escaped"
    ? [...Array.from({ length: 70 }, (_, index) => `${index}:` + "🧪\"\\\n".repeat(450)), "FINAL_OUTPUT_IS_RETAINED"]
    : kind === "whitespace-boundary"
      ? [...Array.from({ length: 24 }, () => "x".repeat(4_000)), "x".repeat(2_300), "\n\n\n"]
      : [...Array.from({ length: 300 }, () => "x".repeat(4_000)), "FINAL_OUTPUT_IS_RETAINED"];
  const expected = chunks.join("");
  const adapter: CanonicalChatProviderAdapter = { driverKind: "matrix_pi", stateSchemaVersion: 1,
    parseState: value => value, serializeState: value => value,
    async *start() {
      for (const delta of chunks) yield { type: "assistant.delta", delta };
      yield { type: "run.completed", outcome: "completed" };
    }, async cancel() {},
  };
  try {
    await repository.bootstrap();
    await repository.create(owner, { id: "chat_output_segments", clientRequestId: "req_output_segments", title: "Synthetic output" });
    const orchestrator = new CanonicalChatOrchestrator({ repository, catalog: { getCatalog: async () => catalog },
      adapters: new CanonicalChatProviderRegistry([adapter]) });
    const admitted = await orchestrator.admitTurn({ userId: owner.ownerId, source: "jwt" }, owner, "chat_output_segments", {
      clientRequestId: "req_output_segments_turn", baseRevision: 0, parts: [{ type: "text", text: "Synthetic long response" }],
      selection: { instanceId: "matrix_pi_default", model: "synthetic-model" }, interactionMode: "default", permissionMode: "supervised",
    });
    await orchestrator.drain();
    const snapshot = await repository.exportChat(owner, "chat_output_segments");
    const messages = snapshot!.messages.filter(message => message.role === "assistant");
    expect(messages.flatMap(message => message.parts.flatMap(part => part.type === "text" ? [part.text] : [])).join("")).toBe(expected);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every(message => CanonicalChatMessageSchema.safeParse(message).success && message.state === "committed")).toBe(true);
    expect(snapshot!.runs.find(run => run.id === admitted.run.id)?.outcome).toBe("completed");
    const reloaded = await repository.getMessages(owner, "chat_output_segments", { afterSeq: 1, limit: 200 });
    expect(reloaded).toEqual(messages);
    expect(await repository.getMessages({ ...owner, ownerId: "another_owner" }, "chat_output_segments", { afterSeq: 0, limit: 200 })).toEqual([]);
  } finally { await repository.kysely.destroy(); }
});
