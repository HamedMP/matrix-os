// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { canonicalChatApprovals, type CanonicalChatDetailResponse, type CanonicalChatApprovalDecision } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { canonicalChatPresentation } from "@desktop/renderer/src/features/chat/canonical-chat-presentation";
import { ConversationTranscript } from "@desktop/renderer/src/components/conversation/transcript";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices";
import { buildTranscript } from "../../apps/mobile/lib/canonical-chat-transcript";
import { CanonicalApprovalMessage } from "../../shell/src/components/chat/CanonicalApprovalMessage";

const server = "a1111111-1111-4111-8111-111111111111";
const description = `Server ${server}\nTool microsoft_docs_fetch\nArguments ${JSON.stringify({ url: "https://learn.microsoft.com/azure/functions", token: "fixture-private-token", path: "/home/fixture/private", payload: { text: "fixture-private-payload" } })}`;

function fixture(legacy = false, text = description): CanonicalChatDetailResponse {
  const { snapshot } = createCanonicalChatFixture("approval_required");
  const run = snapshot.runs[0]!;
  const detail = { ...snapshot, activities: [{ id: "approval-activity", chatId: run.chatId, runId: run.id,
    occurredAt: run.updatedAt, type: "approval.requested", approvalId: "approval-fetch", title: "Allow microsoft_docs_fetch?",
    safeDescription: text, risk: "high", allowedDecisions: ["approve", "decline", "cancel"] }] } as CanonicalChatDetailResponse;
  if (legacy) {
    detail.activities = [];
    detail.messages.push({ ...detail.messages[0]!, id: "approval-message", seq: 2, role: "assistant", runId: run.id,
      parts: [{ type: "approval_request", approvalId: "approval-fetch", title: "Allow microsoft_docs_fetch?", description: text,
        risk: "high", allowedDecisions: ["approve", "decline", "cancel"] }] });
  }
  return detail;
}

function resolve(detail: CanonicalChatDetailResponse, decision: CanonicalChatApprovalDecision, legacy = false) {
  const run = detail.runs[0]!;
  if (legacy) detail.messages.push({ ...detail.messages[0]!, id: "decision-message", seq: 3, role: "assistant", runId: run.id,
    parts: [{ type: "approval_result", approvalId: "approval-fetch", decision }] });
  else detail.activities.push({ id: "decision-activity", chatId: run.chatId, runId: run.id,
    occurredAt: run.updatedAt, type: "approval.resolved", approvalId: "approval-fetch", decision });
}

beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([false, true])("shows a bounded private-value-free Custom MCP summary (legacy=%s)", legacy => {
  const detail = fixture(legacy);
  const summary = canonicalChatApprovals(detail)[0]!.description;
  expect(summary).toContain(`Server ${server}`);
  expect(summary).toContain("Tool microsoft_docs_fetch");
  expect(summary).toContain("url: string (value withheld)");
  for (const privateValue of ["fixture-private-token", "/home/fixture/private", "fixture-private-payload", "learn.microsoft.com"]) {
    expect(summary).not.toContain(privateValue);
  }
  expect(summary.length).toBeLessThanOrEqual(1200);
  const request = canonicalChatPresentation(detail)[0]!.work.find(item => item.kind === "request");
  expect(request).toMatchObject({ detail: summary });
  expect(projectCanonicalTranscript(detail).find(m => m.metadata?.canonicalApproval)?.metadata?.canonicalApproval).toMatchObject({ description: summary });
  expect(buildTranscript(detail).find(m => m.approval)?.approval).toMatchObject({ description: summary });
});

it.each(["Server not-a-uuid\nTool fetch\nArguments {}", `Server ${server}\nTool fetch\nArguments {broken`,
  `Server ${server}\nTool fetch\nArguments ${JSON.stringify({ url: "x".repeat(5000) })}`])("fails closed for malformed or oversized Custom MCP descriptions", text => {
  expect(canonicalChatApprovals(fixture(false, text))[0]!.description).toBe("Details withheld for privacy.");
});

it("does not expose arbitrary argument names or nested values", () => {
  const text = `Server ${server}\nTool fetch\nArguments ${JSON.stringify({ "fixture-secret-field": "fixture-secret-value", url: { nested: "fixture-secret-nested" } })}`;
  const summary = canonicalChatApprovals(fixture(false, text))[0]!.description;
  expect(summary).not.toContain("fixture-secret");
  expect(summary).toContain("url: object (value withheld)");
});

it.each([`Server ${server}\nTool fetch\nBearer fixture-injected-token\nArguments {}`,
  `Server ${server}\nTool fetch\nArguments []`, `Server ${server}\nTool fetch\nArguments null`])("rejects an injected or non-object Custom MCP envelope", text => {
  expect(canonicalChatApprovals(fixture(false, text))[0]!.description).toBe("Details withheld for privacy.");
});

it.each([false, true])("does not echo an invalid Custom MCP tool in its title (legacy=%s)", legacy => {
  const detail = fixture(legacy, `Server ${server}\nTool fetch\nBearer fixture-injected-token\nArguments {}`);
  const rawTitle = "Allow fetch Bearer fixture-injected-token?";
  if (legacy) {
    const part = detail.messages.at(-1)!.parts[0]!;
    if (part.type === "approval_request") part.title = rawTitle;
  } else {
    const activity = detail.activities[0]!;
    if (activity.type === "approval.requested") activity.title = rawTitle;
  }
  expect(canonicalChatApprovals(detail)[0]!.title).toBe("Review Custom MCP request");
  expect(canonicalChatPresentation(detail)[0]!.work.find(item => item.kind === "request")).toMatchObject({ label: "Review Custom MCP request" });
});

it.each([`Server ${server}\nTool fetch`, `Server ${server}\nTool fetch\nArgument`,
  `Server ${server}\nTool fetch\nArguments`].flatMap(text => [false, true].map(legacy => ({ text, legacy }))))("withholds a recognizable truncated Custom MCP envelope (legacy=$legacy)", ({ text, legacy }) => {
  expect(canonicalChatApprovals(fixture(legacy, text))[0]).toMatchObject({ title: "Review Custom MCP request", description: "Details withheld for privacy." });
});

it("preserves unrelated legacy server/tool prose without the Custom MCP identity format", () => {
  const text = "Server restart command\nTool bun run test\nReview patch before continuing.";
  expect(canonicalChatApprovals(fixture(true, text))[0]!.description).toBe(text);
});

it("renders native details in the actual Electron transcript projection", () => {
  render(<ConversationTranscript turns={canonicalChatPresentation(fixture())} callbacks={{ copyText: vi.fn() }} />);
  expect(screen.getByText(new RegExp(`Server ${server}`))).toBeTruthy();
  expect(screen.getByText(/url: string \(value withheld\)/)).toBeTruthy();
});

it.each([false, true])("preserves unrelated normal approval review text (legacy=%s)", legacy => {
  const text = "Run the focused suite again. Command: bun run test. Patch: + add test.";
  const detail = fixture(legacy, text);
  expect(canonicalChatApprovals(detail)[0]!.description).toBe(text);
  expect(canonicalChatPresentation(detail)[0]!.work.find(item => item.kind === "request")).toMatchObject({ detail: text });
});

it.each((["approve", "approve_for_session", "decline", "cancel"] as const).flatMap(decision => [false, true].map(legacy => ({ decision, legacy }))))("projects actual $decision across shared surfaces (legacy=$legacy)", ({ decision, legacy }) => {
    const detail = fixture(legacy);
    resolve(detail, decision, legacy);
    expect(canonicalChatApprovals(detail)[0]).toMatchObject({ decision, pending: false });
    expect(projectCanonicalTranscript(detail).find(m => m.metadata?.canonicalApproval)?.metadata?.canonicalApproval).toMatchObject({ decision });
    expect(buildTranscript(detail).find(m => m.approval)?.approval).toMatchObject({ decision });
    expect(canonicalChatPresentation(detail)[0]!.work.find(item => item.kind === "request")).toMatchObject({ decision, state: "resolved", actions: undefined });
});

it.each([["approve", "Approved"], ["approve_for_session", "Approved"], ["decline", "Declined"], ["cancel", "Cancelled"]] as const)("renders explicit %s outcome", (decision, label) => {
  const detail = fixture();
  resolve(detail, decision);
  render(<ConversationTranscript turns={canonicalChatPresentation(detail)} callbacks={{ copyText: vi.fn() }} />);
  expect(screen.getByText(label)).toBeTruthy();
  if (decision === "decline" || decision === "cancel") expect(screen.getByRole("group", { name: /Approval resolved:/ }).querySelector('svg[style*="var(--success)"]')).toBeNull();
});

it.each([["approve", "Approved"], ["approve_for_session", "Approved"], ["decline", "Declined"], ["cancel", "Cancelled"]] as const)("renders the same %s outcome in the shared Web approval component", (decision, label) => {
  const detail = fixture(true);
  resolve(detail, decision, true);
  const message = projectCanonicalTranscript(detail).find(m => m.metadata?.canonicalApproval)!;
  render(<CanonicalApprovalMessage message={message} submitting={false} />);
  expect(screen.getByText(label)).toBeTruthy();
});

it.each(["completed", "failed", "aborted"] as const)("keeps %s without a recorded decision neutral", status => {
  const detail = fixture();
  detail.runs[0]!.status = status;
  render(<ConversationTranscript turns={canonicalChatPresentation(detail).map(turn => ({ ...turn, expandedByDefault: true }))} callbacks={{ copyText: vi.fn() }} />);
  expect(screen.getByText("Approval ended without a recorded decision")).toBeTruthy();
  expect(screen.getByRole("group", { name: /Approval resolved:/ }).querySelector('svg[style*="var(--success)"]')).toBeNull();
});

it("does not borrow an identical approval ID's decision from another run", () => {
  const detail = fixture();
  detail.activities.push({ id: "old-decision", chatId: detail.chat.id, runId: "run_other", occurredAt: detail.runs[0]!.updatedAt,
    type: "approval.resolved", approvalId: "approval-fetch", decision: "approve" });
  expect(canonicalChatApprovals(detail)[0]).toMatchObject({ pending: true });
  expect(canonicalChatApprovals(detail)[0]).not.toHaveProperty("decision");
});
