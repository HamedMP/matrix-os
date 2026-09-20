import { describe, expect, it } from "vitest";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { canonicalChatPresentation } from "../../desktop/src/renderer/src/features/chat/canonical-chat-presentation";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices";
import { buildTranscript } from "../../apps/mobile/lib/canonical-chat-transcript";
import { CanonicalChatDetailResponseSchema, type CanonicalChatRunActivity } from "@matrix-os/contracts";

describe("tool detail presentation across OS surfaces", () => {
  it.each(["running", "completed"] as const)("retains command, working directory and result on %s/reload", (status) => {
    const { snapshot } = createCanonicalChatFixture(status);
    const run = snapshot.runs[0]!;
    run.status = status;
    snapshot.messages.push({ id: "msg_tool_answer", chatId: snapshot.chat.id, turnId: run.turnId, runId: run.id, role: "assistant", state: "committed", seq: 2, parts: [{ type: "text", text: "Done." }], createdAt: run.createdAt });
    const base = { chatId: snapshot.chat.id, runId: run.id, occurredAt: run.createdAt };
    const activities: CanonicalChatRunActivity[] = [
      { ...base, id: "activity_start", type: "agent.activity", activityId: "tool_details", kind: "command", label: "Run command", status, preview: "bun run test", previewKind: "command", detail: "Working directory: projects/demo" },
      { ...base, id: "activity_output", type: "tool.output", toolCallId: "tool_details", text: "12 tests passed", truncated: true },
    ];
    for (const reloaded of [false, true]) {
      const { providerBinding, activeRun, project, ...chat } = snapshot.chat;
      const detail = CanonicalChatDetailResponseSchema.parse({ record: { chat }, messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: reloaded ? JSON.parse(JSON.stringify(activities)) : activities, queuedTurns: [] });
      const desktop = canonicalChatPresentation(detail).flatMap((turn) => turn.work).flatMap((work) => work.kind === "activity-group" ? work.activities : []);
      const mobile = buildTranscript(detail).flatMap((message) => message.activities);
      const web = projectCanonicalTranscript(detail).flatMap((message) => message.toolDisplay ? [message.toolDisplay] : []);
      for (const list of [desktop, mobile, web]) {
        const activity = list.find((entry) => entry.label === "Run command");
        expect(activity?.preview).toBe("bun run test");
        expect(activity?.detail).toContain("Working directory: projects/demo");
        expect(activity?.detail).toContain("12 tests passed");
        expect(activity?.detail).toContain("Output was truncated for display.");
      }
    }
  });
});
