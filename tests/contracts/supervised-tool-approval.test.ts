import { expect, it } from "vitest";
import { canonicalChatApprovals, type CanonicalChatDetailResponse } from "../../packages/contracts/src/index.js";
import { supervisedToolApproval } from "../../packages/contracts/src/supervised-tool-approval.js";
import { createCanonicalChatFixture } from "./fixtures/canonical-chat.js";

const decisions = ["approve", "approve_for_session", "decline", "cancel"] as const;

it("describes a waiting web search with the four owner choices", () => {
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
    allowInChat: true,
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

it("shows the chat grant, a decline, and an expiry as separate outcomes", () => {
  const base = { title: "Search the web", pending: false, allowedDecisions: decisions };
  expect(supervisedToolApproval({ ...base, decision: "approve_for_session" })).toEqual({
    kind: "allowed", line: "Web search allowed in this chat", undo: true,
  });
  expect(supervisedToolApproval({ ...base, decision: "approve_for_session", reason: "session_revoked" })).toEqual({
    kind: "allowed", line: "Web search allowed in this chat", undo: false,
  });
  expect(supervisedToolApproval({ ...base, decision: "approve_for_session", undoable: false })).toEqual({
    kind: "allowed", line: "Web search allowed in this chat", undo: false,
  });
  expect(supervisedToolApproval({ ...base, decision: "approve" })).toEqual({
    kind: "allowed", line: "Web search allowed", undo: false,
  });
  expect(supervisedToolApproval({ ...base, decision: "decline" })).toEqual({
    kind: "declined", line: "Web search not allowed",
  });
  expect(supervisedToolApproval({ ...base, decision: "cancel", reason: "expired" })).toMatchObject({
    kind: "expired",
    summary: "No answer within 10 minutes, so nothing was searched.",
  });
});

it("offers Undo for a chat grant only while its run is still active", () => {
  for (const state of ["running", "completed"] as const) {
    const { snapshot } = createCanonicalChatFixture(state);
    const run = snapshot.runs[0]!;
    const detail = { ...snapshot, activities: [
      ...snapshot.activities,
      { id: "activity_grant_request", chatId: run.chatId, runId: run.id, occurredAt: run.updatedAt, type: "approval.requested" as const, approvalId: "approval_grant", title: "Search the web", risk: "low" as const, allowedDecisions: [...decisions] },
      { id: "activity_grant_resolved", chatId: run.chatId, runId: run.id, occurredAt: run.updatedAt, type: "approval.resolved" as const, approvalId: "approval_grant", decision: "approve_for_session" as const },
    ] } as CanonicalChatDetailResponse;
    const view = canonicalChatApprovals(detail).find((approval) => approval.approvalId === "approval_grant");
    const card = view ? supervisedToolApproval(view) : null;
    expect(card?.kind === "allowed" && card.undo).toBe(state === "running");
  }
});
