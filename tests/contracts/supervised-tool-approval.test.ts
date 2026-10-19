import { expect, it } from "vitest";
import { canonicalChatApprovals, type CanonicalChatDetailResponse } from "../../packages/contracts/src/index.js";
import { supervisedToolApproval, supervisedToolRetryPrompt } from "../../packages/contracts/src/supervised-tool-approval.js";
import { createCanonicalChatFixture } from "./fixtures/canonical-chat.js";

const decisions = ["approve", "decline", "cancel"] as const;

it("describes a waiting web search with the one-time owner choices", () => {
  expect(supervisedToolApproval({
    title: "Search the web · “AI agent pricing”",
    description: "Matrix wants to search the web and read a few pages to write your brief. Nothing is sent or changed.\n\n{\"query\":\"AI agent pricing\"}",
    pending: true,
    allowedDecisions: decisions,
  })).toEqual({
    kind: "waiting",
    title: "Search the web · “AI agent pricing”",
    summary: "Matrix wants to search the web and read a few pages to write your brief. Nothing is sent or changed.",
    details: "{\"query\":\"AI agent pricing\"}",
    bar: "Search the web",
    allowOnce: true,
    decline: true,
  });
});

it.each([
  "Use integration",
  "Run command",
  "Change files",
  "Change permissions",
  "Command approval required",
  "Allow this connected service action?",
  "Allow microsoft_docs_fetch?",
])("keeps the %s approval from another agent or integration on the generic card", (title) => {
  expect(supervisedToolApproval({
    title, description: "The agent is waiting for your decision.", pending: true, allowedDecisions: ["approve", "decline"],
  })).toBeNull();
});

it("shows an approval, a decline, and an expiry as separate outcomes", () => {
  const base = { title: "Search the web", pending: false, allowedDecisions: decisions };
  expect(supervisedToolApproval({ ...base, decision: "approve" })).toEqual({
    kind: "allowed", line: "Web search allowed",
  });
  expect(supervisedToolApproval({ ...base, decision: "decline" })).toEqual({
    kind: "declined", line: "Web search not allowed",
  });
  expect(supervisedToolApproval({ ...base, decision: "cancel", reason: "expired" })).toMatchObject({
    kind: "expired",
    summary: "No answer within 10 minutes, so nothing was searched.",
  });
});

it("carries an expiry from the run activity onto the card", () => {
  const { snapshot } = createCanonicalChatFixture("running");
  const run = snapshot.runs[0]!;
  const detail = { ...snapshot, activities: [
    ...snapshot.activities,
    { id: "activity_tool_request", chatId: run.chatId, runId: run.id, occurredAt: run.updatedAt, type: "approval.requested" as const, approvalId: "approval_tool", title: "Search the web", risk: "low" as const, allowedDecisions: [...decisions] },
    { id: "activity_tool_resolved", chatId: run.chatId, runId: run.id, occurredAt: run.updatedAt, type: "approval.resolved" as const, approvalId: "approval_tool", decision: "cancel" as const, reason: "expired" as const },
  ] } as CanonicalChatDetailResponse;
  const view = canonicalChatApprovals(detail).find((approval) => approval.approvalId === "approval_tool");
  expect(view ? supervisedToolApproval(view)?.kind : null).toBe("expired");
});

it("words the retry prompt from the expired request", () => {
  expect(supervisedToolRetryPrompt("Search the web · “AI agent pricing”")).toBe("Try again: Search the web · “AI agent pricing”");
});
