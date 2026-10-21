import { describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat.js";

const owner = { type: "personal" as const, ownerId: "owner_selected_turn" };
const principal = { userId: owner.ownerId, source: "jwt" as const };

describe("turn discovery selection", () => {
  it("passes effective ordinary and queued selections and skips discovery on exact replay", async () => {
    const repository = new ChatRepository((await KyselyPGlite.create()).dialect);
    await repository.bootstrap();
    const catalog = createCanonicalProviderCatalogFixture();
    const instance = catalog.instances[0]!;
    const getCatalog = vi.fn(async () => catalog);
    const held = Promise.withResolvers<void>();
    const orchestrator = new CanonicalChatOrchestrator({ repository, catalog: { getCatalog },
      adapters: new CanonicalChatProviderRegistry([{ driverKind: instance.driverKind, stateSchemaVersion: 1,
        parseState: value => value, serializeState: value => value,
        start: async function* () { await held.promise; yield { type: "run.completed", outcome: "completed" }; } }]) });
    try {
      await repository.create(owner, { id: "chat_selected_turn", clientRequestId: "req_selected_create", title: "Selected" });
      const selection = { instanceId: instance.id, model: instance.models[0]!.id };
      const input = { clientRequestId: "req_selected_turn", baseRevision: 0, selection,
        interactionMode: "default", permissionMode: "supervised", parts: [{ type: "text" as const, text: "hello" }] };
      const first = await orchestrator.admitTurn(principal, owner, "chat_selected_turn", input);
      expect(getCatalog).toHaveBeenCalledWith(principal, selection);
      const repeated = await orchestrator.admitTurn(principal, owner, "chat_selected_turn", input);
      expect(repeated.run.id).toBe(first.run.id); expect(repeated.admission).toBe("already_accepted");
      expect(getCatalog).toHaveBeenCalledOnce();
      const active = await repository.get(owner, "chat_selected_turn");
      await orchestrator.enqueueQueuedTurn(principal, owner, "chat_selected_turn", { ...input, clientRequestId: "req_selected_queued", baseRevision: active!.chat.revision });
      expect(getCatalog).toHaveBeenNthCalledWith(2, principal, selection);
    } finally { held.resolve(); await orchestrator.drain(); await orchestrator.close(); await repository.kysely.destroy(); }
  });
});
