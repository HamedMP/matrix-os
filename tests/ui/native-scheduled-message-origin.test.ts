import { expect, it } from "vitest";
import { nativeScheduledMessage } from "../../packages/ui/src/chat/scheduled-message";
import { nativeScheduledMessageFixture } from "../helpers/native-scheduled-message-fixture";
import { canonicalChatPresentation } from "../../desktop/src/renderer/src/features/chat/canonical-chat-presentation";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices";
import { buildTranscript } from "../../apps/mobile/lib/canonical-chat-transcript";

type Detail = ReturnType<typeof nativeScheduledMessageFixture>;
const derive = (detail: Detail) => nativeScheduledMessage(detail.messages[0]!, { chatId: detail.record.chat.id, turns: detail.turns, runs: detail.runs });

it("uses the original admitted Claude run, not a later retry's driver or outcome", () => {
  const detail = nativeScheduledMessageFixture("failed");
  detail.runs.push({ ...detail.runs[0]!, id: "run_retry", attempt: 2, driverKind: "codex" });
  expect(derive(detail)).toEqual({ timestamp: detail.messages[0]!.createdAt });
  expect(canonicalChatPresentation(detail)[0]!.user?.scheduledMessage).toBeTruthy();
  expect(projectCanonicalTranscript(detail).find(message => message.id === detail.messages[0]!.id)?.scheduledMessage).toBeTruthy();
  expect(buildTranscript(detail).find(message => message.id === detail.messages[0]!.id)?.scheduledMessage).toBeTruthy();
  detail.runs[0]!.driverKind = "codex";
  detail.runs[1]!.driverKind = "claude_code";
  expect(derive(detail)).toBeUndefined();
  expect(canonicalChatPresentation(detail).some(turn => turn.user?.scheduledMessage)).toBe(false);
  expect(projectCanonicalTranscript(detail).some(message => message.scheduledMessage)).toBe(false);
  expect(buildTranscript(detail).some(message => message.scheduledMessage)).toBe(false);
});

it.each<[string, (detail: Detail) => void]>([
  ["manual same-text and request prefix", detail => { detail.messages[0]!.role = "user"; detail.messages[0]!.purpose = "ai_request"; }],
  ["assistant", detail => { detail.messages[0]!.role = "assistant"; }],
  ["missing purpose", detail => { delete detail.messages[0]!.purpose; }],
  ["pending input", detail => { detail.messages[0]!.state = "pending"; }],
  ["loose request prefix", detail => { detail.turns[0]!.clientRequestId = "req_native_abc"; }],
  ["request suffix", detail => { detail.turns[0]!.clientRequestId += "_retry"; }],
  ["different turn input", detail => { detail.turns[0]!.inputMessageId = "msg_other"; }],
  ["different input turn", detail => { detail.messages[0]!.turnId = "cturn_other"; }],
  ["foreign message Chat", detail => { detail.messages[0]!.chatId = "chat_other"; }],
  ["foreign owning Chat", detail => { detail.record.chat.id = "chat_other"; }],
  ["foreign turn Chat", detail => { detail.turns[0]!.chatId = "chat_other"; }],
  ["foreign run Chat", detail => { detail.runs[0]!.chatId = "chat_other"; }],
  ["different run turn", detail => { detail.runs[0]!.turnId = "cturn_other"; }],
  ["different input run", detail => { detail.messages[0]!.runId = "run_other"; }],
  ["missing first attempt", detail => { detail.runs[0]!.attempt = 2; }],
  ["missing run", detail => { detail.runs = []; }],
  ["ambiguous first run", detail => { detail.runs.push({ ...detail.runs[0]!, id: "run_other" }); }],
  ["ambiguous turn", detail => { detail.turns.push({ ...detail.turns[0]! }); }],
  ["invalid timestamp", detail => { detail.messages[0]!.createdAt = "invalid"; }],
])("does not attribute %s as a native scheduled input", (_name, change) => {
  const detail = nativeScheduledMessageFixture();
  change(detail);
  expect(derive(detail)).toBeUndefined();
  expect(canonicalChatPresentation(detail).some(turn => turn.user?.scheduledMessage)).toBe(false);
  expect(projectCanonicalTranscript(detail).some(message => message.scheduledMessage)).toBe(false);
  expect(buildTranscript(detail).some(message => message.scheduledMessage)).toBe(false);
});

it("does not require a model-written trigger phrase or expose a task prompt", () => {
  const detail = nativeScheduledMessageFixture();
  detail.messages[0]!.parts = [{ type: "text", text: "Another safe saved projection." }];
  expect(derive(detail)).toEqual({ timestamp: detail.messages[0]!.createdAt });
  expect(Object.keys(derive(detail)!)).toEqual(["timestamp"]);
});
