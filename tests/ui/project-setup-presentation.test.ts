import { describe, expect, it } from "vitest";
import { canonicalAssistantContinuationId, type CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { projectSetupDetailPresentation } from "../../packages/ui/src/chat/project-setup-presentation.js";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";

function generationDetail(): CanonicalChatDetailResponse {
  const { snapshot } = createCanonicalChatFixture("completed");
  const run = { ...snapshot.runs[0]!, context: { version: 1 as const, requestHash: "a".repeat(64), chats: [], projectSetupDraft: { revision: 3 } } };
  return {
    record: { chat: snapshot.chat, projectId: "matrix-os" },
    messages: [...snapshot.messages, { id: "msg_generated", chatId: snapshot.chat.id, turnId: run.turnId, runId: run.id,
      seq: 2, role: "assistant", purpose: "assistant", state: "committed", parts: [{ type: "text", text: '{"guidance":"# Private draft"}' }], createdAt: run.createdAt }],
    turns: snapshot.turns, runs: [run], activities: [],
  };
}

describe("durable setup generation presentation", () => {
  it("keeps internal JSON out of the transcript after an answer or Markdown revision invalidates the current generation", () => {
    const projected = projectSetupDetailPresentation(generationDetail(), null);
    expect(projected.messages.at(-1)?.parts).toEqual([{ type: "text", text: "I drafted your project files for review." }]);
    expect(JSON.stringify(projected.messages)).not.toContain("Private draft");
  });

  it("uses the same durable projection in Web Chat", () => {
    const messages = projectCanonicalTranscript(generationDetail());
    expect(messages.at(-1)?.content).toBe("I drafted your project files for review.");
  });

  it("projects a split result as one normal reply while retaining a separate commentary message", () => {
    const detail = generationDetail();
    const result = detail.messages.at(-1)!;
    detail.messages = [detail.messages[0]!, { ...result, id: "msg_commentary", seq: 2, purpose: "assistant", parts: [{ type: "text", text: "I will prepare the draft." }] },
      { ...result, seq: 3, parts: [{ type: "text", text: '{"guidance":' }] },
      { ...result, id: canonicalAssistantContinuationId(result.id, 1), seq: 4, parts: [{ type: "text", text: '"# Private draft"}' }] }];
    const projected = projectSetupDetailPresentation(detail, null);
    expect(projected.messages.map(message => message.parts)).toContainEqual([{ type: "text", text: "I will prepare the draft." }]);
    expect(projected.messages.at(-1)?.parts).toEqual([{ type: "text", text: "I drafted your project files for review." }]);
    expect(JSON.stringify(projected.messages)).not.toContain("Private draft");
  });

  it("leaves ordinary assistant JSON untouched without server setup provenance", () => {
    const detail = generationDetail();
    delete detail.runs[0]!.context;
    expect(projectSetupDetailPresentation(detail, null)).toBe(detail);
  });
});
