import { afterEach, expect, it, vi } from "vitest";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { canonicalChatSafeFailureReason } from "@matrix-os/contracts";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { catalog, owner, principal } from "./helpers/canonical-codex-catalog.js";

afterEach(() => vi.restoreAllMocks());

it("persists a useful, safe diagnosis when an agent connection fails unexpectedly", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const db = await createTestPGlite();
  const repository = new ChatRepository(db.dialect);
  await repository.bootstrap();
  try {
    await repository.create(owner, { id: "chat_unexpected_failure", clientRequestId: "req_unexpected_failure",
      title: "Unexpected failure" });
    const provider: CanonicalChatProviderAdapter<{ sessionId: string }> = {
      driverKind: "codex", stateSchemaVersion: 1,
      parseState: (value) => value as { sessionId: string },
      serializeState: (value) => value,
      async *start() {
        throw Object.assign(new Error("secret=private /home/matrix/hidden"), { code: "ECONNRESET" });
      },
    };
    const orchestrator = new CanonicalChatOrchestrator({ repository,
      catalog: { getCatalog: async () => catalog },
      adapters: new CanonicalChatProviderRegistry([provider]),
    });
    const admitted = await orchestrator.admitTurn(principal, owner, "chat_unexpected_failure", {
      clientRequestId: "req_unexpected_failure_turn", baseRevision: 0,
      parts: [{ type: "text", text: "Help" }],
      selection: { instanceId: "codex_default", model: "model" },
      interactionMode: "default", permissionMode: "supervised",
    });
    await orchestrator.drain();
    const snapshot = await repository.exportChat(owner, "chat_unexpected_failure");
    const error = snapshot?.activities.find((activity) => activity.type === "run.error"
      && activity.runId === admitted.run.id);
    expect(error).toMatchObject({ type: "run.error", error: {
      code: "run_failed", safeMessage: "The agent connection was interrupted.",
    } });
    if (error?.type !== "run.error") throw new Error("Missing persisted failure");
    expect(canonicalChatSafeFailureReason(error.error.code, error.error.safeMessage))
      .toBe("The agent connection was interrupted.");
    expect(JSON.stringify(snapshot)).not.toContain("secret=private");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("secret=private");
  } finally {
    await repository.kysely.destroy();
  }
});
