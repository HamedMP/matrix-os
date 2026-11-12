import { expect, it } from "vitest";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { canonicalChatPresentation } from "@desktop/renderer/src/features/chat/canonical-chat-presentation";
import { projectCanonicalMessages } from "../../shell/src/lib/canonical-chat-client";
import { buildTranscript } from "../../apps/mobile/lib/canonical-chat-transcript";
import { conversationTurnVisibility } from "@desktop/renderer/src/components/conversation/turn-visibility";

it("presents and copies continuation rows as one complete final reply on Electron, Web and Native Mobile", () => {
  const { snapshot } = createCanonicalChatFixture("completed");
  const base = { ...snapshot.messages[0]!, role: "assistant" as const, seq: 2, runId: snapshot.runs[0]!.id };
  const prefix = "REPLY_START" + "x".repeat(96_000);
  const tail = "REPLY_TAIL" + "y".repeat(40_000);
  const parts = (text: string) => Array.from({ length: Math.ceil(text.length / 24_000) }, (_, index) => ({ type: "text" as const, text: text.slice(index * 24_000, (index + 1) * 24_000) }));
  const message = { ...base, id: "msg_synthetic_assistant", parts: parts(prefix) };
  const continuation = { ...message, id: `${message.id}_continued_1`, seq: message.seq + 1, parts: parts(tail) };
  const input = { ...snapshot, messages: [...snapshot.messages.filter(item => item.role !== "assistant"), message, continuation] };
  const final = canonicalChatPresentation(input)[0]!.final!;
  expect(final).toMatchObject({ kind: "message", markdown: prefix + tail, copyText: prefix + tail });
  expect(canonicalChatPresentation({ ...input, streamedMessageIds: [continuation.id] })[0]!.final).toMatchObject({ wasStreamed: true });
  expect(projectCanonicalMessages(input.messages).filter(item => item.role === "assistant").map(item => item.content)).toEqual([prefix + tail]);
  expect(buildTranscript({ ...input, record: { chat: input.chat } }).filter(item => item.role === "assistant").map(item => item.text)).toEqual([prefix + tail]);
  const stopped = canonicalChatPresentation({ ...input, runs: input.runs.map(run => ({ ...run, status: "aborted" as const, outcome: "aborted" as const })) })[0]!;
  expect(stopped.final).toMatchObject({ kind: "notice", tone: "stopped" });
  expect(conversationTurnVisibility(stopped, false).visibleWork).toContainEqual(expect.objectContaining({ markdown: prefix + tail }));
});
