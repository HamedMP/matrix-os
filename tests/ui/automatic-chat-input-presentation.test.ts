import { expect, it } from "vitest";
import { canonicalChatPresentation } from "../../desktop/src/renderer/src/features/chat/canonical-chat-presentation";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices";
import { nativeScheduledMessageFixture } from "../helpers/native-scheduled-message-fixture";

const slackInstruction = "Summarize the new Slack message in English in this private Chat.";

function slackAutomationDetail(state: "running" | "completed" = "completed") {
  const detail = nativeScheduledMessageFixture(state);
  const input = detail.messages[0]!;
  input.role = "user";
  input.purpose = "ai_request";
  input.parts = [{ type: "text", text: slackInstruction }];
  detail.turns[0]!.clientRequestId = `req_slack_summary_${"a".repeat(40)}`;
  detail.runs[0]!.driverKind = "matrix_bot";
  detail.messages[1]!.parts = [{ type: "text", text: "The release task moved to Done." }];
  return detail;
}

it.each(["running", "completed"] as const)("omits the saved Slack input for a %s run and preserves the reply", state => {
  const detail = slackAutomationDetail(state);
  const before = JSON.stringify(detail);
  const inputId = detail.messages[0]!.id;
  const outputId = detail.messages[1]!.id;
  const web = projectCanonicalTranscript(detail);
  expect(web.some(message => message.id === inputId)).toBe(false);
  expect(web.find(message => message.id === outputId)?.content).toBe("The release task moved to Done.");
  const [desktop] = canonicalChatPresentation(detail);
  expect(desktop?.user).toBeUndefined();
  expect(desktop?.[state === "completed" ? "final" : "work"]).toEqual(state === "completed"
    ? expect.objectContaining({ id: outputId, markdown: "The release task moved to Done." })
    : expect.arrayContaining([expect.objectContaining({ id: outputId, markdown: "The release task moved to Done." })]));
  expect(JSON.stringify(detail)).toBe(before);
});

it.each([
  ["a human who types the same instruction", (detail: ReturnType<typeof slackAutomationDetail>) => {
    detail.turns[0]!.clientRequestId = "req_human_example";
  }],
  ["a request that merely resembles the protected format", (detail: ReturnType<typeof slackAutomationDetail>) => {
    detail.turns[0]!.clientRequestId += "_example";
  }],
  ["a routine request-shaped ID in an ordinary Chat", (detail: ReturnType<typeof slackAutomationDetail>) => {
    detail.turns[0]!.clientRequestId = `req_routine_fire_${"b".repeat(24)}`;
  }],
  ["an input from a different Chat", (detail: ReturnType<typeof slackAutomationDetail>) => {
    detail.messages[0]!.chatId = "chat_other";
  }],
  ["a message without the matching turn", (detail: ReturnType<typeof slackAutomationDetail>) => {
    detail.messages[0]!.turnId = "cturn_other";
  }],
])("keeps the visible input for %s", (_case, change) => {
  const detail = slackAutomationDetail();
  change(detail);
  expect(projectCanonicalTranscript(detail).find(message => message.id === detail.messages[0]!.id)?.content).toBe(slackInstruction);
  expect(canonicalChatPresentation(detail)[0]?.user?.markdown).toBe(slackInstruction);
});

it("keeps a later human follow-up with identical text in an automatic Slack turn", () => {
  const detail = slackAutomationDetail("running");
  detail.messages.push({ ...detail.messages[0]!, id: "msg_manual_followup", seq: 3 });
  const web = projectCanonicalTranscript(detail).filter(message => message.role === "user");
  expect(web.map(message => message.id)).toEqual(["msg_manual_followup"]);
  expect(canonicalChatPresentation(detail)[0]?.userFollowups?.map(message => message.id)).toEqual(["msg_manual_followup"]);
});

it("omits a protected occurrence in a routine-only Chat even when the schedule history is unavailable", () => {
  const detail = slackAutomationDetail();
  const chatId = `chat_routine_${"c".repeat(32)}`;
  detail.record.chat.id = chatId;
  for (const item of [...detail.messages, ...detail.turns, ...detail.runs]) item.chatId = chatId;
  detail.turns[0]!.clientRequestId = `req_routine_fire_${"b".repeat(24)}_a2`;
  const web = projectCanonicalTranscript(detail);
  expect(web.some(message => message.id === detail.messages[0]!.id)).toBe(false);
  expect(web.find(message => message.id === detail.messages[1]!.id)?.role).toBe("assistant");
  const [desktop] = canonicalChatPresentation(detail);
  expect(desktop?.user).toBeUndefined();
  expect(desktop?.final?.id).toBe(detail.messages[1]!.id);
});

it("keeps an old scheduled input hidden when its original Run aged out", () => {
  const detail = nativeScheduledMessageFixture();
  detail.runs = [];
  const inputId = detail.messages[0]!.id;
  const outputId = detail.messages[1]!.id;
  const web = projectCanonicalTranscript(detail);
  expect(web.some(message => message.id === inputId)).toBe(false);
  expect(web.find(message => message.id === outputId)?.content).toBe("Scheduled result.");
  const [desktop] = canonicalChatPresentation(detail);
  expect(desktop?.user).toBeUndefined();
  expect(desktop?.final?.id).toBe(outputId);
});
