import { describe, expect, it } from "vitest";
import type {
  CanonicalChatContent,
  CanonicalCreateChatTurnRequest,
} from "@matrix-os/contracts";
import {
  CanonicalChatOrchestrationError,
  canonicalChatSafeError,
} from "../../../packages/gateway/src/chat/orchestration-errors.js";
import type { ChatOwner } from "../../../packages/gateway/src/chat/records.js";
import { createCanonicalVoicePorts } from "../../../packages/gateway/src/voice-session/canonical-ports.js";
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
  let record: Record<string, unknown> | null = null;
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
      return { outcome: "acknowledged", record: { revision: 3 } };
    },
    async recordTerminal(_owner: ChatOwner, input: Record<string, unknown>) {
      terminals.push(input);
      return { outcome: "terminal", record: { revision: 4 } };
    },
    async classifyUnknown(_owner: ChatOwner, input: Record<string, unknown>) {
      unknowns.push(input);
      return { outcome: "classified", record: { revision: 5 } };
    },
  };
  return {
    deliveries: deliveries as never,
    pending, delivered, acks, terminals, unknowns,
    set record(value: Record<string, unknown> | null) { record = value; },
    get record() { return record; },
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
      segments: [{ segmentId: "vseg_1", textStart: 0, textEnd: 5, cumulativeEndMs: 100 }],
    });
    expect(result).toEqual({ revision: 1 });
    expect(deliveries.pending[0]).toMatchObject({
      chatId: CHAT_ID, responseId: "vresp_1", runId: "run_1",
      messageId: "msg_assistant_1", transportEpoch: 1,
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

    // Per-action cancellation is unimplemented and must stay truthful.
    expect(await ports.runControl.cancelAction({
      chatId: CHAT_ID, principalId: OWNER.ownerId, actionId: "act_1",
    })).toBe("unavailable");
  });
});
