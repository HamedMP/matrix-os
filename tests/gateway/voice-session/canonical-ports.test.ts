import { describe, expect, it } from "vitest";
import {
  CanonicalProviderCatalogSchema,
  type CanonicalChatContent,
  type CanonicalCreateChatTurnRequest,
} from "@matrix-os/contracts";
import { canonicalJsonStringify } from "../../../packages/gateway/src/chat/argument-digest.js";
import {
  CanonicalChatOrchestrationError,
  canonicalChatSafeError,
} from "../../../packages/gateway/src/chat/orchestration-errors.js";
import type { ChatOwner } from "../../../packages/gateway/src/chat/records.js";
import {
  canonicalVoiceDecision,
  createCanonicalVoicePorts,
} from "../../../packages/gateway/src/voice-session/canonical-ports.js";
import type { VoiceCanonicalChatEvent } from "../../../packages/gateway/src/voice-session/ports.js";
import type { VoiceTurnAdmissionRequest } from "../../../packages/gateway/src/voice-session/ports.js";

const CHAT_ID = "chat_test_voice";
const OWNER: ChatOwner = { type: "personal", ownerId: "principal_1" };

function admissionRequest(
  overrides: Partial<VoiceTurnAdmissionRequest> = {},
): VoiceTurnAdmissionRequest {
  return {
    clientRequestId: "req_voice_1",
    finalityId: "final_voice_1",
    localOrder: 1,
    baseRevision: 3,
    transcript: "Open the project plan",
    selection: null,
    interactionMode: "default",
    permissionMode: "supervised",
    memoryMode: "ordinary",
    sessionId: "vs_test",
    chatId: CHAT_ID,
    principalId: OWNER.ownerId,
    principalSource: "remote",
    ...overrides,
  };
}

type AdmitTurnCall = {
  principal: { userId: string; source?: string };
  owner: ChatOwner;
  chatId: string;
  input: CanonicalCreateChatTurnRequest;
  hints: unknown;
};

function orchestratorRig() {
  const admitCalls: AdmitTurnCall[] = [];
  const queuedCalls: { principal: { userId: string }; input: unknown }[] = [];
  const cancelled: { owner: ChatOwner; chatId: string; runId: string }[] = [];
  let admitResult: unknown = {
    record: { chat: { id: CHAT_ID, revision: 4 } },
    turn: { id: "cturn_1" },
    run: { id: "run_1" },
    admission: "accepted",
  };
  let admitError: unknown;
  /** Per-call admit script: thrown Error or result object; falls back to admitError/admitResult. */
  let admitScript: unknown[] | null = null;
  let queueResult: unknown = { queuedTurn: { id: "qturn_9" } };
  let queueError: unknown;
  let cancelResult: unknown = { cancellation: "aborted" };
  let cancelError: unknown;
  const orchestrator = {
    async admitTurn(
      principal: AdmitTurnCall["principal"], owner: ChatOwner,
      chatId: string, input: CanonicalCreateChatTurnRequest, hints?: unknown,
    ) {
      admitCalls.push({ principal, owner, chatId, input, hints });
      if (admitScript && admitScript.length > 0) {
        const step = admitScript.shift();
        if (step instanceof Error) throw step;
        return step;
      }
      if (admitError) throw admitError;
      return admitResult;
    },
    async enqueueQueuedTurn(principal: { userId: string }, _owner: ChatOwner, _chatId: string, input: unknown) {
      queuedCalls.push({ principal, input });
      if (queueError) throw queueError;
      return queueResult;
    },
    async cancelRun(owner: ChatOwner, chatId: string, runId: string) {
      cancelled.push({ owner, chatId, runId });
      if (cancelError) throw cancelError;
      return cancelResult;
    },
  };
  return {
    orchestrator: orchestrator as never,
    admitCalls, queuedCalls, cancelled,
    set admitResult(value: unknown) { admitResult = value; },
    set admitError(value: unknown) { admitError = value; },
    set admitScript(value: unknown[] | null) { admitScript = value; },
    set queueResult(value: unknown) { queueResult = value; },
    set queueError(value: unknown) { queueError = value; },
    set cancelResult(value: unknown) { cancelResult = value; },
    set cancelError(value: unknown) { cancelError = value; },
  };
}

type Sink = (input: { owner: ChatOwner; event: unknown }) => void;

function repositoryRig() {
  const sinks = new Set<Sink>();
  let chatRecord: unknown = { chat: { id: CHAT_ID, revision: 9 } };
  const repository = {
    async get(owner: ChatOwner, chatId: string) {
      if (owner.ownerId !== OWNER.ownerId || chatId !== CHAT_ID) return null;
      return chatRecord;
    },
    registerOutboxSink(sink: Sink) {
      sinks.add(sink);
      return { dispose: () => sinks.delete(sink) };
    },
  };
  return {
    repository: repository as never,
    sinks,
    set chatRecord(value: unknown) { chatRecord = value; },
    emitOutbox(owner: ChatOwner, event: unknown) {
      for (const sink of sinks) sink({ owner, event: event as never });
    },
  };
}

/** Minimal Kysely-shaped query builder distinguishing the two delivery queries. */
function fakeKysely(results: { messages?: { id: string } | undefined; unheard?: { run_id: string; message_id: string }[] }) {
  return {
    selectFrom(table: string) {
      const chain: Record<string, unknown> = {};
      const self = new Proxy(chain, {
        get(target, prop) {
          if (prop === "executeTakeFirst") {
            return async () => table === "chat_messages" ? results.messages : undefined;
          }
          if (prop === "execute") {
            return async () => table.startsWith("chat_voice_deliveries") ? (results.unheard ?? []) : [];
          }
          if (typeof prop === "string") return () => self;
          return undefined;
        },
      });
      return self;
    },
  };
}

function deliveriesRig() {
  const pending: Record<string, unknown>[] = [];
  const delivered: Record<string, unknown>[] = [];
  const acks: Record<string, unknown>[] = [];
  const terminals: Record<string, unknown>[] = [];
  const unknowns: Record<string, unknown>[] = [];
  const extensions: Record<string, unknown>[] = [];
  const adoptions: Record<string, unknown>[] = [];
  let record: Record<string, unknown> | null = null;
  let extensionResults: unknown[] = [];
  let adoptionResult: unknown = { outcome: "adopted", adopted: 2 };
  let acknowledgeResult: unknown = { outcome: "acknowledged", record: { revision: 3 } };
  const kysely = fakeKysely({ messages: { id: "msg_assistant_1" }, unheard: [] });
  const deliveries = {
    kysely,
    async get(_owner: ChatOwner, _chatId: string, _responseId: string) {
      return record;
    },
    async recordPending(_owner: ChatOwner, input: Record<string, unknown>) {
      pending.push(input);
      return { outcome: "recorded", record: { revision: 1 } };
    },
    async recordDelivered(_owner: ChatOwner, input: Record<string, unknown>) {
      delivered.push(input);
      return { outcome: "delivered", record: { revision: 2 } };
    },
    async acknowledge(_owner: ChatOwner, input: Record<string, unknown>) {
      acks.push(input);
      return acknowledgeResult;
    },
    async recordTerminal(_owner: ChatOwner, input: Record<string, unknown>) {
      terminals.push(input);
      return { outcome: "terminal", record: { revision: 4 } };
    },
    async classifyUnknown(_owner: ChatOwner, input: Record<string, unknown>) {
      unknowns.push(input);
      return { outcome: "classified", record: { revision: 5 } };
    },
    async extendManifest(_owner: ChatOwner, input: Record<string, unknown>) {
      extensions.push(input);
      const next = extensionResults.shift() ?? "extended";
      if (next === "extended") return "extended";
      return next;
    },
    async adoptTransportEpoch(_owner: ChatOwner, input: Record<string, unknown>) {
      adoptions.push(input);
      return adoptionResult;
    },
  };
  return {
    deliveries: deliveries as never,
    pending, delivered, acks, terminals, unknowns, extensions, adoptions,
    set record(value: Record<string, unknown> | null) { record = value; },
    get record() { return record; },
    set extensionResults(value: unknown[]) { extensionResults = value; },
    set adoptionResult(value: unknown) { adoptionResult = value; },
    set acknowledgeResult(value: unknown) { acknowledgeResult = value; },
    /** Simulate a canonical repo that has not landed manifest extension yet. */
    removeExtensionSurface() {
      (deliveries as Record<string, unknown>).extendManifest = undefined;
      (deliveries as Record<string, unknown>).adoptTransportEpoch = undefined;
    },
  };
}

function rig() {
  const orchestrator = orchestratorRig();
  const repository = repositoryRig();
  const deliveries = deliveriesRig();
  const ports = createCanonicalVoicePorts({
    orchestrator: orchestrator.orchestrator,
    repository: repository.repository,
    deliveries: deliveries.deliveries,
  });
  return { ports, orchestrator, repository, deliveries };
}

function outboxEvent(eventType: string, payload: Record<string, unknown>, chatId = CHAT_ID) {
  return {
    id: "evt_1",
    chatId,
    eventType,
    payload,
    createdAt: new Date().toISOString(),
  };
}

describe("createCanonicalVoicePorts", () => {
  it("passes the immutable server execution inventory into canonical speech and queue policy", async () => {
    const { ports, orchestrator } = rig();
    const executionPolicy = { revision: "policy_1", actionMode: "safe_reads" as const,
      workspaceScope: "workspace", tools: ["workspace_read"], delegation: false };
    await ports.admission.admitFinalTranscript(admissionRequest({ executionPolicy }));
    expect(orchestrator.admitCalls[0].input.runPolicy?.executionPolicy).toEqual(executionPolicy);
    orchestrator.admitError = new CanonicalChatOrchestrationError(canonicalChatSafeError("chat_busy", "busy", true, ["retry"]), 409);
    await ports.admission.admitFinalTranscript(admissionRequest({ executionPolicy }));
    expect(orchestrator.queuedCalls[0].input).toMatchObject({ runPolicy: { executionPolicy } });
  });

  it("fails closed before admission when durable unheard delivery lookup fails", async () => {
    const { ports, orchestrator, deliveries } = rig();
    Object.assign(deliveries.deliveries, { kysely: { selectFrom() { throw new Error("database timeout"); } } });
    const result = await ports.admission.admitFinalTranscript(admissionRequest());
    expect(result).toMatchObject({ outcome: "failed", error: { code: "internal_failure" } });
    expect(orchestrator.admitCalls).toEqual([]);
    expect(orchestrator.queuedCalls).toEqual([]);
  });
  it("admits finals through canonical admission with voice run policy", async () => {
    const { ports, orchestrator } = rig();
    const result = await ports.admission.admitFinalTranscript(
      admissionRequest({ memoryMode: "session_only" }),
    );

    expect(result).toMatchObject({
      outcome: "sent", canonicalTurnId: "cturn_1", runId: "run_1", revision: 4,
    });
    const call = orchestrator.admitCalls[0];
    expect(call.principal).toEqual({ userId: "principal_1", source: "remote" });
    expect(call.owner).toEqual(OWNER);
    expect(call.input.clientRequestId).toBe("req_voice_1");
    expect(call.input.baseRevision).toBe(3);
    expect(call.input.parts).toEqual([{ type: "text", text: "Open the project plan" }]);
    expect(call.input.runPolicy).toEqual({
      memoryMode: "session_only",
      source: "voice",
      voiceSessionId: "vs_test",
      nativeCheckpointPolicy: "disposable",
    });
  });

  it("uses reusable checkpoints for ordinary memory mode", async () => {
    const { ports, orchestrator } = rig();
    await ports.admission.admitFinalTranscript(admissionRequest());
    expect(orchestrator.admitCalls[0].input.runPolicy).toMatchObject({
      memoryMode: "ordinary", nativeCheckpointPolicy: "reusable",
    });
  });

  it("falls back to canonical queue admission when the chat is busy", async () => {
    const { ports, orchestrator } = rig();
    orchestrator.admitError = new CanonicalChatOrchestrationError(
      canonicalChatSafeError("chat_busy", "busy", true, ["retry"]), 409,
    );
    const result = await ports.admission.admitFinalTranscript(admissionRequest());
    expect(result).toEqual({
      outcome: "queued", canonicalQueuedTurnId: "qturn_9", revision: 9,
    });
    expect(orchestrator.queuedCalls).toHaveLength(1);
    // The queued admission carries the same immutable run policy.
    expect((orchestrator.queuedCalls[0].input as CanonicalCreateChatTurnRequest).runPolicy)
      .toMatchObject({ source: "voice", voiceSessionId: "vs_test" });
  });

  it("replays already_accepted admissions with durable identity", async () => {
    const { ports, orchestrator } = rig();
    orchestrator.admitResult = {
      record: { chat: { id: CHAT_ID, revision: 7 } },
      turn: { id: "cturn_1" },
      run: { id: "run_1" },
      admission: "already_accepted",
    };
    const result = await ports.admission.admitFinalTranscript(admissionRequest());
    expect(result).toMatchObject({ outcome: "already_accepted", canonicalTurnId: "cturn_1", runId: "run_1" });
  });

  it("maps canonical errors onto the safe voice vocabulary", async () => {
    const { ports, orchestrator } = rig();
    orchestrator.admitError = new CanonicalChatOrchestrationError(
      canonicalChatSafeError("chat_not_found", "gone", false), 404,
    );
    expect(await ports.admission.admitFinalTranscript(admissionRequest()))
      .toMatchObject({ outcome: "rejected", error: { code: "chat_unavailable" } });

    orchestrator.admitError = new CanonicalChatOrchestrationError(
      canonicalChatSafeError("authorization_failed", "denied", false), 403,
    );
    expect(await ports.admission.admitFinalTranscript(admissionRequest()))
      .toMatchObject({ outcome: "rejected", error: { code: "permission_denied" } });
  });

  it("writes pending delivery records bound to the assistant message", async () => {
    const { ports, deliveries } = rig();
    const result = await ports.delivery.recordPending({
      sessionId: "vs_test", chatId: CHAT_ID, principalId: OWNER.ownerId,
      responseId: "vresp_1", runId: "run_1", transportEpoch: 1,
      segments: [{
        segmentId: "vseg_1", segmentIndex: 0, textStart: 0, textEnd: 5, durationMs: 100,
      }],
    });
    expect(result).toEqual({ revision: 1 });
    expect(deliveries.pending[0]).toMatchObject({
      chatId: CHAT_ID, responseId: "vresp_1", runId: "run_1",
      messageId: "msg_assistant_1", transportEpoch: 1,
    });
    // The repo manifest stores canonical offsets only — the engine's
    // ephemeral segmentIndex is stripped (strict schema rejects unknown keys).
    expect((deliveries.pending[0].segments as Record<string, unknown>[])[0]).toEqual({
      segmentId: "vseg_1", textStart: 0, textEnd: 5, durationMs: 100,
    });
  });

  it("rejects pending delivery when no assistant message exists", async () => {
    const { ports, deliveries } = rig();
    (deliveries.deliveries as { kysely: unknown }).kysely = fakeKysely({ messages: undefined });
    await expect(ports.delivery.recordPending({
      sessionId: "vs_test", chatId: CHAT_ID, principalId: OWNER.ownerId,
      responseId: "vresp_1", runId: "run_1", transportEpoch: 1,
      segments: [],
    })).rejects.toMatchObject({ code: "internal_failure" });
    expect(deliveries.pending).toHaveLength(0);
  });

  it("projects delivered progress through the fenced repository write", async () => {
    const { ports, deliveries } = rig();
    deliveries.record = { revision: 5 };
    const result = await ports.delivery.recordDelivered({
      sessionId: "vs_test", chatId: CHAT_ID, principalId: OWNER.ownerId,
      responseId: "vresp_1", transportEpoch: 2, deliveredThroughMs: 300, deliveryRevision: 5,
    });
    expect(result).toEqual({ revision: 2 });
    expect(deliveries.delivered[0]).toMatchObject({
      responseId: "vresp_1", deliveredThroughMs: 300, revision: 5, transportEpoch: 2,
    });
  });

  it("returns ignored for delivered writes against missing records", async () => {
    const { ports } = rig();
    const result = await ports.delivery.recordDelivered({
      sessionId: "vs_test", chatId: CHAT_ID, principalId: OWNER.ownerId,
      responseId: "vresp_missing", transportEpoch: 1, deliveredThroughMs: 10, deliveryRevision: 1,
    });
    expect(result).toBe("ignored");
  });

  it("classifies unknown terminals through the conservative path", async () => {
    const { ports, deliveries } = rig();
    const result = await ports.delivery.recordTerminal({
      sessionId: "vs_test", chatId: CHAT_ID, principalId: OWNER.ownerId,
      responseId: "vresp_1", runId: "run_1", transportEpoch: 1,
      reason: "unknown", effectiveThroughMs: 0,
    });
    expect(result).toEqual({ revision: 5 });
    expect(deliveries.unknowns[0]).toMatchObject({ responseId: "vresp_1", terminalReason: "unknown" });
    expect(deliveries.terminals).toHaveLength(0);
  });

  it("subscribes to the owner-scoped outbox and projects canonical events", () => {
    const { ports, repository } = rig();
    const events: VoiceCanonicalChatEvent[] = [];
    const subscription = ports.chatEvents.subscribe(
      { chatId: CHAT_ID, principalId: OWNER.ownerId },
      (event) => events.push(event),
    );
    expect(repository.sinks.size).toBe(1);

    // Wrong chat and wrong owner are filtered before projection.
    repository.emitOutbox(OWNER, outboxEvent("run.completed", { runId: "run_x" }, "chat_other"));
    repository.emitOutbox({ type: "personal", ownerId: "someone_else" },
      outboxEvent("run.completed", { runId: "run_x" }));

    repository.emitOutbox(OWNER, outboxEvent("queue.claimed", {
      turnId: "cturn_4", queuedTurnId: "qturn_2", runId: "run_2",
    }));
    repository.emitOutbox(OWNER, outboxEvent("turn.accepted", {
      turnId: "cturn_1", runId: "run_1",
    }));
    repository.emitOutbox(OWNER, outboxEvent("run.completed", { runId: "run_1" }));

    expect(events).toEqual([
      { type: "run.started", runId: "run_2", canonicalTurnId: "cturn_4", canonicalQueuedTurnId: "qturn_2" },
      { type: "run.started", runId: "run_1", canonicalTurnId: "cturn_1" },
      { type: "run.terminal", runId: "run_1", state: "succeeded" },
    ]);

    subscription.close();
    expect(repository.sinks.size).toBe(0);
  });

  it("projects run.message deltas from the appended part only", () => {
    const { ports, repository } = rig();
    const events: VoiceCanonicalChatEvent[] = [];
    ports.chatEvents.subscribe({ chatId: CHAT_ID, principalId: OWNER.ownerId },
      (event) => events.push(event));

    const now = new Date().toISOString();
    const streamContent: CanonicalChatContent = {
      record: { chat: {
        id: CHAT_ID,
        ownerScope: { type: "personal", ownerId: OWNER.ownerId },
        title: "Voice test",
        lifecycle: "active",
        attention: "none",
        revision: 4,
        messageCount: 2,
        createdAt: now,
        updatedAt: now,
      } },
      messageDelta: {
        message: {
          id: "msg_1",
          chatId: CHAT_ID,
          seq: 2,
          role: "assistant",
          state: "pending",
          parts: [{ type: "text", text: "Hello" }],
          createdAt: now,
        },
        partIndex: 3,
        offset: 40,
      },
    } as CanonicalChatContent;
    repository.emitOutbox(OWNER, outboxEvent("run.message", {
      runId: "run_1", streamContent,
    }));
    expect(events).toEqual([
      { type: "assistant.text", runId: "run_1", text: "Hello", textStart: 40, textEnd: 45 },
    ]);
  });

  it("enforces chat access through the canonical repository", async () => {
    const { ports, repository } = rig();
    await expect(ports.chatAccess.requireAccess({
      chatId: CHAT_ID, principalId: OWNER.ownerId, level: "read",
    })).resolves.toBeUndefined();

    repository.chatRecord = null;
    await expect(ports.chatAccess.requireAccess({
      chatId: CHAT_ID, principalId: OWNER.ownerId, level: "read",
    })).rejects.toMatchObject({ code: "not_found" });
  });

  it("maps run cancellation through the orchestrator truthfully", async () => {
    const { ports, orchestrator } = rig();
    expect(await ports.runControl.cancelRun({
      chatId: CHAT_ID, principalId: OWNER.ownerId, runId: "run_1", reason: "user",
    })).toBe("cancelled");
    expect(orchestrator.cancelled[0]).toEqual({ owner: OWNER, chatId: CHAT_ID, runId: "run_1" });

    orchestrator.cancelResult = { cancellation: "already_terminal" };
    expect(await ports.runControl.cancelRun({
      chatId: CHAT_ID, principalId: OWNER.ownerId, runId: "run_1", reason: "user",
    })).toBe("already_terminal");

    orchestrator.cancelError = new Error("db gone");
    expect(await ports.runControl.cancelRun({
      chatId: CHAT_ID, principalId: OWNER.ownerId, runId: "run_1", reason: "user",
    })).toBe("unavailable");

    // No configured canonical action authority stays truthfully unavailable.
    expect(await ports.runControl.cancelAction({
      chatId: CHAT_ID, principalId: OWNER.ownerId, actionId: "act_1",
    })).toBe("unavailable");
  });

  it("routes targeted action cancellation through canonical action authority", async () => {
    const orchestrator = orchestratorRig();
    const repository = repositoryRig();
    const deliveries = deliveriesRig();
    const cancelById = vi.fn(async () => ({ state: "cancelled" }));
    const ports = createCanonicalVoicePorts({
      orchestrator: orchestrator.orchestrator,
      repository: repository.repository,
      deliveries: deliveries.deliveries,
      actions: { cancelById } as never,
    });
    expect(await ports.runControl.cancelAction({
      chatId: CHAT_ID, principalId: OWNER.ownerId, actionId: "action_1",
    })).toBe("cancelled");
    expect(cancelById).toHaveBeenCalledWith({
      owner: OWNER, chatId: CHAT_ID, actionId: "action_1",
    });
  });

  it("loads the canonical chat revision for lazy admission hydration", async () => {
    const { ports, repository } = rig();
    expect(await ports.admission.loadChatRevision?.({
      chatId: CHAT_ID, principalId: OWNER.ownerId,
    })).toBe(9);

    repository.chatRecord = null;
    expect(await ports.admission.loadChatRevision?.({
      chatId: CHAT_ID, principalId: OWNER.ownerId,
    })).toBeNull();
  });

  it("self-heals a stale baseRevision once on a revision conflict", async () => {
    const { ports, orchestrator } = rig();
    // First admit: stale fence. The adapter re-reads canonical truth (9) and
    // retries once — the retry rides revision 9, not the stale 3.
    orchestrator.admitScript = [
      new CanonicalChatOrchestrationError(
        canonicalChatSafeError("chat_conflict", "stale", true, ["retry"]), 409,
      ),
      {
        record: { chat: { id: CHAT_ID, revision: 9 } },
        turn: { id: "cturn_1" },
        run: { id: "run_1" },
        admission: "accepted",
      },
    ];
    const result = await ports.admission.admitFinalTranscript(
      admissionRequest({ baseRevision: 3 }),
    );
    expect(result).toMatchObject({ outcome: "sent", canonicalTurnId: "cturn_1" });
    expect(orchestrator.admitCalls).toHaveLength(2);
    expect(orchestrator.admitCalls[0].input.baseRevision).toBe(3);
    expect(orchestrator.admitCalls[1].input.baseRevision).toBe(9);

    // A persistent conflict after the refresh surfaces as a rejection —
    // it never retries a third time.
    orchestrator.admitScript = [
      new CanonicalChatOrchestrationError(
        canonicalChatSafeError("chat_conflict", "stale", true, ["retry"]), 409,
      ),
      new CanonicalChatOrchestrationError(
        canonicalChatSafeError("chat_conflict", "stale", true, ["retry"]), 409,
      ),
    ];
    const rejected = await ports.admission.admitFinalTranscript(
      admissionRequest({ baseRevision: 3 }),
    );
    expect(rejected.outcome).not.toBe("sent");
    // The refreshed revision is durable truth — it rides the rejection so the
    // engine's revision cache self-heals even though nothing was admitted.
    expect(rejected.revision).toBe(9);
    expect(orchestrator.admitCalls).toHaveLength(4);
  });

  it("extends the durable manifest through the fenced repository write", async () => {
    const { ports, deliveries } = rig();
    deliveries.record = { revision: 5, transportEpoch: 1 };
    const result = await ports.delivery.extendManifest({
      sessionId: "vs_test", chatId: CHAT_ID, principalId: OWNER.ownerId,
      responseId: "vresp_1", transportEpoch: 1, deliveryRevision: 5,
      appendSegments: [{
        segmentId: "vseg_2", segmentIndex: 1, textStart: 5, textEnd: 9, durationMs: 40,
      }],
    });
    expect(result).toEqual({ revision: 6 });
    expect(deliveries.extensions[0]).toMatchObject({
      chatId: CHAT_ID, responseId: "vresp_1", revision: 5, transportEpoch: 1,
    });
    // segmentIndex is stripped — the repo schema stores canonical offsets only.
    expect((deliveries.extensions[0].appendSegments as Record<string, unknown>[])[0]).toEqual({
      segmentId: "vseg_2", textStart: 5, textEnd: 9, durationMs: 40,
    });
  });

  it("retries manifest extension on stale fences and gives up within the bound", async () => {
    const { ports, deliveries } = rig();
    deliveries.record = { revision: 5, transportEpoch: 1 };
    deliveries.extensionResults = ["stale", "extended"];
    const result = await ports.delivery.extendManifest({
      sessionId: "vs_test", chatId: CHAT_ID, principalId: OWNER.ownerId,
      responseId: "vresp_1", transportEpoch: 1, deliveryRevision: 5,
      appendSegments: [{ segmentId: "vseg_2", segmentIndex: 1, textStart: 5, textEnd: 9, durationMs: 40 }],
    });
    expect(result).toEqual({ revision: 6 });
    expect(deliveries.extensions).toHaveLength(2);

    deliveries.extensionResults = ["stale", "stale", "stale", "stale"];
    const exhausted = await ports.delivery.extendManifest({
      sessionId: "vs_test", chatId: CHAT_ID, principalId: OWNER.ownerId,
      responseId: "vresp_1", transportEpoch: 1, deliveryRevision: 5,
      appendSegments: [{ segmentId: "vseg_3", segmentIndex: 2, textStart: 9, textEnd: 12, durationMs: 30 }],
    });
    expect(exhausted).toBe("ignored");
  });

  it("reports ignored when the canonical repo lacks manifest extension", async () => {
    const { ports, deliveries } = rig();
    deliveries.record = { revision: 5, transportEpoch: 1 };
    deliveries.removeExtensionSurface();
    const result = await ports.delivery.extendManifest({
      sessionId: "vs_test", chatId: CHAT_ID, principalId: OWNER.ownerId,
      responseId: "vresp_1", transportEpoch: 1, deliveryRevision: 5,
      appendSegments: [{ segmentId: "vseg_2", segmentIndex: 1, textStart: 5, textEnd: 9, durationMs: 40 }],
    });
    expect(result).toBe("ignored");
  });

  it("adopts the fresh transport epoch and degrades honestly when unsupported", async () => {
    const { ports, deliveries } = rig();
    const adopted = await ports.delivery.adoptTransportEpoch({
      sessionId: "vs_test", chatId: CHAT_ID, principalId: OWNER.ownerId, transportEpoch: 2,
    });
    expect(adopted).toEqual({ outcome: "adopted", adopted: 2 });
    expect(deliveries.adoptions[0]).toMatchObject({ chatId: CHAT_ID, transportEpoch: 2 });

    deliveries.adoptionResult = { outcome: "none", adopted: 0 };
    expect(await ports.delivery.adoptTransportEpoch({
      sessionId: "vs_test", chatId: CHAT_ID, principalId: OWNER.ownerId, transportEpoch: 2,
    })).toEqual({ outcome: "none", adopted: 0 });

    deliveries.removeExtensionSurface();
    expect(await ports.delivery.adoptTransportEpoch({
      sessionId: "vs_test", chatId: CHAT_ID, principalId: OWNER.ownerId, transportEpoch: 3,
    })).toEqual({ outcome: "none", adopted: 0 });
  });

  it("re-reads fence inputs through getDelivery", async () => {
    const { ports, deliveries } = rig();
    deliveries.record = { revision: 7, transportEpoch: 2 };
    expect(await ports.delivery.getDelivery({
      sessionId: "vs_test", chatId: CHAT_ID, principalId: OWNER.ownerId,
      responseId: "vresp_1",
    })).toEqual({ revision: 7, transportEpoch: 2 });

    deliveries.record = null;
    expect(await ports.delivery.getDelivery({
      sessionId: "vs_test", chatId: CHAT_ID, principalId: OWNER.ownerId,
      responseId: "vresp_missing",
    })).toBeNull();
  });

  it("surfaces out_of_order acknowledgements without marking them landed", async () => {
    const { ports, deliveries } = rig();
    deliveries.record = { revision: 4, transportEpoch: 1 };
    deliveries.acknowledgeResult = { outcome: "out_of_order", record: null };
    const result = await ports.delivery.acknowledge({
      sessionId: "vs_test", chatId: CHAT_ID, principalId: OWNER.ownerId,
      responseId: "vresp_1", segmentId: "vseg_2", transportEpoch: 1,
      playedThroughMs: 100, deliveryRevision: 4, effectiveTextEnd: 9,
    });
    expect(result).toBe("out_of_order");
  });
});

describe("canonical voice decision", () => {
  const voiceInstance = {
    id: "kernel_default",
    driverKind: "kernel" as const,
    displayName: "Matrix AI",
    availability: "available" as const,
    workspaceRequirement: "none" as const,
    catalogRevision: "catalog_voice",
    models: [{
      id: "model_voice",
      displayName: "Voice model",
      availability: "available" as const,
      capabilities: ["reasoning"],
      supportsVision: false,
      supportsToolUse: false,
    }],
    options: [],
    skills: [],
    commands: [],
    setupActions: [],
    supports: {
      rootChat: true,
      resume: true,
      cancellation: "run" as const,
      attachments: [] as never[],
      tools: [] as never[],
      approvals: false,
      userInput: false,
      worktrees: "none" as const,
      resources: [] as never[],
      interactionModes: ["default"],
      permissionModes: ["full_access"],
    },
    defaultSelection: { instanceId: "kernel_default", model: "model_voice" },
  };
  const voiceCatalog = CanonicalProviderCatalogSchema.parse({
    revision: "catalog_voice",
    drivers: [{
      kind: "kernel",
      displayName: "Kernel",
      adapterVersion: "1.0.0",
      capabilityClass: "system_agent",
    }],
    instances: [voiceInstance],
  });
  const selection = { instanceId: "kernel_default", model: "model_voice" };

  it("returns no decision when no canonical selection exists — fail closed", () => {
    expect(canonicalVoiceDecision({ selection: undefined, catalog: voiceCatalog })).toBeUndefined();
  });

  it("projects an eligible route with a frozen conversation-only policy", () => {
    const decision = canonicalVoiceDecision({
      selection, catalog: voiceCatalog, surface: "web_canvas",
    });
    expect(decision).toMatchObject({
      selection,
      interactionMode: "default",
      permissionMode: "full_access",
      executionPolicy: {
        revision: "voice_conversation_only_v1",
        actionMode: "conversation_only",
        workspaceScope: "apps",
        tools: [],
        delegation: false,
      },
    });
    expect(decision?.capability).toMatchObject({
      status: "available",
      surface: "web_canvas",
      transportModes: ["relayed_websocket"],
      turnModes: ["hands_free", "push_to_talk"],
      supportsInterruption: true,
      resume: "delivery_aware",
      sessionOnly: "unsupported",
      actionMode: "conversation_only",
      actionCancellation: "none",
    });
  });

  it("reports an unavailable capability for a tool-capable route instead of dropping the decision", () => {
    const toolCapable = CanonicalProviderCatalogSchema.parse({
      revision: "catalog_tool_voice",
      drivers: [{ kind: "codex", displayName: "Codex", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
      instances: [{
        ...voiceInstance, id: "codex_default", driverKind: "codex",
        catalogRevision: "catalog_tool_voice",
        models: [{ ...voiceInstance.models[0]!, capabilities: ["reasoning", "tools"], supportsToolUse: true }],
        defaultSelection: { instanceId: "codex_default", model: "model_voice" },
      }],
    });
    const decision = canonicalVoiceDecision({
      selection: { instanceId: "codex_default", model: "model_voice" },
      catalog: toolCapable,
    });
    expect(decision?.selection).toEqual({ instanceId: "codex_default", model: "model_voice" });
    expect(decision?.capability).toMatchObject({
      status: "unavailable",
      reason: "provider_unavailable",
      transportModes: [],
      turnModes: [],
      actionMode: "conversation_only",
      actionCancellation: "none",
      sessionOnly: "unsupported",
    });
  });

  it("marks a route without the canonical voice modes unavailable", () => {
    const wrongModes = CanonicalProviderCatalogSchema.parse({
      revision: "catalog_modes_voice",
      drivers: [{ kind: "kernel", displayName: "Kernel", adapterVersion: "1.0.0", capabilityClass: "system_agent" }],
      instances: [{
        ...voiceInstance, catalogRevision: "catalog_modes_voice",
        supports: { ...voiceInstance.supports, permissionModes: ["supervised"] },
      }],
    });
    expect(canonicalVoiceDecision({ selection, catalog: wrongModes })?.capability.status)
      .toBe("unavailable");
  });

  it("produces a byte-stable frozen policy so reconnect assertions hold", () => {
    const a = canonicalVoiceDecision({ selection, catalog: voiceCatalog });
    const b = canonicalVoiceDecision({ selection, catalog: voiceCatalog, surface: "electron_desktop" });
    expect(canonicalJsonStringify(a?.executionPolicy)).toBe(canonicalJsonStringify(b?.executionPolicy));
  });
});
