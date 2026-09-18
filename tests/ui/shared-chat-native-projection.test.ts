import { describe, expect, it } from "vitest";
import { projectSharedChatTimeline } from "../../packages/ui/src/collaboration/chat-projection";

const base = {
  chatId: "chat_shared",
  state: "committed" as const,
  createdAt: "2026-09-17T12:00:00.000Z",
};

describe("native shared Chat projection", () => {
  it("keeps AI requests and responses in sequence while excluding human-only discussion", () => {
    const projected = projectSharedChatTimeline([
      { ...base, id: "note", sequence: "1", role: "user" as const, purpose: "discussion" as const,
        actor: { actorId: "user_editor", displayName: "Ada" }, parts: [{ type: "text" as const, text: "Private note" }] },
      { ...base, id: "prompt", sequence: "2", role: "user" as const, purpose: "ai_request" as const,
        actor: { actorId: "user_editor", displayName: "Ada" }, parts: [{ type: "text" as const, text: "Plan release" }] },
      { ...base, id: "answer", sequence: "3", role: "assistant" as const, purpose: "assistant" as const,
        actor: { actorId: "matrix_ai", displayName: "Matrix AI" }, parts: [{ type: "text" as const, text: "Release plan" }] },
    ]);

    expect(projected.map((message) => message.id)).toEqual(["prompt", "answer"]);
    expect(projected[0]).toMatchObject({ side: "human", attribution: { displayName: "Ada" } });
    expect(projected[1]).toMatchObject({ side: "ai" });
    expect(projected[1]).not.toHaveProperty("attribution");
  });

  it("uses a safe deterministic fallback for an unavailable human author", () => {
    const [message] = projectSharedChatTimeline([{
      ...base,
      id: "prompt",
      sequence: "1",
      role: "user",
      purpose: "ai_request",
      actor: { actorId: "user_missing", displayName: "Unknown participant" },
      parts: [{ type: "text", text: "Continue" }],
    }]);
    expect(message?.attribution).toEqual({ actorId: "user_missing", displayName: "Unknown participant" });
  });
});
