import { expect, it } from "vitest";
import { CanonicalChatMessageSchema, CanonicalChatUserInputPartSchema, CanonicalChatMessagePartSchema } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "./fixtures/canonical-chat";

it("accepts bounded whitespace in stored assistant output while retaining strict user input", () => {
  const { snapshot } = createCanonicalChatFixture("completed");
  const base = { ...snapshot.messages[0]!, role: "assistant" as const, seq: 2, runId: snapshot.runs[0]!.id };
  const parts = [{ type: "text", text: "\n\n\n" }];
  expect(CanonicalChatMessageSchema.safeParse({ ...base, parts }).success).toBe(true);
  expect(CanonicalChatMessageSchema.safeParse({ ...base, role: "user", parts }).success).toBe(false);
  expect(CanonicalChatUserInputPartSchema.safeParse(parts[0]).success).toBe(false);
  expect(CanonicalChatMessagePartSchema.safeParse(parts[0]).success).toBe(false);
});
