import { expect, it } from "vitest";
import { type CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { buildTranscript } from "../../apps/mobile/lib/canonical-chat-transcript";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices";

function fixture() {
  const { snapshot } = createCanonicalChatFixture("approval_required");
  const run = snapshot.runs[0]!;
  run.status = "waiting_for_input";
  return { ...snapshot, activities: [{
    id: "activity_input", chatId: snapshot.chat.id, runId: run.id,
    occurredAt: run.updatedAt, type: "input.requested", requestId: "input_confirm",
    title: "Choose a direction", questions: [{ questionId: "direction", header: "Direction", allowOther: false, secret: false, question: "Which direction?", options: [{ label: "North", description: "Go north" }], multiSelect: false }],
  }] } as unknown as CanonicalChatDetailResponse;
}

it("projects actionable provider questions consistently across Web and Native Mobile", () => {
  const detail = fixture();
  const expected = { runId: detail.runs[0]!.id, requestId: "input_confirm", title: "Choose a direction", pending: true };
  expect(projectCanonicalTranscript(detail).map(m => m.metadata?.canonicalInput)).toContainEqual(expect.objectContaining(expected));
  expect(buildTranscript(detail).map(m => m.input)).toContainEqual(expect.objectContaining(expected));
});

it.each(["completed", "failed", "aborted"] as const)("closes input controls for a %s run", status => {
  const detail = fixture();
  detail.runs[0]!.status = status;
  expect(projectCanonicalTranscript(detail).find(m => m.metadata?.canonicalInput)?.metadata?.canonicalInput).toMatchObject({ pending: false });
  expect(buildTranscript(detail).find(m => m.input)?.input).toMatchObject({ pending: false });
});
