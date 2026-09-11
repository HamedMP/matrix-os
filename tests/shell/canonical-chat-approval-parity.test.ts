import { expect, it } from "vitest";
import { canonicalChatApprovals, type CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { buildTranscript } from "../../apps/mobile/lib/canonical-chat-transcript";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices";
import { canonicalChatPresentation } from "@desktop/renderer/src/features/chat/canonical-chat-presentation";

function fixture() {
  const { snapshot } = createCanonicalChatFixture("approval_required");
  const run = snapshot.runs[0]!;
  return { ...snapshot, activities: [{
    id: "activity_confirm", chatId: snapshot.chat.id, runId: run.id,
    occurredAt: run.updatedAt, type: "approval.requested", approvalId: "approval_confirm",
    title: "Use integration", risk: "high", allowedDecisions: ["approve", "decline", "cancel"],
  }] } as unknown as CanonicalChatDetailResponse;
}

it("renders native approval activities on Web and Native Mobile with the same run-scoped decisions", () => {
  const detail = fixture();
  const expected = { runId: detail.runs[0]!.id, approvalId: "approval_confirm", pending: true,
    title: "Use integration", allowedDecisions: ["approve", "decline", "cancel"] };
  expect(projectCanonicalTranscript(detail).map(m => m.metadata?.canonicalApproval)).toContainEqual(expect.objectContaining(expected));
  expect(buildTranscript(detail).map(m => m.approval)).toContainEqual(expect.objectContaining(expected));
});

it.each(["completed", "failed", "aborted"] as const)("never offers old approval controls after a %s run, even without a resolution event", status => {
  const detail = fixture();
  detail.runs[0]!.status = status;
  expect(projectCanonicalTranscript(detail).find(m => m.metadata?.canonicalApproval)?.metadata?.canonicalApproval).toMatchObject({ pending: false });
  expect(buildTranscript(detail).find(m => m.approval)?.approval).toMatchObject({ pending: false });
  const [view] = canonicalChatPresentation(detail);
  expect(view?.work).toContainEqual(expect.objectContaining({ requestId: "approval_confirm", state: "resolved", actions: undefined }));
});

it("deduplicates legacy parts and native activities and resolves across their different representations", () => {
  const detail = fixture();
  const run = detail.runs[0]!;
  detail.messages.push({ ...detail.messages[0]!, id: "msg_approval", seq: 2, role: "assistant", runId: run.id,
    parts: [{ type: "approval_request", approvalId: "approval_confirm", title: "Use integration",
      description: "Confirm the inventory operation", risk: "high", allowedDecisions: ["approve", "cancel"] }] });
  detail.activities.push({ id: "evt_resolve", chatId: run.chatId, runId: run.id,
    occurredAt: run.updatedAt, type: "approval.resolved", approvalId: "approval_confirm", decision: "cancel" });
  expect(canonicalChatApprovals(detail)).toEqual([expect.objectContaining({ id: "msg_approval", pending: false })]);
  expect(projectCanonicalTranscript(detail).filter(m => m.metadata?.canonicalApproval)).toHaveLength(1);
  expect(buildTranscript(detail).filter(m => m.approval)).toHaveLength(1);
  const requests = canonicalChatPresentation(detail)[0]?.work.filter(item => item.kind === "request");
  expect(requests).toEqual([expect.objectContaining({ requestId: "approval_confirm", state: "resolved", actions: undefined })]);
});

it("does not apply another run's decision to the current approval", () => {
  const detail = fixture();
  detail.activities.push({ ...detail.activities[0]!, id: "evt_other", runId: "run_other",
    type: "approval.resolved", approvalId: "approval_confirm", decision: "cancel" });
  expect(canonicalChatApprovals(detail)[0]?.pending).toBe(true);
});
