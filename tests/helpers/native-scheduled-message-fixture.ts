import { CanonicalChatDetailResponseSchema } from "@matrix-os/contracts";
import { createCanonicalChatFixture, type CanonicalChatFixtureState } from "../contracts/fixtures/canonical-chat";

export function nativeScheduledMessageFixture(state: CanonicalChatFixtureState = "completed") {
  const { snapshot } = createCanonicalChatFixture(state);
  const input = { ...snapshot.messages[0]!, role: "system" as const, purpose: "system" as const,
    parts: [{ type: "text" as const, text: "Scheduled task triggered." }] };
  const turn = { ...snapshot.turns[0]!, clientRequestId: `req_native_${"a".repeat(64)}` };
  const run = { ...snapshot.runs[0]!, driverKind: "claude_code" as const };
  const { project: _project, providerBinding: _binding, activeRun: _active, ...chat } = snapshot.chat;
  return CanonicalChatDetailResponseSchema.parse({
    record: { chat: { ...chat, messageCount: 2 } },
    messages: [input, { ...input, id: "msg_scheduled_result", seq: 2, role: "assistant", purpose: "assistant", runId: run.id,
      parts: [{ type: "text", text: "Scheduled result." }] }],
    turns: [turn], runs: [run], activities: [],
  });
}
