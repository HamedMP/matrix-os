import { describe, expect, it, vi } from "vitest";

vi.mock("../../desktop/src/renderer/src/features/chat/elements/conversation", () => {
  throw new Error("Shared conversation presentation must not load Global Chat modules");
});

describe("shared conversation module boundary", () => {
  it("loads the neutral transcript without loading Global Chat features", async () => {
    await expect(import(
      "../../desktop/src/renderer/src/components/conversation/transcript"
    )).resolves.toHaveProperty("ConversationTranscript");
  });
});
