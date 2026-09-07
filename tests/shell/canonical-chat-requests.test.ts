import { expect, it } from "vitest";
import { projectCanonicalRequests } from "../../shell/src/lib/canonical-chat-requests";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

it("projects a run-activity approval even when no saved message contains it", () => {
  const { snapshot } = createCanonicalChatFixture("accepted");
  const run = snapshot.runs[0]!;
  const event = { id: "activity_approval", chatId: run.chatId, runId: run.id, occurredAt: run.createdAt,
    type: "approval.requested" as const, approvalId: "appr_command", title: "Run command", description: "Fetch the project changes.", risk: "medium" as const, allowedDecisions: ["approve" as const, "cancel" as const] };
  const messages = projectCanonicalRequests([event], snapshot.runs);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.metadata?.canonicalApproval).toMatchObject({ runId: run.id, approvalId: "appr_command", pending: true, description: event.description });
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

it("retains unstructured input notices and bounds request projection locally", () => {
  const { snapshot } = createCanonicalChatFixture("accepted");
  const run = snapshot.runs[0]!;
  const event = { id: "unstructured", chatId: run.chatId, runId: run.id, occurredAt: run.createdAt,
    type: "input.requested" as const, requestId: "req_unstructured", title: "Clarification needed" };
  expect(projectCanonicalRequests([event], snapshot.runs)[0]?.metadata?.canonicalInput).toMatchObject({ requestId: "req_unstructured", title: "Clarification needed", pending: true });
  const messages = Array.from({ length: 1001 }, (_, i) => ({ id: `message_${i}`, role: "system" as const, content: "Approval", timestamp: i,
    metadata: { canonicalApproval: { runId: run.id, approvalId: `appr_${i}`, pending: true } } }));
  const projected = projectCanonicalRequests([], snapshot.runs, messages);
  expect(projected).toHaveLength(500);
  expect(projected.at(-1)?.id).toBe("message_1000");
});
