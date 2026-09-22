import { expect, it } from "vitest";
import { CanonicalChatDetailResponseSchema } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { canonicalChatPresentation } from "../../desktop/src/renderer/src/features/chat/canonical-chat-presentation";
import { buildTranscript, transcriptWorkLabel } from "../../apps/mobile/lib/canonical-chat-transcript";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices";

it.each(["running", "completed", "failed"] as const)("preserves children across all surfaces with no parent prose on %s/reload", (status) => {
  const { snapshot } = createCanonicalChatFixture(status);
  const run = snapshot.runs[0]!;
  const { providerBinding, activeRun, project, ...chat } = snapshot.chat;
  const detail = CanonicalChatDetailResponseSchema.parse({ record: { chat }, turns: snapshot.turns, runs: snapshot.runs,
    messages: snapshot.messages.filter((message) => message.role === "user"), queuedTurns: [], activities: [{
      id: "activity_child", chatId: snapshot.chat.id, runId: run.id, occurredAt: run.createdAt,
      type: "agent.activity", activityId: "child_work", kind: "delegation", label: "Research", status: "failed",
      subagent: { agentId: "agent_child", parentAgentId: "agent_parent", name: "Research", status: "failed", task: "Review tests" },
    }],
  });
  for (const replay of [detail, CanonicalChatDetailResponseSchema.parse(JSON.parse(JSON.stringify(detail)))]) {
    const desktop = canonicalChatPresentation(replay).flatMap((turn) => turn.work).flatMap((work) => work.kind === "activity-group" ? work.activities : []);
    const mobileMessages = buildTranscript(replay);
    const childMessage = mobileMessages.find(message => message.activities.some(activity => activity.subagent))!;
    expect(transcriptWorkLabel(childMessage)).toBeTruthy();
    const later = { ...replay.messages[0]!, id: "msg_later", seq: 100, createdAt: "2026-08-26T00:00:00.000Z" };
    expect(buildTranscript({ ...replay, messages: [...replay.messages, later] }).filter(message => message.role !== "system")[0]?.id).toBe("msg_later");
    const mobile = mobileMessages.flatMap((message) => message.activities);
    const web = projectCanonicalTranscript(replay).flatMap((message) => message.toolDisplay ? [message.toolDisplay] : []);
    for (const list of [desktop, mobile, web]) expect(list.filter((activity) => activity.subagent).map((activity) => activity.subagent)).toEqual([
      { agentId: "agent_child", parentAgentId: "agent_parent", name: "Research", status: "failed", task: "Review tests" },
    ]);
  }
});
