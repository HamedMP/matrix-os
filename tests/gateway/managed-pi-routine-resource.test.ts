import { expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { createManagedPiRoutineSource } from "../../packages/gateway/src/chat/managed-pi-routine-source.js";
import type { ManagedPiRuntimeBinding } from "../../packages/gateway/src/bots/runtime-registry.js";
/** Resource-only fixture: registration never grants authority or fabricates a source/capability/receipt. */
function resourceFixture() {
  const controller = new AbortController();
  const binding: ManagedPiRuntimeBinding = { kind: "managed_chat", runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", ownerId: "user_resource", chatId: "chat_resource", runId: "run_resource",
    workspace: { kind: "chat_workspace" }, rootFingerprint: "a".repeat(64), route: { api: "anthropic-messages", modelId: "fixture", input: ["text"], contextWindow: 1000, maxOutputTokens: 100 },
    capabilities: ["routine.cli"], accessSourceId: "matrix_included", requestClass: "interactive" };
  const registerManagedChat = vi.fn((input: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
    input.signal.addEventListener("abort", () => reject(new Error("Resource-only admission cancelled")), { once: true });
  }));
  const options = { runtime: { registerManagedChat }, binPath: resolve("packages/sync-client/bin/matrix.mjs"), endpoint: "http://127.0.0.1:1234/api/routine-cli/execute", homePath: process.cwd(), binding,
    input: { owner: { type: "personal" as const, ownerId: binding.ownerId }, chatId: binding.chatId, runId: binding.runId, turnId: "cturn_resource", prompt: "Fixture", parts: [{ type: "text" as const, text: "Fixture" }],
      selection: { instanceId: "matrix_pi_default", model: "fixture" }, permissionMode: "supervised", interactionMode: "default", signal: controller.signal },
    signal: controller.signal, current: () => true, publish: vi.fn() };
  return { binding, controller, registerManagedChat, options };
}
it("caps managed active calls before any registration wait and drains cancellation with original UUID", async () => {
  const f = resourceFixture(), source = createManagedPiRoutineSource(f.options);
  const operation = { operation: "pause" as const, routineId: `rt_${"a".repeat(24)}`, baseRevision: 1, requestId: "de000000-0000-4000-8000-000000000a09" };
  const pending = Array.from({ length: 8 }, (_, i) => source.execute(f.binding, operation, `call_${i}`, f.controller.signal));
  await expect(source.execute(f.binding, operation, "call_ninth", f.controller.signal)).rejects.toMatchObject({ code: "stale_generation" });
  expect(f.registerManagedChat).toHaveBeenCalledTimes(1);
  f.controller.abort();
  for (const value of await Promise.all(pending)) {
    expect(value).toMatchObject({ ok: true, content: [{ text: expect.stringContaining(operation.requestId) }] });
  }
  await source.close();
  await expect(source.execute(f.binding, operation, "call_after_end", new AbortController().signal)).rejects.toMatchObject({ code: "stale_generation" });
});
it("checks the fixed published CLI and registration dependencies before managed worker tool availability", () => {
  const f = resourceFixture();
  expect(() => createManagedPiRoutineSource({ ...f.options, binPath: "/bin/sh" })).toThrow();
  expect(() => createManagedPiRoutineSource({ ...f.options, endpoint: "https://foreign.example/api/routine-cli/execute?source=forged" })).toThrow();
  expect(() => createManagedPiRoutineSource({ ...f.options, homePath: "relative" })).toThrow();
});
it("expires the source without a worker reply or cleanup acknowledgement", async () => {
  vi.useFakeTimers();
  const f = resourceFixture(), source = createManagedPiRoutineSource(f.options);
  try {
    vi.advanceTimersByTime(30 * 60_000);
    await expect(source.execute(f.binding, { operation: "list" }, "call_expired", f.controller.signal)).rejects.toMatchObject({ code: "stale_generation" });
    expect(f.registerManagedChat).not.toHaveBeenCalled();
    await source.close();
  } finally { vi.useRealTimers(); }
});
