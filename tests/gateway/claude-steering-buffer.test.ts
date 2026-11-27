import { expect, it } from "vitest";
import { createClaudeSteeringBuffer } from "../../packages/gateway/src/chat/claude-steering-buffer";
import { ChatSteerNotDeliveredError } from "../../packages/gateway/src/chat/steer-delivery-error";
import type { CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter";

const input: CanonicalProviderRunInput = {
  owner: { type: "personal", ownerId: "owner_buffer" }, chatId: "chat_buffer", runId: "run_buffer", turnId: "cturn_buffer",
  prompt: "original", parts: [{ type: "text", text: "original" }], selection: { instanceId: "claude_default", model: "sonnet" },
  interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal,
};

it("preserves earlier accepted corrections when pending steering reaches its count bound", () => {
  const buffer = createClaudeSteeringBuffer(input);
  for (let index = 0; index < 16; index++) buffer.append(`correction ${index}`);
  const accepted = buffer.prompt;
  expect(() => buffer.append("rejected correction")).toThrow(ChatSteerNotDeliveredError);
  expect(buffer.prompt).toBe(accepted);
  expect(buffer.prompt).toBe(Array.from({ length: 16 }, (_, index) => `correction ${index}`).join("\n\n"));
});

it("refuses oversized pending input without losing the preceding correction", () => {
  const buffer = createClaudeSteeringBuffer(input);
  buffer.append("keep this correction");
  expect(() => buffer.append("x".repeat(256_001))).toThrow(ChatSteerNotDeliveredError);
  expect(buffer.prompt).toBe("keep this correction");
  expect(buffer.append("then this correction")).toBe("keep this correction\n\nthen this correction");
});
