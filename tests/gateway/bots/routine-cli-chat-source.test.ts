import { expect, it } from "vitest";
import { createChatRoutineSourceProducer } from "../../../packages/gateway/src/chat/routine-chat-source.js";
import type { CanonicalProviderRunInput } from "../../../packages/gateway/src/chat/provider-adapter.js";

const input: CanonicalProviderRunInput = {
  owner: { type: "personal", ownerId: "user_owner_1" }, chatId: "chat_codex_source", turnId: "turn_codex_source", runId: "run_codex_source",
  prompt: "Fixture", parts: [{ type: "text", text: "Fixture" }], selection: { instanceId: "codex_default", model: "fixture-model" },
  interactionMode: "default", permissionMode: "full_access", signal: new AbortController().signal,
};
// This exercises the actual producer. Provider is a host-selected port, never a public intent field.
// The original fault labels every admitted provider as Claude before validating any database row.
it("keeps an explicitly selected Codex provider distinct from Claude without increasing its origin ceiling", () => {
  const actual = createChatRoutineSourceProducer({ input, provider: "codex", computerId: "computer_one", signal: input.signal, current: () => true, publish: () => {} });
  expect(actual.producer.source).toMatchObject({ harness: "codex", identity: { kind: "chat_run", chatId: input.chatId, runId: input.runId, route: "native" } });
  expect(actual.producer.readPolicy()).toMatchObject({ live: true, originCeiling: "exact" });
  actual.narrowNativeMode("plan");
  expect(actual.producer.readPolicy()).toMatchObject({ interactionMode: "plan", originCeiling: "read" });
  actual.narrowNativeMode("default");
  expect(actual.producer.readPolicy()).toMatchObject({ interactionMode: "plan", originCeiling: "read" });
});
it("retains the existing Claude default and synchronous source lifetime fence", () => {
  let live = true;
  const actual = createChatRoutineSourceProducer({ input, computerId: "computer_one", signal: input.signal, current: () => live, publish: () => {} });
  expect(actual.producer.source.harness).toBe("claude");
  live = false;
  expect(actual.producer.readPolicy().live).toBe(false);
});
