import { expect, it } from "vitest";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { adapter, catalog, owner, principal } from "./chat-orchestrator-test-support.js";

it.each(["auto", "auto_accept_edits"])("retries historical Codex %s runs with human approval", async permissionMode => {
  const database = await createTestPGlite();
  const repository = new ChatRepository(database.dialect);
  await repository.bootstrap();
  let historical = true;
  const observed: string[] = [];
  const orchestrator = new CanonicalChatOrchestrator({ repository,
    catalog: { getCatalog: async () => {
      const value = catalog();
      value.instances[0]!.supports.permissionModes = historical ? [permissionMode] : ["supervised", "auto_review", "full_access"];
      return value;
    } },
    adapters: new CanonicalChatProviderRegistry([adapter(async function* (input) {
      observed.push(input.permissionMode);
      yield { type: "run.completed", outcome: "failed" };
    })]),
  });
  try {
    await repository.create(owner, { id: "chat_legacy_retry", clientRequestId: "req_legacy_create", title: "Legacy" });
    const first = await orchestrator.admitTurn(principal, owner, "chat_legacy_retry", {
      clientRequestId: "req_legacy_turn", baseRevision: 0, parts: [{ type: "text", text: "Retry me" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" }, interactionMode: "default", permissionMode,
    });
    await orchestrator.drain();
    historical = false;
    const failed = await repository.get(owner, "chat_legacy_retry");
    const retried = await orchestrator.retryTurn(principal, owner, "chat_legacy_retry", first.turn.id, {
      clientRequestId: "req_legacy_retry", baseRevision: failed!.chat.revision,
    });
    expect(retried.run.permissionMode).toBe("supervised");
    await orchestrator.drain();
    expect(observed).toEqual([permissionMode, "supervised"]);
    expect((await repository.exportChat(owner, "chat_legacy_retry"))?.runs[0]?.permissionMode).toBe(permissionMode);
  } finally {
    await orchestrator.close();
    await repository.kysely.destroy();
  }
});
