import { describe, expect, it } from "vitest";
import { canonicalAssistantContinuationId, type CanonicalChatDetailResponse, type ProjectSetupDraft } from "@matrix-os/contracts";
import { canonicalChatPresentation } from "@desktop/renderer/src/features/chat/canonical-chat-presentation";
import { projectSetupControlsMessageId, projectSetupDetailPresentation } from "../../packages/ui/src/chat/project-setup-presentation.js";
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
  it("keeps the controls by the newest canonical setup answer through review and partial save", () => {
    const detail = generationDetail();
    const result = detail.messages.at(-1)!;
    const question = { ...result, id: "msg_review", runId: undefined, seq: 1 };
    const receipt = { ...question, id: "msg_partial_save", seq: 4 };
    const draft: ProjectSetupDraft = {
      chatId: result.chatId, projectId: "matrix-os", revision: 3, step: "review",
      currentQuestionMessageId: question.id, answers: { purpose: "Portfolio" }, proposals: [],
      mcp: { state: "skipped" }, generation: { runId: result.runId!, status: "completed" },
      updatedAt: result.createdAt,
    };
    detail.messages = [question, result, { ...result, id: canonicalAssistantContinuationId(result.id, 1), seq: 3 }];
    const displayed = projectSetupDetailPresentation(detail, draft).messages;
    expect(projectSetupControlsMessageId(draft, displayed)).toBe(result.id);
    expect(projectSetupControlsMessageId({ ...draft, currentQuestionMessageId: receipt.id }, displayed)).toBe(receipt.id);
    expect(projectSetupControlsMessageId({ ...draft, currentQuestionMessageId: receipt.id }, [...displayed, receipt])).toBe(receipt.id);
    expect(projectSetupControlsMessageId({ ...draft, step: "saved", currentQuestionMessageId: receipt.id }, [...displayed, receipt])).toBe(receipt.id);
  });

  it("hides the exact synthetic input while keeping both preceding setup answers and later user turns", () => {
    const detail = generationDetail();
    const [userInput, result] = detail.messages;
    const ordinaryParts = [{ type: "text" as const, text: 'Draft the project setup described below. {"note":"Typed by the user"}' }];
    const ownerAnswer = { ...userInput!, id: "msg_setup_answer", seq: 1, turnId: undefined, parts: ordinaryParts };
    const laterTurn = { ...detail.turns[0]!, id: "cturn_ordinary", inputMessageId: "msg_later_turn" };
    const laterInput = { ...ownerAnswer, id: laterTurn.inputMessageId, turnId: laterTurn.id, seq: 4 };
    const generationInput = {
      ...userInput!,
      purpose: "ai_request" as const,
      seq: 2,
      parts: [{ type: "text" as const, text: 'Draft the project setup described below. {"guidance":"Private provider input"}' }],
    };
    detail.messages = [ownerAnswer, generationInput, { ...result!, seq: 3 }, laterInput];
    detail.turns.push(laterTurn);

    const desktop = projectSetupDetailPresentation(detail, null);
    expect(desktop.messages.map(message => message.id)).toEqual([ownerAnswer.id, result!.id, laterInput.id]);
    expect(desktop.messages.filter(message => message.role === "user").map(message => message.parts)).toEqual([ordinaryParts, ordinaryParts]);
    expect(projectCanonicalTranscript(detail).map(message => message.id)).toEqual([ownerAnswer.id, result!.id, laterInput.id]);
    expect(detail.messages[1]).toBe(generationInput);
  });

  it("keeps the input hidden while the setup run is active and has yet to write a result", () => {
    const detail = generationDetail();
    detail.runs[0]!.status = "running";
    detail.messages = detail.messages.slice(0, 1);
    expect(projectSetupDetailPresentation(detail, null).messages).toEqual([]);
  });

  it("does not stream incomplete setup JSON into the Electron transcript", () => {
    const detail = generationDetail();
    const [run] = detail.runs;
    const [input, result] = detail.messages;
    const delta = '{"guidance":"# Incomplete draft"';
    run!.status = "running";
    delete run!.outcome;
    detail.messages = [input!];
    detail.activities = [{
      id: "activity_setup_delta", chatId: run!.chatId, turnId: run!.turnId, runId: run!.id,
      occurredAt: run!.createdAt, type: "assistant.delta", messageId: result!.id, delta,
    }];

    const present = (candidate: CanonicalChatDetailResponse) =>
      canonicalChatPresentation(projectSetupDetailPresentation(candidate, null))[0]?.work;
    expect(present(detail)).not.toContainEqual(expect.objectContaining({ markdown: delta }));

    delete run!.context;
    expect(present(detail)).toContainEqual(expect.objectContaining({ markdown: delta }));
  });

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
