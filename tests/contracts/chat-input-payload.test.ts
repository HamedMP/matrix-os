import { describe, expect, it } from "vitest";
import { CanonicalChatRunActivitySchema } from "../../packages/contracts/src/index.js";
import { CanonicalProviderRunEventSchema } from "../../packages/gateway/src/chat/provider-adapter.js";

describe("canonical structured input", () => {
  it("preserves the complete form between provider and chat activity", () => {
    const input = { type: "input.requested", requestId: "req_question", title: "Connector request",
      input: { requestId: "req_question", threadId: "thread_question", title: "Connector request", safeDescription: "Review this request.",
        required: false, connectorActionId: "question_action", correlationId: "corr_question",
        questions: [{ questionId: "question_action", header: "Permission", question: "Allow once?", options: [{ label: "Allow once", description: "Run once." }], allowOther: false, secret: false }] } };
    expect(CanonicalProviderRunEventSchema.parse(input)).toEqual(input);
    expect(CanonicalChatRunActivitySchema.parse({ ...input, id: "activity_question", runId: "run_question", chatId: "chat_question", occurredAt: "2026-09-07T00:00:00.000Z" })).toMatchObject({ input: input.input });
  });
});
