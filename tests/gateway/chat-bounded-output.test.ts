import { afterEach, beforeEach, expect, it } from "vitest";
import { CanonicalChatMessageSchema } from "@matrix-os/contracts";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../packages/gateway/src/chat/provider-adapter.js";

const owner = { type: "personal" as const, ownerId: "owner_bounded_output" };
let repository: ChatRepository;
beforeEach(async () => {
  const db = await createTestPGlite();
  repository = new ChatRepository(db.dialect);
  await repository.bootstrap();
  await repository.create(owner, { id: "chat_bounded_output", clientRequestId: "req_create_bounded", title: "Bounded output" });
});
afterEach(async () => { await repository.kysely.destroy(); });

it.each(["x".repeat(4_000), `x${"\n".repeat(3_999)}`, "😀".repeat(2_000)])(
  "keeps tools, state, and completion after the assistant preview is full (%#)", async delta => {
    let consumedTerminal = false;
    const provider: CanonicalChatProviderAdapter = {
      driverKind: "codex", stateSchemaVersion: 1, parseState: value => value, serializeState: value => value,
      async *start() {
        // 30 ordinary frames suffice; this is not a real CLI or output pressure test.
        for (let index = 0; index < 30; index++) yield { type: "assistant.delta", delta };
        yield { type: "state.updated", state: { sessionId: "after_preview" } };
        yield { type: "tool.progress", toolCallId: "tool_after_preview", label: "Final tool", status: "completed" };
        consumedTerminal = true;
        yield { type: "run.completed", outcome: "completed" };
      },
    };
    const orchestrator = new CanonicalChatOrchestrator({ repository,
      catalog: { getCatalog: async () => createCanonicalProviderCatalogFixture() },
      adapters: new CanonicalChatProviderRegistry([provider]),
    });
    const admitted = await orchestrator.admitTurn({ userId: owner.ownerId, source: "jwt" }, owner, "chat_bounded_output", {
      clientRequestId: "req_bounded_turn", baseRevision: 0, parts: [{ type: "text", text: "Long response" }],
      selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" }, interactionMode: "default", permissionMode: "supervised",
    });
    await orchestrator.drain();
    const snapshot = await repository.exportChat(owner, "chat_bounded_output");
    expect(consumedTerminal).toBe(true);
    expect(snapshot?.runs[0]).toMatchObject({ status: "completed", outcome: "completed" });
    expect(snapshot?.activities).toContainEqual(expect.objectContaining({ type: "tool.progress", toolCallId: "tool_after_preview" }));
    expect(await repository.getAdapterState(owner, { runId: admitted.run.id, driverKind: "codex", instanceId: "codex_fixture" }))
      .toMatchObject({ state: { sessionId: "after_preview" } });
    const message = snapshot!.messages.find(message => message.role === "assistant")!;
    expect(CanonicalChatMessageSchema.safeParse(message).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(128 * 1024);
    const text = message.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("");
    expect(text.match(/Output preview truncated/g)).toHaveLength(1);
    expect(text).not.toMatch(/[\uD800-\uDBFF]$/u);
  },
);
