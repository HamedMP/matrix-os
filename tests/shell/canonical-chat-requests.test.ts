import { expect, it } from "vitest";
import { projectCanonicalRequests } from "../../shell/src/lib/canonical-chat-requests";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

it("projects a run-activity approval even when no saved message contains it", () => {
  const { snapshot } = createCanonicalChatFixture("accepted");
  const run = snapshot.runs[0]!;
  const event = { id: "activity_approval", chatId: run.chatId, runId: run.id, occurredAt: run.createdAt,
    type: "approval.requested" as const, approvalId: "appr_command", title: "Run command", risk: "medium" as const, allowedDecisions: ["approve" as const, "cancel" as const] };
  const messages = projectCanonicalRequests([event], snapshot.runs);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.metadata?.canonicalApproval).toMatchObject({ runId: run.id, approvalId: "appr_command", pending: true });
  expect(projectCanonicalRequests([event, { id: "activity_resolved", chatId: run.chatId, runId: run.id, occurredAt: run.createdAt, type: "approval.resolved", approvalId: "appr_command", decision: "cancel" }], snapshot.runs)[0]?.metadata?.canonicalApproval).toMatchObject({ pending: false });
});

it("reconciles saved approvals with activities without duplicate or stale controls", () => {
  const { snapshot } = createCanonicalChatFixture("accepted");
  const run = snapshot.runs[0]!;
  const message = { id: "saved", role: "system" as const, content: "Command details", timestamp: 1,
    metadata: { canonicalApproval: { runId: run.id, approvalId: "appr_command", title: "Run", description: "git fetch origin", pending: true } } };
  const event = { id: "requested", chatId: run.chatId, runId: run.id, occurredAt: run.createdAt,
    type: "approval.requested" as const, approvalId: "appr_command", title: "Run", risk: "medium" as const, allowedDecisions: ["approve" as const] };
  expect(projectCanonicalRequests([event], snapshot.runs, [message])).toHaveLength(1);
  const resolved = { id: "resolved", chatId: run.chatId, runId: run.id, occurredAt: run.createdAt,
    type: "approval.resolved" as const, approvalId: "appr_command", decision: "cancel" as const };
  expect(projectCanonicalRequests([resolved], snapshot.runs, [message])[0]?.metadata?.canonicalApproval).toMatchObject({ pending: false, description: "git fetch origin" });
  expect(projectCanonicalRequests([], [{ ...run, status: "completed" }], [message])[0]?.metadata?.canonicalApproval).toMatchObject({ pending: false });
});
