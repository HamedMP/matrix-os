import { KyselyPGlite } from "kysely-pglite";
import { expect, it } from "vitest";
import {
  AgentThreadSnapshotSchema, CanonicalChatRunActivitySchema, canonicalChatApprovals,
  type AgentThreadEvent, type CanonicalChatApprovalDecision, type CanonicalChatDetailResponse,
} from "@matrix-os/contracts";
import { parseCodexExecJsonLine } from "../../packages/gateway/src/coding-agents/codex-events.js";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import type { CodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import type { CanonicalProviderRunEvent } from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";
import { canonicalChatPresentation } from "@desktop/renderer/src/features/chat/canonical-chat-presentation";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices.js";
import { buildTranscript } from "../../apps/mobile/lib/canonical-chat-transcript.js";

const occurredAt = "2026-10-15T00:00:00.000Z";
const explanation = "Allow Matrix to describe the available Gmail actions before continuing?";
const nativeRequest = (safeDescription = explanation) => ({
  type: "matrix.codex.approval.requested", approvalId: "appr_native_description",
  correlationId: "corr_native_description", title: "Use integration", safeDescription,
  actionKind: "provider", risk: "high", allowedDecisions: ["approve", "decline", "cancel"],
});
function nativeEvents(record: unknown): AgentThreadEvent[] {
  return parseCodexExecJsonLine(JSON.stringify(record), {
    threadId: "thread_native_description", now: () => new Date(occurredAt), nextEventId: () => "evt_native_description",
  }).events;
}

// Only the transport is synthetic: native parsing, canonical normalization,
// repository writes/reads and every surface projection below are production code.
function transport(initial: AgentThreadEvent[]) {
  let sink: Parameters<CodingAgentThreadStore["registerEventSink"]>[0] | undefined;
  const snapshot = () => AgentThreadSnapshotSchema.parse({
    thread: { id: "thread_native_description", providerId: "codex", title: "Approval QA",
      status: "running", attention: "none", createdAt: occurredAt, updatedAt: occurredAt },
    events: { items: initial, hasMore: false, limit: 200 },
  });
  return {
    threads: {
      createThread: async () => ({ snapshot: snapshot(), existing: false }),
      getThread: async () => snapshot(),
      abortThread: async () => snapshot(),
      registerEventSink: (value: typeof sink) => { sink = value; return { dispose() {} }; },
    } as unknown as CodingAgentThreadStore,
    publish(events: AgentThreadEvent[]) { sink?.({ ownerId: "user_fixture", threadId: "thread_native_description", events }); },
  };
}

async function database() {
  const pglite = await KyselyPGlite.create();
  const repository = new ChatRepository(pglite.dialect);
  await repository.bootstrap();
  const { snapshot } = createCanonicalChatFixture("accepted");
  const owner = snapshot.chat.ownerScope;
  const created = await repository.create(owner, { id: snapshot.chat.id, clientRequestId: "req_description", title: "Approval QA" });
  const run = snapshot.runs[0]!;
  await repository.admitTurn(owner, { chatId: snapshot.chat.id, baseRevision: created.chat.revision,
    message: snapshot.messages[0]!, turn: snapshot.turns[0]!, run });
  await repository.markRunRunning(owner, { chatId: snapshot.chat.id, runId: run.id, startedAt: occurredAt });
  return { repository, snapshot, owner, run };
}

function surfaceDetails(detail: CanonicalChatDetailResponse) {
  return [
    canonicalChatApprovals(detail)[0]?.description,
    canonicalChatPresentation(detail)[0]?.work.find(item => item.kind === "request")?.detail,
    projectCanonicalTranscript(detail).find(message => message.metadata?.canonicalApproval)?.metadata?.canonicalApproval?.description,
    buildTranscript(detail).find(message => message.approval)?.approval?.description,
  ];
}

it.each([false, true].flatMap(live => (["approve", "decline", "cancel"] as const).map(decision => ({ live, decision }))))(
  "retains native review detail before and after $decision through persistence (live=$live)", async ({ live, decision }) => {
    const db = await database();
    const requested = nativeEvents(nativeRequest());
    expect(requested).toHaveLength(1);
    const source = transport(live ? [] : requested);
    const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: source.threads });
    const stream = adapter.start({ owner: db.owner, chatId: db.run.chatId, turnId: db.run.turnId, runId: db.run.id,
      prompt: "Synthetic approval QA", parts: [{ type: "text", text: "Synthetic approval QA" }],
      selection: db.run.selection, interactionMode: "default", permissionMode: "supervised", signal: AbortSignal.timeout(10_000) });
    let activityIndex = 0;
    const persist = async (event: CanonicalProviderRunEvent) => {
      if (event.type !== "approval.requested" && event.type !== "approval.resolved") throw new Error("Expected approval event");
      await db.repository.appendRunActivities(db.owner, db.run.chatId, db.run.id, [CanonicalChatRunActivitySchema.parse({
        ...event, id: `activity_description_${++activityIndex}`, chatId: db.run.chatId, runId: db.run.id, occurredAt,
      })]);
    };
    const read = async () => {
      const page = await db.repository.getDetailPage(db.owner, db.run.chatId, { limit: 200 });
      if (!page) throw new Error("Missing persisted Chat");
      return { ...db.snapshot, ...page, chat: db.snapshot.chat } as CanonicalChatDetailResponse;
    };
    try {
      expect((await stream.next()).value).toMatchObject({ type: "state.updated" });
      if (live) source.publish(requested);
      await persist((await stream.next()).value);
      const pending = await read();
      expect(canonicalChatApprovals(pending)[0]).toMatchObject({ pending: true, risk: "high",
        runId: db.run.id, approvalId: "appr_native_description", allowedDecisions: ["approve", "decline", "cancel"] });
      expect(canonicalChatApprovals(pending)[0]).not.toHaveProperty("decision");
      expect(surfaceDetails(pending)).toEqual(Array(4).fill(explanation));

      source.publish([{
        type: "approval.resolved", eventId: "evt_native_resolved", threadId: "thread_native_description",
        occurredAt, approvalId: "appr_native_description", decision,
      }]);
      await persist((await stream.next()).value);
      const resolved = await read();
      expect(canonicalChatApprovals(resolved)[0]).toMatchObject({ pending: false, decision });
      expect(surfaceDetails(resolved)).toEqual(Array(4).fill(explanation));
      expect(canonicalChatPresentation(resolved)[0]?.work.find(item => item.kind === "request"))
        .toMatchObject({ state: "resolved", decision, actions: undefined });
      // Reopening reads the durable activities again rather than retaining the live object.
      expect(surfaceDetails(await read())).toEqual(Array(4).fill(explanation));
    } finally {
      await stream.return(undefined);
      await db.repository.kysely.destroy();
    }
  },
);

it("accepts the existing 600-character native approval description limit", () => {
  const description = "Review this synthetic integration action. ".repeat(20).slice(0, 600);
  const [event] = nativeEvents(nativeRequest(description));
  expect(event).toMatchObject({ type: "approval.requested", approval: { safeDescription: description } });
});

it.each(["x".repeat(601), "/home/private/mail", "Bearer private-value", "sk-private-value", "   "])(
  "continues rejecting unsafe or oversized native descriptions", text => {
    expect(nativeEvents(nativeRequest(text))).toEqual([]);
  },
);

it.each([undefined, "cancel"] as const)("retains native detail during read recovery (decision=%s)", async decision => {
  const db = await database();
  const description = "Review this synthetic integration action. ".repeat(20).slice(0, 600);
  const events = nativeEvents(nativeRequest(description));
  if (decision) events.push({
    type: "approval.resolved", eventId: "evt_native_resolved", threadId: "thread_native_description",
    occurredAt, approvalId: "appr_native_description", decision,
  }, {
    type: "thread.completed", eventId: "evt_native_completed", threadId: "thread_native_description",
    occurredAt, outcome: "completed",
  });
  const source = transport(events);
  const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads: source.threads });
  try {
    const recovered = await adapter.recover!({ owner: db.owner, runId: db.run.id,
      state: { conversationId: "thread_native_description", runId: db.run.id, replayAfter: "evt_native_boundary" },
      signal: AbortSignal.timeout(10_000) });
    expect(recovered?.outcome).toBe(decision ? "completed" : "pending");
    expect(recovered?.activities?.[0]).toMatchObject({ safeDescription: description,
      allowedDecisions: ["approve", "decline", "cancel"], risk: "high" });
    const activities = recovered!.activities!.map((activity, index) => CanonicalChatRunActivitySchema.parse({
      ...activity, id: `activity_recovery_${index}`, chatId: db.run.chatId, runId: db.run.id, occurredAt,
    }));
    await db.repository.appendRunActivities(db.owner, db.run.chatId, db.run.id, activities);
    const page = await db.repository.getDetailPage(db.owner, db.run.chatId, { limit: 200 });
    if (!page) throw new Error("Missing recovered Chat");
    const detail = { ...db.snapshot, ...page, chat: db.snapshot.chat } as CanonicalChatDetailResponse;
    expect(surfaceDetails(detail)).toEqual(Array(4).fill(description));
    expect(canonicalChatApprovals(detail)[0]).toMatchObject({ pending: !decision });
    expect(canonicalChatApprovals(detail)[0]?.decision).toBe(decision);
  } finally {
    await db.repository.kysely.destroy();
  }
});

it.each([undefined, "approve", "decline", "cancel"] as const)("keeps absent-description history neutral for decision=%s", decision => {
  const { snapshot } = createCanonicalChatFixture("approval_required");
  const run = snapshot.runs[0]!;
  const detail = { ...snapshot, activities: [{ id: "activity_missing", chatId: run.chatId, runId: run.id, occurredAt,
    type: "approval.requested", approvalId: "appr_missing", title: "Use integration", risk: "high",
    allowedDecisions: ["approve", "decline", "cancel"] }] } as CanonicalChatDetailResponse;
  if (decision) detail.activities.push({ id: "activity_missing_resolved", chatId: run.chatId, runId: run.id, occurredAt,
    type: "approval.resolved", approvalId: "appr_missing", decision: decision as CanonicalChatApprovalDecision });
  else run.status = "completed";
  expect(surfaceDetails(detail)).toEqual(Array(4).fill("The agent requested your approval."));
  expect(canonicalChatApprovals(detail)[0]?.pending).toBe(false);
  expect(canonicalChatApprovals(detail)[0]?.decision).toBe(decision);
});
