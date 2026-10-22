import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { AgentThreadEventSchema, AgentThreadSummarySchema, type AgentThreadEvent } from "@matrix-os/contracts";
import { isFailedCodexBootstrap } from "../../packages/gateway/src/coding-agents/codex-failed-bootstrap.js";
import type { StoredTurn } from "../../packages/gateway/src/coding-agents/thread-store.js";

type Proof = Omit<Parameters<typeof isFailedCodexBootstrap>[0], "events" | "turns"> & {
  events: AgentThreadEvent[];
  turns: StoredTurn[];
};
const occurredAt = "2026-10-16T08:18:51.000Z";
const retryAt = "2026-10-16T08:22:06.000Z";

function fixture(): Proof {
  const summary = AgentThreadSummarySchema.parse({ id: "thread_failed_bootstrap", providerId: "codex", title: "Chat",
    status: "failed", attention: "failed", createdAt: occurredAt, updatedAt: occurredAt });
  const thread = {
    ...summary,
    ownerId: "owner_bootstrap", clientRequestId: "req_initial_bootstrap", abortClientRequestIds: [],
    approvalDecisionClientRequestIds: [], inputAnswerClientRequestIds: [], providerEventOffset: 23,
    providerResumeState: { conversationId: "sess_failed_bootstrap", backgroundRef: { id: `bg_${"a".repeat(32)}` } },
  };
  const event = (value: Record<string, unknown>) => AgentThreadEventSchema.parse({
    ...value, threadId: thread.id, occurredAt,
  });
  const nativeId = (index: number) => `evt_codex_${createHash("sha256")
    .update(`sess_failed_bootstrap:0:${index}`).digest("hex").slice(0, 32)}`;
  return { ownerId: thread.ownerId, thread, turns: [], events: [
    event({ type: "thread.created", eventId: "evt_created", thread: { ...summary, status: "queued", attention: "none" } }),
    event({ type: "user.message", eventId: "evt_initial", messageId: "msg_initial", text: "Initial prompt.",
      clientRequestId: thread.clientRequestId }),
    event({ type: "thread.status", eventId: "evt_running", status: "running" }),
    event({ type: "thread.error", eventId: nativeId(0), error: { code: "provider_failed", safeMessage: "Failed.",
      retryable: true, recoveryActions: ["retry"] } }),
    event({ type: "thread.completed", eventId: nativeId(1), outcome: "failed" }),
  ] };
}

function withFailedRetry(proof: Proof): Proof {
  const turn = { ownerId: proof.ownerId, threadId: proof.thread.id, turnId: "turn_old_retry",
    clientRequestId: "req_old_retry", status: "failed" as const, acceptedAt: retryAt, updatedAt: retryAt };
  const event = (value: Record<string, unknown>) => AgentThreadEventSchema.parse({
    ...value, threadId: proof.thread.id, occurredAt: retryAt,
  });
  return { ...proof, turns: [turn], events: [...proof.events,
    event({ type: "turn.accepted", eventId: "evt_accepted", turnId: turn.turnId,
      clientRequestId: turn.clientRequestId, acceptedAt: retryAt }),
    event({ type: "user.message", eventId: "evt_retry_message", messageId: "msg_retry", text: "Retry.",
      turnId: turn.turnId, clientRequestId: turn.clientRequestId }),
    event({ type: "turn.status", eventId: "evt_retry_running", turnId: turn.turnId, status: "running" }),
    event({ type: "turn.status", eventId: "evt_retry_failed", turnId: turn.turnId, status: "failed" }),
    event({ type: "thread.error", eventId: "evt_retry_error", error: { code: "provider_run_failed",
      safeMessage: "Retry failed.", retryable: true, recoveryActions: ["retry"] } }),
    event({ type: "thread.completed", eventId: "evt_retry_completed", outcome: "failed" }),
  ] };
}

it("recognizes the exact checkpoint before any native execution", () => {
  expect(isFailedCodexBootstrap(fixture())).toBe(true);
});

it.each([false, true])("recognizes a fully failed non-delivered retry (running event=%s)", (withRunning) => {
  const proof = withFailedRetry(fixture());
  if (!withRunning) proof.events = proof.events.filter(event => event.eventId !== "evt_retry_running");
  expect(isFailedCodexBootstrap(proof)).toBe(true);
});

it.each([
  ["foreign owner", (proof: Proof) => { proof.ownerId = "owner_other"; }],
  ["other harness", (proof: Proof) => { proof.thread.providerId = "claude"; }],
  ["native identity", (proof: Proof) => { proof.thread.providerResumeState!.providerThreadId = "native_existing"; }],
  ["wrong session", (proof: Proof) => { proof.thread.providerResumeState!.conversationId = "sess_other"; }],
  ["missing process metadata", (proof: Proof) => { delete proof.thread.providerResumeState; }],
  ["missing incarnation", (proof: Proof) => { delete proof.thread.providerResumeState!.backgroundRef; }],
  ["active turn", (proof: Proof) => { proof.thread.activeTurnId = "turn_active"; }],
  ["delivered turn", (proof: Proof) => { proof.thread.deliveredTurnId = "turn_delivered"; }],
  ["terminal binding", (proof: Proof) => { proof.thread.terminalRef = { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"a".repeat(32)}` }; }],
  ["missing cursor", (proof: Proof) => { delete proof.thread.providerEventOffset; }],
  ["unread cursor", (proof: Proof) => { proof.thread.providerEventOffset = 0; }],
  ["partial cursor", (proof: Proof) => { proof.thread.providerEventOffset = 22; }],
  ["later cursor", (proof: Proof) => { proof.thread.providerEventOffset = 24; }],
  ["trimmed creation", (proof: Proof) => { proof.events = proof.events.slice(1); }],
  ["trimmed initial message", (proof: Proof) => { proof.events = proof.events.filter(event => event.eventId !== "evt_initial"); }],
  ["trimmed native terminal", (proof: Proof) => { proof.events = proof.events.slice(0, -1); }],
  ["wrong native error ID", (proof: Proof) => { proof.events[3] = { ...proof.events[3]!, eventId: "evt_wrong" }; }],
  ["wrong native completion ID", (proof: Proof) => { proof.events[4] = { ...proof.events[4]!, eventId: "evt_wrong" }; }],
  ["reordered terminal", (proof: Proof) => { proof.events = [...proof.events.slice(0, 3), proof.events[4]!, proof.events[3]!]; }],
  ["wrong original request", (proof: Proof) => { proof.thread.clientRequestId = "req_other"; }],
  ["different initial outcome", (proof: Proof) => { proof.events[4] = { ...proof.events[4]!, type: "thread.completed", outcome: "aborted" }; }],
  ["terminal failure without native provenance", (proof: Proof) => { proof.events[3] = { ...proof.events[3]!, type: "thread.error", error: { code: "provider_run_failed", safeMessage: "Failed.", retryable: true, recoveryActions: ["retry"] } }; }],
] as const)("fails closed on %s", (_name, mutate) => {
  const proof = fixture();
  mutate(proof);
  expect(isFailedCodexBootstrap(proof)).toBe(false);
});

it.each(["queued", "starting", "running", "completed", "aborted", "stale", "archived"] as const)(
  "does not replace a thread whose current status is %s", (status) => {
    const proof = fixture(); proof.thread.status = status;
    expect(isFailedCodexBootstrap(proof)).toBe(false);
  },
);

it.each([
  { type: "assistant.text.delta", messageId: "msg_activity", delta: "Started work." },
  { type: "tool.started", toolCallId: "tool_started", displayName: "Browser", kind: "mcp_tool" },
  { type: "approval.requested", approval: { approvalId: "appr_started", threadId: "thread_failed_bootstrap",
    title: "Approve?", risk: "low", safeDescription: "Pending permission.", actionKind: "network",
    allowedDecisions: ["approve", "decline"], correlationId: "corr_started" } },
] as const)("fails closed on activity: $type", (activity) => {
  const proof = fixture();
  const event = AgentThreadEventSchema.parse({ ...activity, eventId: "evt_activity",
    threadId: proof.thread.id, occurredAt });
  for (const position of [2, 5]) {
    const events = [...proof.events]; events.splice(position, 0, event);
    expect(isFailedCodexBootstrap({ ...proof, events })).toBe(false);
  }
});

it.each([
  ["foreign retry owner", (proof: Proof) => { proof.turns = [{ ...proof.turns[0]!, ownerId: "owner_other" }]; }],
  ["uncertain/completed delivery", (proof: Proof) => { proof.turns = [{ ...proof.turns[0]!, status: "completed" }]; }],
  ["active retry", (proof: Proof) => { proof.turns = [{ ...proof.turns[0]!, status: "running", message: "Still active." }]; }],
  ["missing retry record", (proof: Proof) => { proof.turns = []; }],
  ["extra retry record", (proof: Proof) => { proof.turns = [...proof.turns, { ...proof.turns[0]!, turnId: "turn_unknown" }]; }],
  ["missing accepted event", (proof: Proof) => { proof.events = proof.events.filter(event => event.type !== "turn.accepted"); }],
  ["missing retry message", (proof: Proof) => { proof.events = proof.events.filter(event => event.eventId !== "evt_retry_message"); }],
  ["missing retry terminal", (proof: Proof) => { proof.events = proof.events.slice(0, -1); }],
  ["retry marked delivered", (proof: Proof) => { proof.events = proof.events.map(event => event.eventId === "evt_retry_failed" ? { ...event, type: "turn.status", turnId: "turn_old_retry", status: "completed" } : event); }],
  ["retry reordered before native failure", (proof: Proof) => { proof.events = [...proof.events.slice(0, 3), ...proof.events.slice(5), ...proof.events.slice(3, 5)]; }],
  ["retry request mismatch", (proof: Proof) => { proof.turns = [{ ...proof.turns[0]!, clientRequestId: "req_other" }]; }],
  ["retry acceptance mismatch", (proof: Proof) => { proof.turns = [{ ...proof.turns[0]!, acceptedAt: occurredAt }]; }],
] as const)("fails closed on %s", (_name, mutate) => {
  const proof = withFailedRetry(fixture());
  mutate(proof);
  expect(isFailedCodexBootstrap(proof)).toBe(false);
});
