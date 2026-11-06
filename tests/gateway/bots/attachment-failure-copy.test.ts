import { expect, it, vi } from "vitest";
import { createMatrixBotChatProviderAdapter } from "../../../packages/gateway/src/bots/chat-adapter.js";
import { createManagedPiRuntime } from "../../../packages/gateway/src/chat/managed-pi-runtime.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";

const input = {
  owner: { type: "personal" as const, ownerId: "owner_copy" }, chatId: "chat_copy", turnId: "cturn_copy", runId: "run_copy",
  prompt: "Read the file", parts: [{ type: "attachment_reference" as const, attachmentId: "att_missing", kind: "file" as const,
    label: "missing.bin", mimeType: "application/octet-stream", sizeBytes: 10, ownerReference: "temporary/desktop-chat/missing.bin" }],
  selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" }, interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal,
};
it("reports the current attachment capacity consistently for unreadable Chat and Bot inputs", async () => {
  const runBot = vi.fn();
  const runtime = createManagedPiRuntime({ providers: { getSnapshot: async () => makeAiProviderSnapshot() },
    admission: {} as never, host: { client: { runBot } } as never, lifetime: new AbortController().signal,
    forgetRun() {}, cancelInference() {},
  });
  const adapter = createMatrixBotChatProviderAdapter({ orchestrator: { start: () => ({
    events: (async function* () {})(), result: Promise.resolve({ status: "blocked", inputUnavailable: true }),
  }) } as never, stopRuntime: async () => undefined });
  try {
    const messages = [];
    for (const source of [runtime.adapter, adapter]) {
      const events = []; for await (const event of source.start(input)) events.push(event);
      const event = events.at(-1);
      expect(event).toMatchObject({ type: "run.completed", error: { code: "resource_unavailable", safeMessage: expect.stringContaining("files up to 10 MiB") } });
      if (event?.type === "run.completed") messages.push(event.error?.safeMessage);
    }
    expect(messages[0]).toEqual(messages[1]); expect(runBot).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});
