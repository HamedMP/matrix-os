import { describe, expect, it } from "vitest";
import { CanonicalSubmitChatInputRequestSchema, canonicalChatInputs, buildCanonicalChatInputAnswer, UserInputAnswerRequestSchema } from "@matrix-os/contracts";
import { validateChatInputAnswer } from "../../packages/gateway/src/chat/input-submission.js";
const questions = [{ questionId: "color", header: "Color", question: "Choose colors", options: [{ label: "Red", description: "Red color" }, { label: "Blue", description: "Blue color" }], allowOther: false, secret: false }];
describe("canonical input", () => {
  it("rejects empty submissions", () => {
    expect(CanonicalSubmitChatInputRequestSchema.safeParse({ clientRequestId: "req_1" }).success).toBe(false);
  });
  it("validates choices and cardinality against the persisted question", () => {
    expect(() => validateChatInputAnswer({ questions }, { clientRequestId: "req_1", structuredAnswers: { color: ["Green"] } })).toThrow();
    expect(() => validateChatInputAnswer({ questions }, { clientRequestId: "req_1", structuredAnswers: { color: ["Red", "Blue"] } })).toThrow();
    expect(() => validateChatInputAnswer({ questions: [{ ...questions[0], multiSelect: true }] }, { clientRequestId: "req_1", structuredAnswers: { color: ["Red", "Blue"] } })).not.toThrow();
  });
  it("does not make old title-only events actionable", () => {
    const result = canonicalChatInputs({ runs: [{ id: "run_1", status: "waiting_for_input" }], turns: [], messages: [], activities: [{ id: "act_1", runId: "run_1", type: "input.requested", requestId: "req_1", title: "Input", occurredAt: "2026-09-11T00:00:00Z" }] } as never);
    expect(result[0].pending).toBe(false);
  });
});

it("accepts every offered multi-select option plus Other across canonical and native contracts", () => {
  const options = Array.from({ length: 10 }, (_, i) => ({ label: `Choice ${i}`, description: `Choice ${i}` }));
  const answers = { color: [...options.map(option => option.label), "Custom"] };
  expect(buildCanonicalChatInputAnswer({ questions: [{ ...questions[0], options, multiSelect: true, allowOther: true }] }, answers)).toEqual({ structuredAnswers: answers });
  expect(UserInputAnswerRequestSchema.safeParse({ answer: "Selected choices", structuredAnswers: answers, clientRequestId: "req_test", correlationId: "corr_test" }).success).toBe(true);
});
it("keeps a pending question actionable while another control waits for approval", () => {
  const result = canonicalChatInputs({ runs: [{ id: "run_1", status: "waiting_for_approval" }], turns: [], messages: [], activities: [{ id: "act_1", runId: "run_1", type: "input.requested", requestId: "req_1", title: "Input", questions, occurredAt: "2026-09-11T00:00:00Z" }] } as never);
  expect(result[0].pending).toBe(true);
});

it("validates legacy free-text bounds before admitting native input delivery", () => {
  const request = { questions: [{ questionId: "text", header: "Text", question: "Your answer?", allowOther: true, secret: false }] };
  expect(() => validateChatInputAnswer(request, { clientRequestId: "req_text", answer: "a".repeat(400) })).not.toThrow();
  expect(() => validateChatInputAnswer(request, { clientRequestId: "req_text", answer: "a".repeat(401) })).toThrow();
  expect(() => validateChatInputAnswer(request, { clientRequestId: "req_text", answer: "你".repeat(233) + "ab" })).toThrow();
});
