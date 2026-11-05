import { expect, it } from "vitest";
import { UserInputQuestionListSchema, projectChatMessageFrame, projectChatMessageResponse, type CanonicalChatRunActivity, type CanonicalChatTransportFrame } from "@matrix-os/contracts";
import { legacyMultibyteQuestions, longClaudeQuestion } from "../fixtures/long-claude-question.js";

const question = { ...longClaudeQuestion, questionId: "q0", allowOther: true, secret: false };
const activity: CanonicalChatRunActivity = { type: "input.requested", id: "activity_question", chatId: "chat_question", runId: "run_question", requestId: "question", title: "Input needed", occurredAt: "2026-11-05T00:00:00.000Z", questions: [question] };

it("preserves ordinary long descriptions in the shared canonical question contract", () => {
  expect(UserInputQuestionListSchema.parse([question])[0]!.options).toEqual(longClaudeQuestion.options);
});

it("bounds the full serialized UTF-8 question list, including escaping and multibyte text", () => {
  const minimal = [{ questionId: "q", header: "H", question: "Q", options: [{ label: "A", description: "x" }], allowOther: false, secret: false }];
  const overhead = Buffer.byteLength(JSON.stringify(minimal)) - 1;
  const atLimit = [{ ...minimal[0]!, options: [{ label: "A", description: "x".repeat(65_536 - overhead) }] }];
  expect(UserInputQuestionListSchema.safeParse(atLimit).success).toBe(true);
  const overflow = [{ ...minimal[0]!, options: [{ label: "A", description: "x".repeat(65_537 - overhead) }] }];
  expect(UserInputQuestionListSchema.safeParse(overflow).success).toBe(false);
  for (const description of ["界".repeat(22_000), "\\".repeat(33_000)]) {
    expect(UserInputQuestionListSchema.safeParse([{ ...minimal[0]!, options: [{ label: "A", description }] }]).success).toBe(false);
  }
});

it("projects bounded legacy descriptions without changing stored data or answer labels", () => {
  const old = projectChatMessageResponse({ activities: [activity] }, "2", "1", "1", "1");
  const projected = old.activities[0];
  expect(projected).toMatchObject({ questions: [{ options: [{ label: longClaudeQuestion.options[0].label, description: longClaudeQuestion.options[0].description.slice(0, 300) }, { label: longClaudeQuestion.options[1].label, description: longClaudeQuestion.options[1].description.slice(0, 300) }] }] });
  expect(activity).toMatchObject({ questions: [{ options: longClaudeQuestion.options }] });
  expect(projectChatMessageResponse({ activities: [activity] }, "2", "1", "1", "1", "1").activities).toEqual([activity]);
  const frame = { type: "chat.content", event: { cursor: 1 }, content: { activities: [activity] } } as CanonicalChatTransportFrame;
  expect(projectChatMessageFrame(frame, "2", "1", "1", "1", "1")).toEqual(frame);
  expect(projectChatMessageFrame(frame, "2", "1", "1", "1")).toMatchObject({ content: { activities: old.activities } });
});

it("keeps legacy projections nonblank and avoids cutting an emoji surrogate pair", () => {
  const options = [{ label: "Readable fallback", description: " ".repeat(300) + "Explanation" }, { label: "Emoji", description: "x".repeat(299) + "😀more" }];
  const original = { ...activity, questions: [{ ...question, options }] };
  const projected = projectChatMessageResponse({ activities: [original] }, "2", "1", "1", "1").activities[0];
  expect(projected).toMatchObject({ questions: [{ options: [{ label: "Readable fallback", description: "Readable fallback" }, { label: "Emoji", description: "x".repeat(299) }] }] });
  expect(original.questions[0]!.options).toEqual(options);
});


it("preserves released question shapes above the expanded-description budget", () => {
  expect(Buffer.byteLength(JSON.stringify(legacyMultibyteQuestions))).toBeGreaterThan(65_536);
  expect(UserInputQuestionListSchema.parse(legacyMultibyteQuestions)).toEqual(legacyMultibyteQuestions);
  const expanded = legacyMultibyteQuestions.map((question, index) => index === 0 ? {
    ...question, options: question.options.map((option, optionIndex) => optionIndex === 0 ? {
      ...option, description: option.description + "界",
    } : option),
  } : question);
  expect(UserInputQuestionListSchema.safeParse(expanded).success).toBe(false);
});
