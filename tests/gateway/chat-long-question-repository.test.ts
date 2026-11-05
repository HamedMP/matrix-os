import { expect, it } from "vitest";
import { projectChatMessageResponse } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";
import { longClaudeQuestion } from "../fixtures/long-claude-question.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

it("preserves full question descriptions through durable input, detail and export reads", async () => {
  const database = await createTestPGlite();
  const repository = new ChatRepository(database.dialect);
  const owner = { type: "personal" as const, ownerId: "owner_long_question" };
  try {
    await repository.bootstrap();
    const { snapshot } = createCanonicalChatFixture("accepted");
    const chatId = snapshot.chat.id;
    const run = { ...snapshot.runs[0]! };
    delete run.executionRoot;
    delete run.executionRootFingerprint;
    const record = await repository.create(owner, { id: chatId, title: "Question", clientRequestId: "req_question" });
    await repository.admitTurn(owner, { chatId, baseRevision: record.chat.revision,
      message: snapshot.messages[0]!, turn: snapshot.turns[0]!, run });
    await repository.markRunRunning(owner, { chatId, runId: run.id, startedAt: new Date().toISOString() });
    const question = { ...longClaudeQuestion, questionId: "q0", allowOther: true, secret: false };
    await repository.appendRunActivities(owner, chatId, run.id, [{
      id: "activity_long_question", chatId, runId: run.id, occurredAt: new Date().toISOString(),
      type: "input.requested", requestId: "long_question", title: "Input needed", questions: [question],
    }]);
    const input = await repository.getInputState(owner, { chatId, runId: run.id, requestId: "long_question" });
    expect(input.request).toMatchObject({ questions: [question] });
    const detail = await repository.getDetailPage(owner, chatId, { limit: 200 });
    expect(detail).not.toBeNull();
    const legacy = projectChatMessageResponse(detail!, "2", "1", "1", "1");
    expect(legacy.activities.find(value => value.type === "input.requested")).toMatchObject({ questions: [{
      options: longClaudeQuestion.options.map(option => ({ ...option, description: option.description.slice(0, 300) })),
    }] });
    // A legacy read must not overwrite the canonical JSONB or subsequent current reads.
    const exported = await repository.exportChat(owner, chatId);
    expect(exported?.activities.find(value => value.type === "input.requested")).toMatchObject({ questions: [question] });
    expect((await repository.getInputState(owner, { chatId, runId: run.id, requestId: "long_question" })).request)
      .toMatchObject({ questions: [question] });
  } finally { await repository.kysely.destroy(); }
});
