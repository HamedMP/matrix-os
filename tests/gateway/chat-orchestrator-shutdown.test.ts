import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { adapter, catalog, owner, principal } from "./chat-orchestrator-test-support.js";

let repository: ChatRepository;
beforeEach(async () => {
  repository = new ChatRepository((await createTestPGlite()).dialect);
  await repository.bootstrap();
});
afterEach(async () => { vi.useRealTimers(); await repository.kysely.destroy(); });

  it("bounds shutdown even when a Provider ignores cancellation", async () => {
    await repository.create(owner, {
      id: "chat_shutdown",
      clientRequestId: "req_create_shutdown",
      title: "Shutdown",
    });
    let entered!: () => void;
    const providerEntered = new Promise<void>(resolve => { entered = resolve; });
    let cancelling!: () => void;
    const cancelEntered = new Promise<void>(resolve => { cancelling = resolve; });
    const provider = {
      ...adapter(async function* () {
        entered();
        await new Promise<void>(() => undefined);
        yield { type: "run.completed", outcome: "completed" };
      }),
      cancel: vi.fn(async () => { cancelling(); return new Promise<void>(() => undefined); }),
    };
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([provider]),
      shutdownDrainMs: 20,
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    });
    await orchestrator.admitTurn(principal, owner, "chat_shutdown", {
      clientRequestId: "req_shutdown_turn",
      baseRevision: 0,
      parts: [{ type: "text", text: "hang" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
    });

    await providerEntered;
    expect((await repository.exportChat(owner, "chat_shutdown"))?.runs[0]?.status).toBe("running");
    let committed!: () => void;
    const abortedCommitted = new Promise<void>(resolve => { committed = resolve; });
    const finish = repository.finishRun.bind(repository);
    vi.spyOn(repository, "finishRun").mockImplementation(async (scope, input) => {
      const result = await finish(scope, input);
      if (input.outcome === "aborted") committed();
      return result;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const startedAt = Date.now();
    const closing = Promise.race([
      orchestrator.close().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    await Promise.all([abortedCommitted, cancelEntered]);
    await vi.advanceTimersByTimeAsync(20);
    expect(await closing).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(500);
    const snapshot = await repository.exportChat(owner, "chat_shutdown");
    expect(snapshot?.runs[0]).toMatchObject({ status: "aborted", outcome: "aborted" });
  });
