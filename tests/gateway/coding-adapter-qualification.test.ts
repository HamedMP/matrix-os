import { expect, it, vi } from "vitest";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
const base = { owner: { type: "personal" as const, ownerId: "owner_coding" }, chatId: "chat_coding", turnId: "cturn_coding", runId: "run_coding", prompt: "List apps", parts: [{ type: "text" as const, text: "List apps" }], selection: { instanceId: "codex_default", model: "gpt-5.6-sol" }, interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal };
it.each(["typed", "voice"] as const)("fails %s constrained dispatch closed before legacy thread admission without qualified canonical runner wiring", async source => {
  const createThread = vi.fn(); const acceptTurn = vi.fn();
  const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: { createThread, acceptTurn } as any });
  const input = { ...base, runPolicy: { memoryMode: "ordinary" as const, source, nativeCheckpointPolicy: "reusable" as const, executionPolicy: { revision: "r1", actionMode: "safe_reads" as const, workspaceScope: "owner", tools: ["matrix_list_apps"], delegation: false } } };
  await expect(adapter.start(input).next()).rejects.toThrow("qualified canonical execution");
  await expect(adapter.resume!({ ...input, resumeState: { conversationId: "thread_old" } }).next()).rejects.toThrow("qualified canonical execution");
  expect(createThread).not.toHaveBeenCalled(); expect(acceptTurn).not.toHaveBeenCalled();
});
it.each(["claude", "opencode", "pi"] as const)("does not infer bounded canonical execution from %s supervised sandbox", async providerId => {
  const createThread = vi.fn();
  const adapter = createCanonicalCodingChatProviderAdapter({ providerId, threads: { createThread } as any });
  await expect(adapter.start({ ...base, runPolicy: { memoryMode: "ordinary", source: "typed", nativeCheckpointPolicy: "reusable", executionPolicy: { revision: "r1", actionMode: "conversation_only", workspaceScope: "owner", tools: [], delegation: false } } }).next()).rejects.toThrow("qualified canonical execution");
  expect(createThread).not.toHaveBeenCalled();
});
