import { expect, it } from "vitest";
import { canonicalChatApprovals, type CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { buildTranscript } from "../../apps/mobile/lib/canonical-chat-transcript";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices";
import { canonicalChatPresentation } from "@desktop/renderer/src/features/chat/canonical-chat-presentation";

function fixture(): CanonicalChatDetailResponse {
  const { snapshot } = createCanonicalChatFixture("approval_required");
  const run = snapshot.runs[0]!;
  const { providerBinding, activeRun, ...chat } = snapshot.chat;
  return { record: { chat, providerBinding, activeRun }, messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: [{
    id: "activity_confirm", chatId: snapshot.chat.id, runId: run.id,
    occurredAt: run.updatedAt, type: "approval.requested", approvalId: "approval_confirm",
    title: "Use integration", risk: "high", allowedDecisions: ["approve", "decline", "cancel"],
  }] };
}

function routineFixture() {
  const detail = fixture();
  const run = detail.runs[0]!;
  const request = detail.activities[0]!;
  if (request.type !== "approval.requested") throw new Error("Missing fixture approval");
  request.approvalId = `rcact_${"a".repeat(32)}`;
  request.title = "Allow routine propose?";
  request.occurredAt = "2026-08-25T00:00:02.000Z";
  run.status = "completed";
  detail.activities.push({ id: "evt_routine_approve", chatId: run.chatId, runId: run.id,
    type: "approval.resolved", approvalId: request.approvalId, decision: "approve", occurredAt: "2026-08-25T00:00:03.000Z" });
  const source = detail.messages[0]!;
  detail.messages.push(
    { ...source, id: "msg_intro", seq: 2, role: "assistant", runId: run.id, createdAt: "2026-08-25T00:00:01.000Z",
      parts: [{ type: "text", text: "I can schedule this." }] },
    { ...source, id: "msg_proposed", seq: 3, role: "assistant", runId: run.id, createdAt: "2026-08-25T00:00:04.000Z",
      parts: [{ type: "text", text: "I submitted the proposal." }] },
    { id: "msg_routine_result", seq: 4, chatId: source.chatId, role: "system", purpose: "system", state: "committed", createdAt: "2026-08-25T00:02:04.000Z",
      parts: [{ type: "routine_receipt", engine: "matrix", kind: "output", routineId: `rt_${"a".repeat(24)}`,
        fireId: `fire_${"a".repeat(24)}`, attempt: 1, status: "completed", scheduledFor: "2026-08-25T00:02:03.000Z",
        canonicalChatId: "chat_bot", canonicalTaskId: "task_routine", model: "gpt-fixture" }, { type: "text", text: "The schedule ran." }] },
  );
  return detail;
}

it("keeps a resolved routine operation in its turn ahead of the proposal reply and scheduled result", () => {
  const detail = routineFixture();
  const expected = [detail.messages[0]!.id, "msg_intro", "activity_confirm", "msg_proposed", "msg_routine_result"];
  const web = projectCanonicalTranscript(detail);
  const mobile = buildTranscript(detail).reverse();
  const electron = canonicalChatPresentation(detail);

  expect(web.map(message => message.id)).toEqual(expected);
  expect(mobile.map(message => message.id)).toEqual(expected);
  expect(canonicalChatApprovals(detail)[0]).toMatchObject({ pending: false, decision: "approve" });
  expect(web.at(-1)?.routineReceipt).toMatchObject({ status: "completed" });
  expect(mobile.at(-1)?.routineReceipt).toMatchObject({ status: "completed" });
  expect(electron[0]?.work).toContainEqual(expect.objectContaining({ requestId: `rcact_${"a".repeat(32)}`, state: "resolved" }));
  expect(electron[1]?.routineReceipt?.receipt).toMatchObject({ status: "completed" });
});

it("keeps the routine operation ahead of the later scheduled result when its source input is on an older page", () => {
  const detail = routineFixture();
  detail.messages = detail.messages.filter(message => message.id === "msg_intro" || message.id === "msg_routine_result");
  const expected = ["msg_intro", "activity_confirm", "msg_routine_result"];

  expect(projectCanonicalTranscript(detail).map(message => message.id)).toEqual(expected);
  expect(buildTranscript(detail).map(message => message.id).reverse()).toEqual(expected);
});

it("preserves the exact action digest from native and legacy approval records", () => {
  const detail = fixture();
  const actionDigest = "a".repeat(64);
  const native = detail.activities[0]!;
  if (native.type !== "approval.requested") throw new Error("Missing fixture approval");
  native.actionDigest = actionDigest;
  expect(canonicalChatApprovals(detail)[0]).toMatchObject({ actionDigest });
  expect(projectCanonicalTranscript(detail).find(m => m.metadata?.canonicalApproval)?.metadata?.canonicalApproval)
    .toMatchObject({ actionDigest });
  detail.messages.push({ ...detail.messages[0]!, id: "msg_with_legacy_approval", seq: 3,
    role: "assistant", runId: native.runId, parts: [{ type: "approval_request", approvalId: native.approvalId,
      title: "Use integration", description: "List three files", risk: "high", allowedDecisions: ["approve"],
    }] });
  expect(canonicalChatApprovals(detail)[0]).toMatchObject({ actionDigest });
});

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

it("projects the same browser scope across Web, Electron and Native Mobile", () => {
  const detail = fixture(); const activity = detail.activities[0]!;
  if (activity.type !== "approval.requested") throw new Error("Missing request");
  activity.actionDigest = "f".repeat(64);
  activity.browserApproval = { kind: "shared_chrome", leaseEpoch: "178ca19d-9760-4e67-a221-62bedf393b90", challengeRevision: 0, scopeVersion: 1, expiresAt: new Date(Date.now()+60_000).toISOString() };
  const expected = { actionDigest: activity.actionDigest, browserApproval: activity.browserApproval, pending: true };
  expect(projectCanonicalTranscript(detail).find(m => m.metadata?.canonicalApproval)?.metadata?.canonicalApproval).toMatchObject(expected);
  expect(buildTranscript(detail).find(m => m.approval)?.approval).toMatchObject(expected);
  expect(canonicalChatPresentation(detail)[0]?.work.find(item => item.kind === "request")).toMatchObject({ browserApproval: expected });
});
