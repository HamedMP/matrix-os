import { expect, it } from "vitest";
import { canonicalChatPresentation } from "../../desktop/src/renderer/src/features/chat/canonical-chat-presentation";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices";
import { buildTranscript } from "../../apps/mobile/lib/canonical-chat-transcript";
import { nativeScheduledMessageFixture } from "../helpers/native-scheduled-message-fixture";

it("attributes a saved native system input across Electron, Web and Native Mobile without changing its stored text", () => {
  const detail = nativeScheduledMessageFixture();
  const before = JSON.stringify(detail);
  const expected = { timestamp: detail.messages[0]!.createdAt };
  expect(canonicalChatPresentation(detail)[0]!.user).toMatchObject({ markdown: "Scheduled task triggered.", scheduledMessage: expected });
  expect(projectCanonicalTranscript(detail)[0]).toMatchObject({ role: "system", content: "Scheduled task triggered.", scheduledMessage: expected });
  expect(buildTranscript(detail).find(message => message.id === detail.messages[0]!.id)).toMatchObject({ role: "system", text: "Scheduled task triggered.", scheduledMessage: expected });
  expect(JSON.stringify(detail)).toBe(before);
});

it.each(["running", "failed", "aborted"] as const)("retains the admitted input annotation through %s output and history reload", state => {
  const detail = nativeScheduledMessageFixture(state);
  const reloaded = JSON.parse(JSON.stringify(detail));
  const expected = { timestamp: detail.messages[0]!.createdAt };
  expect(canonicalChatPresentation(reloaded)[0]!.user).toMatchObject({ scheduledMessage: expected });
  expect(projectCanonicalTranscript(reloaded).filter(message => message.scheduledMessage)).toHaveLength(1);
  expect(buildTranscript(reloaded).filter(message => message.scheduledMessage)).toHaveLength(1);
});

it("keeps a previous result before the next trigger and pairs each occurrence with its own response", () => {
  const detail = nativeScheduledMessageFixture();
  const at = "2026-08-25T00:01:00.000Z";
  const input = { ...detail.messages[0]!, id: "msg_tick_two", turnId: "cturn_tick_two", seq: 3, createdAt: at };
  const run = { ...detail.runs[0]!, id: "run_tick_two", turnId: input.turnId, createdAt: at, updatedAt: at };
  detail.messages.push(input, { ...detail.messages[1]!, id: "msg_reply_two", turnId: input.turnId, runId: run.id, seq: 4,
    parts: [{ type: "text", text: "Second scheduled result." }], createdAt: at });
  detail.turns.unshift({ ...detail.turns[0]!, id: input.turnId, inputMessageId: input.id, baseMessageSeq: 2,
    clientRequestId: `req_native_${"b".repeat(64)}`, createdAt: at, updatedAt: at });
  detail.runs.push(run);
  const web = projectCanonicalTranscript(detail);
  expect(web.map(message => message.content)).toEqual(["Scheduled task triggered.", "Scheduled result.", "Scheduled task triggered.", "Second scheduled result."]);
  expect(web.filter(message => message.scheduledMessage).map(message => message.id)).toEqual([detail.messages[0]!.id, input.id]);
  const electron = canonicalChatPresentation(detail);
  expect(electron.map(turn => [turn.user!.id, turn.final?.kind === "message" && turn.final.markdown])).toEqual([
    [detail.messages[0]!.id, "Scheduled result."], [input.id, "Second scheduled result."],
  ]);
  expect(buildTranscript(detail).reverse().map(message => message.text)).toEqual(web.map(message => message.content));
});
