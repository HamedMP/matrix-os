import { expect, it, vi } from "vitest";
import { AgentThreadEventSchema, AgentThreadSnapshotSchema, type AgentThreadEvent } from "@matrix-os/contracts";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import type { CodingAgentThreadStore, CodingAgentTurnStore } from "../../packages/gateway/src/coding-agents/thread-store.js";

const time = "2026-10-01T00:00:00.000Z";
const preview = { body: "Command:\npnpm build\nWorking directory: apps/demo", truncated: false };
function events(): AgentThreadEvent[] {
  return [{ type: "approval.requested", eventId: "evt_request", approval: { approvalId: "appr_review", threadId: "thread_review",
    title: "Run command", safeDescription: "The coding agent wants to run a command.", risk: "medium", actionKind: "command",
    preview, allowedDecisions: ["approve", "decline"], correlationId: "corr_review" } },
  { type: "thread.completed", eventId: "evt_completed", outcome: "completed" }].map(value =>
    AgentThreadEventSchema.parse({ ...value, threadId: "thread_review", occurredAt: time }));
}
function snapshot() {
  return AgentThreadSnapshotSchema.parse({ thread: { id: "thread_review", providerId: "codex", title: "Review", status: "completed",
    attention: "none", createdAt: time, updatedAt: time }, events: { items: events(), limit: 200, hasMore: false } });
}
function adapter() {
  const threads = { createThread: vi.fn(async () => ({ snapshot: snapshot(), existing: false })),
    getThread: vi.fn(async () => snapshot()), registerEventSink: vi.fn(() => ({ dispose: vi.fn() })) } as unknown as CodingAgentThreadStore & CodingAgentTurnStore;
  return createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads });
}
it("retains approval evidence through live canonical provider projection", async () => {
  const received = [];
  for await (const event of adapter().start({ owner: { type: "personal", ownerId: "owner_review" }, chatId: "chat_review",
    turnId: "cturn_review", runId: "run_review", prompt: "Build app", parts: [{ type: "text", text: "Build app" }],
    selection: { instanceId: "codex_default", model: "gpt-5.6-sol" }, interactionMode: "default", permissionMode: "supervised",
    signal: new AbortController().signal })) received.push(event);
  expect(received).toContainEqual({ type: "approval.requested", approvalId: "appr_review", title: "Run command", risk: "medium",
    safeDescription: "The coding agent wants to run a command.", preview, allowedDecisions: ["approve", "decline"] });
});
it("retains approval evidence when the gateway recovers the same native run", async () => {
  const provider = adapter();
  const recovered = await provider.recover!({ owner: { type: "personal", ownerId: "owner_review" }, runId: "run_review",
    state: provider.parseState({ conversationId: "thread_review", runId: "run_review", replayAfter: "evt_boundary" }), signal: new AbortController().signal });
  expect(recovered?.activities).toContainEqual({ type: "approval.requested", approvalId: "appr_review", title: "Run command",
    risk: "medium", safeDescription: "The coding agent wants to run a command.", preview, allowedDecisions: ["approve", "decline"] });
});
