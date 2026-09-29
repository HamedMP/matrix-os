import { describe, expect, it } from "vitest";
import {
  FakeCanonicalChatHarness,
  type FakeCanonicalAdmissionRequest,
} from "../../fixtures/voice-session/canonical-chat-harness.js";

function request(
  overrides: Partial<FakeCanonicalAdmissionRequest> = {},
): FakeCanonicalAdmissionRequest {
  return {
    requestId: "request_1",
    finalityId: "final_1",
    source: "voice",
    localOrder: 1,
    baseRevision: 0,
    routeId: "route_claude",
    interactionMode: "default",
    permissionMode: "supervised",
    memoryMode: "ordinary",
    choice: "send",
    transcript: "Open the project plan",
    ...overrides,
  };
}

describe("FakeCanonicalChatHarness", () => {
  it("assigns stable turn identities and journals canonical admission metadata", () => {
    const harness = new FakeCanonicalChatHarness();

    expect(harness.admit(request())).toEqual({
      outcome: "sent",
      canonicalTurnId: "cturn_0001",
      revision: 1,
    });
    expect(harness.admit(request({
      requestId: "request_2",
      finalityId: "final_2",
      localOrder: 2,
      baseRevision: 1,
      routeId: "route_codex",
      interactionMode: "plan",
      permissionMode: "trusted",
      memoryMode: "session_only",
      choice: "queue",
      transcript: "Second turn",
    }))).toEqual({
      outcome: "queued",
      canonicalTurnId: "cturn_0002",
      revision: 2,
    });

    expect(harness.snapshot()).toMatchObject({
      revision: 2,
      admittedRequestIds: ["request_1", "request_2"],
    });
    expect(harness.journal().filter((entry) => entry.type === "admission.accepted"))
      .toEqual([
        {
          sequence: 1,
          type: "admission.accepted",
          details: {
            requestId: "request_1",
            finalityId: "final_1",
            source: "voice",
            localOrder: 1,
            baseRevision: 0,
            routeId: "route_claude",
            interactionMode: "default",
            permissionMode: "supervised",
            memoryMode: "ordinary",
            choice: "send",
            textLength: 21,
            canonicalTurnId: "cturn_0001",
            outcome: "sent",
            revision: 1,
          },
        },
        {
          sequence: 2,
          type: "admission.accepted",
          details: {
            requestId: "request_2",
            finalityId: "final_2",
            source: "voice",
            localOrder: 2,
            baseRevision: 1,
            routeId: "route_codex",
            interactionMode: "plan",
            permissionMode: "trusted",
            memoryMode: "session_only",
            choice: "queue",
            textLength: 11,
            canonicalTurnId: "cturn_0002",
            outcome: "queued",
            revision: 2,
          },
        },
      ]);
  });

  it("replays duplicate request and finality identities without advancing revision", () => {
    const harness = new FakeCanonicalChatHarness();
    const admitted = harness.admit(request());

    expect(harness.admit(request({
      finalityId: "changed_finality",
      baseRevision: 99,
      transcript: "changed transcript",
    }))).toEqual(admitted);
    expect(harness.admit(request({
      requestId: "changed_request",
      baseRevision: 99,
      transcript: "another transcript",
    }))).toEqual(admitted);
    expect(harness.snapshot()).toMatchObject({
      revision: 1,
      admittedRequestIds: ["request_1"],
    });
  });

  it("orders reordered voice finals by local order with a deterministic identity tie-break", () => {
    const harness = new FakeCanonicalChatHarness();
    const results = harness.flushReorderedFinals([
      request({ requestId: "request_c", finalityId: "final_c", localOrder: 2 }),
      request({ requestId: "request_b", finalityId: "final_b", localOrder: 1 }),
      request({ requestId: "request_a", finalityId: "final_a", localOrder: 1 }),
    ]);

    expect(results).toEqual([
      { outcome: "sent", canonicalTurnId: "cturn_0001", revision: 1 },
      { outcome: "stale_revision", revision: 1 },
      { outcome: "stale_revision", revision: 1 },
    ]);
    expect(harness.snapshot().admittedRequestIds).toEqual(["request_a"]);
    expect(harness.journal().map((entry) => entry.details.requestId))
      .toEqual(["request_a", "request_b", "request_c"]);
  });

  it("serializes typed races by call order and reports stale voice revisions explicitly", () => {
    const harness = new FakeCanonicalChatHarness();

    expect(harness.admit(request({
      requestId: "typed_request",
      finalityId: "typed_final",
      source: "typed",
      localOrder: 20,
      transcript: "Typed first",
    }))).toMatchObject({ outcome: "sent", canonicalTurnId: "cturn_0001", revision: 1 });
    expect(harness.admit(request({
      requestId: "voice_request",
      finalityId: "voice_final",
      source: "voice",
      localOrder: 1,
      transcript: "Voice completed later",
    }))).toEqual({ outcome: "stale_revision", revision: 1 });
    expect(harness.snapshot().admittedRequestIds).toEqual(["typed_request"]);
  });

  it("honors explicit queue, steer, and reject choices while a run is active", () => {
    const queueHarness = new FakeCanonicalChatHarness({ revision: 4, activeRunId: "run_active" });
    expect(queueHarness.admit(request({ baseRevision: 4, choice: "send" })))
      .toEqual({ outcome: "rejected", revision: 4 });
    expect(queueHarness.admit(request({
      requestId: "request_queue",
      finalityId: "final_queue",
      baseRevision: 4,
      choice: "queue",
    }))).toEqual({ outcome: "queued", canonicalTurnId: "cturn_0001", revision: 5 });

    const steerHarness = new FakeCanonicalChatHarness({ activeRunId: "run_active" });
    expect(steerHarness.admit(request({ choice: "steer" })))
      .toEqual({ outcome: "steered", canonicalTurnId: "cturn_0001", revision: 1 });

    const rejectHarness = new FakeCanonicalChatHarness({ activeRunId: "run_active" });
    expect(rejectHarness.admit(request({ choice: "reject" })))
      .toEqual({ outcome: "rejected", revision: 0 });
  });

  it("waits for approval and explicitly invalidates approval when its digest drifts", () => {
    const harness = new FakeCanonicalChatHarness({ revision: 3, approvalWait: true });

    expect(harness.admit(request({ baseRevision: 3 })))
      .toEqual({ outcome: "waiting_for_approval", revision: 3 });
    harness.recordApproval({
      approvalId: "approval_1",
      operationId: "operation_1",
      argumentDigest: "digest_a",
      decision: "approved",
    });
    harness.recordApproval({
      approvalId: "approval_1",
      operationId: "operation_1",
      argumentDigest: "digest_b",
      decision: "pending",
    });

    expect(harness.journal().map((entry) => entry.type)).toEqual([
      "admission.waiting_for_approval",
      "approval.recorded",
      "approval.invalidated_digest_drift",
      "approval.recorded",
    ]);
    expect(harness.journal()[2].details).toEqual({
      approvalId: "approval_1",
      operationId: "operation_1",
      priorArgumentDigest: "digest_a",
      argumentDigest: "digest_b",
    });
    expect(harness.snapshot()).toMatchObject({ revision: 3, approvalWait: true });
  });

  it("deduplicates assistant events by event identity", () => {
    const harness = new FakeCanonicalChatHarness({ activeRunId: "run_1" });
    const event = { runId: "run_1", eventId: "event_1", kind: "tool" as const, label: "Search" };

    harness.appendAssistantEvent(event);
    harness.appendAssistantEvent({ ...event, label: "Changed label" });

    expect(harness.journal()).toEqual([{
      sequence: 1,
      type: "assistant.tool",
      details: { runId: "run_1", eventId: "event_1", label: "Search" },
    }]);
  });

  it("deduplicates operation idempotency keys and preserves outcome unknown across restart", () => {
    const harness = new FakeCanonicalChatHarness();
    harness.recordOperation({
      operationId: "operation_1",
      idempotencyKey: "effect_once",
      state: "outcome_unknown",
    });
    harness.recordOperation({
      operationId: "operation_replay",
      idempotencyKey: "effect_once",
      state: "succeeded",
    });

    const restarted = harness.restart();
    expect(restarted.snapshot().operations).toEqual([
      { operationId: "operation_1", state: "outcome_unknown" },
    ]);
    expect(restarted.journal()).toEqual(harness.journal());

    restarted.recordOperation({
      operationId: "operation_after_restart",
      idempotencyKey: "effect_once",
      state: "running",
    });
    expect(restarted.snapshot().operations).toEqual([
      { operationId: "operation_1", state: "outcome_unknown" },
    ]);
  });

  it("applies delivery writes monotonically and idempotently", () => {
    const harness = new FakeCanonicalChatHarness();
    harness.recordDelivery({ responseId: "response_1", revision: 2, state: "pending" });
    harness.recordDelivery({ responseId: "response_1", revision: 1, state: "complete" });
    harness.recordDelivery({ responseId: "response_1", revision: 2, state: "interrupted" });
    harness.recordDelivery({ responseId: "response_1", revision: 3, state: "unknown" });
    harness.recordDelivery({ responseId: "response_1", revision: 3, state: "unknown" });

    expect(harness.snapshot().deliveries).toEqual([
      { responseId: "response_1", revision: 3, state: "unknown" },
    ]);
    expect(harness.journal().filter((entry) => entry.type === "delivery.recorded"))
      .toHaveLength(2);
  });

  it("keeps transcript text and exact action arguments out of the ordinary journal", () => {
    const harness = new FakeCanonicalChatHarness();
    const privateTranscript = "Transfer the confidential launch details";
    const exactArguments = '{"recipient":"private@example.test","amount":5000}';

    harness.admit(request({ transcript: privateTranscript }));
    harness.recordApproval({
      approvalId: "approval_private",
      operationId: "operation_private",
      argumentDigest: "sha256:public-digest-only",
      decision: "pending",
    });
    harness.appendAssistantEvent({
      runId: "run_private",
      eventId: "event_private",
      kind: "approval",
      label: "Review action",
    });

    const serialized = JSON.stringify(harness.journal());
    expect(serialized).not.toContain(privateTranscript);
    expect(serialized).not.toContain(exactArguments);
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).toContain(`"textLength":${privateTranscript.length}`);
    expect(serialized).toContain("sha256:public-digest-only");
  });

  it("forces a drifted digest back to pending even when the replacement claims approval", () => {
    const harness = new FakeCanonicalChatHarness({ revision: 2 });
    harness.recordApproval({
      approvalId: "approval_1",
      operationId: "operation_1",
      argumentDigest: "digest_a",
      decision: "approved",
    });
    harness.recordApproval({
      approvalId: "approval_1",
      operationId: "operation_1",
      argumentDigest: "digest_b",
      decision: "approved",
    });

    expect(harness.snapshot().approvalWait).toBe(true);
    expect(harness.admit(request({ baseRevision: 2 })))
      .toEqual({ outcome: "waiting_for_approval", revision: 2 });
    expect(harness.journal().map((entry) => entry.type)).toEqual([
      "approval.recorded",
      "approval.invalidated_digest_drift",
      "approval.recorded",
      "admission.waiting_for_approval",
    ]);

    harness.recordApproval({
      approvalId: "approval_1",
      operationId: "operation_1",
      argumentDigest: "digest_b",
      decision: "approved",
    });
    expect(harness.snapshot().approvalWait).toBe(false);
    expect(harness.admit(request({
      requestId: "request_after",
      finalityId: "final_after",
      baseRevision: 2,
    }))).toMatchObject({ outcome: "sent", canonicalTurnId: "cturn_0001", revision: 3 });
  });

  it("forces a changed operation identity back to pending like digest drift", () => {
    const harness = new FakeCanonicalChatHarness({ revision: 2 });
    harness.recordApproval({
      approvalId: "approval_1",
      operationId: "operation_1",
      argumentDigest: "digest_a",
      decision: "approved",
    });
    harness.recordApproval({
      approvalId: "approval_1",
      operationId: "operation_2",
      argumentDigest: "digest_a",
      decision: "approved",
    });

    expect(harness.snapshot().approvalWait).toBe(true);
    expect(harness.admit(request({ baseRevision: 2 })))
      .toEqual({ outcome: "waiting_for_approval", revision: 2 });
    expect(harness.journal().map((entry) => entry.type)).toEqual([
      "approval.recorded",
      "approval.invalidated_operation_drift",
      "approval.recorded",
      "admission.waiting_for_approval",
    ]);
    expect(harness.journal()[1].details).toEqual({
      approvalId: "approval_1",
      priorOperationId: "operation_1",
      operationId: "operation_2",
      argumentDigest: "digest_a",
    });

    harness.recordApproval({
      approvalId: "approval_1",
      operationId: "operation_2",
      argumentDigest: "digest_a",
      decision: "approved",
    });
    expect(harness.snapshot().approvalWait).toBe(false);
    expect(harness.admit(request({
      requestId: "request_after",
      finalityId: "final_after",
      baseRevision: 2,
    }))).toMatchObject({ outcome: "sent", canonicalTurnId: "cturn_0001", revision: 3 });
  });

  it("requires the first delivery record to be pending before any mutation", () => {
    const harness = new FakeCanonicalChatHarness();
    expect(() => harness.recordDelivery({ responseId: "response_1", revision: 1, state: "complete" }))
      .toThrow(TypeError);
    expect(() => harness.recordDelivery({ responseId: "response_1", revision: 1, state: "interrupted" }))
      .toThrow(TypeError);
    expect(() => harness.recordDelivery({ responseId: "response_1", revision: 1, state: "unknown" }))
      .toThrow(TypeError);

    expect(harness.snapshot().deliveries).toEqual([]);
    expect(harness.journal()).toEqual([]);

    harness.recordDelivery({ responseId: "response_1", revision: 1, state: "pending" });
    harness.recordDelivery({ responseId: "response_1", revision: 2, state: "complete" });
    expect(harness.snapshot().deliveries).toEqual([
      { responseId: "response_1", revision: 2, state: "complete" },
    ]);
  });

  it("keeps waiting while any stored approval is pending, not only the latest", () => {
    const harness = new FakeCanonicalChatHarness();
    harness.recordApproval({
      approvalId: "approval_a",
      operationId: "operation_a",
      argumentDigest: "digest_a",
      decision: "pending",
    });
    harness.recordApproval({
      approvalId: "approval_b",
      operationId: "operation_b",
      argumentDigest: "digest_b",
      decision: "approved",
    });
    expect(harness.snapshot().approvalWait).toBe(true);

    harness.recordApproval({
      approvalId: "approval_a",
      operationId: "operation_a",
      argumentDigest: "digest_a",
      decision: "rejected",
    });
    expect(harness.snapshot().approvalWait).toBe(false);
  });

  it("rejects invalid inputs before mutating any state", () => {
    const harness = new FakeCanonicalChatHarness();

    expect(() => harness.admit(request({ requestId: "x".repeat(161) }))).toThrow(RangeError);
    expect(() => harness.admit(request({ transcript: "t".repeat(8_001) }))).toThrow(RangeError);
    expect(() => harness.admit(request({ transcript: "😀".repeat(8_001) }))).toThrow(RangeError);
    expect(() => harness.admit(request({ localOrder: -1 }))).toThrow(RangeError);
    expect(() => harness.admit(request({ baseRevision: 1.5 }))).toThrow(TypeError);
    expect(() => harness.admit(request({ choice: "bogus" as never }))).toThrow(TypeError);
    expect(() => harness.admit(request({ source: "api" as never }))).toThrow(TypeError);
    expect(() => harness.recordApproval({
      approvalId: "a".repeat(161),
      operationId: "operation_1",
      argumentDigest: "digest",
      decision: "pending",
    })).toThrow(RangeError);
    expect(() => harness.recordApproval({
      approvalId: "approval_1",
      operationId: "operation_1",
      argumentDigest: "digest",
      decision: "maybe" as never,
    })).toThrow(TypeError);
    expect(() => harness.recordOperation({
      operationId: "operation_1",
      idempotencyKey: "key_1",
      state: "exploded" as never,
    })).toThrow(TypeError);
    expect(() => harness.recordDelivery({ responseId: "response_1", revision: -1, state: "pending" }))
      .toThrow(RangeError);
    expect(() => harness.appendAssistantEvent({
      runId: "run_1",
      eventId: "event_1",
      kind: "shell" as never,
    })).toThrow(TypeError);

    expect(harness.snapshot()).toMatchObject({ revision: 0, admittedRequestIds: [] });
    expect(harness.journal()).toEqual([]);
  });

  it("fails closed when collections or the journal exceed their caps", () => {
    const harness = new FakeCanonicalChatHarness();
    for (let index = 0; index < 512; index += 1) {
      harness.appendAssistantEvent({
        runId: `run_${index}`,
        eventId: `event_${index}`,
        kind: "text",
      });
    }
    expect(() => harness.appendAssistantEvent({
      runId: "run_over",
      eventId: "event_over",
      kind: "text",
    })).toThrow(RangeError);
    expect(() => harness.admit(request())).toThrow(RangeError);

    const admissions = new FakeCanonicalChatHarness();
    for (let index = 0; index < 512; index += 1) {
      admissions.admit(request({
        requestId: `request_${index}`,
        finalityId: `final_${index}`,
        baseRevision: index,
      }));
    }
    expect(() => admissions.admit(request({
      requestId: "request_over",
      finalityId: "final_over",
      baseRevision: 512,
    }))).toThrow(RangeError);
    expect(admissions.snapshot().admittedRequestIds).toHaveLength(512);
  });

  it("produces deep-equal durable state for identical deterministic scripts", () => {
    const runScript = () => {
      const harness = new FakeCanonicalChatHarness({ revision: 7, activeRunId: "run_7" });
      harness.admit(request({ baseRevision: 7, choice: "steer" }));
      harness.appendAssistantEvent({ runId: "run_7", eventId: "event_text", kind: "text" });
      harness.appendAssistantEvent({ runId: "run_7", eventId: "event_result", kind: "result" });
      harness.recordApproval({ approvalId: "approval_7", operationId: "operation_7", argumentDigest: "digest_7", decision: "approved" });
      harness.recordOperation({ operationId: "operation_7", idempotencyKey: "once_7", state: "succeeded" });
      harness.recordDelivery({ responseId: "response_7", revision: 1, state: "pending" });
      harness.recordDelivery({ responseId: "response_7", revision: 2, state: "complete" });
      return harness.restart();
    };

    const first = runScript();
    const second = runScript();
    expect(first.snapshot()).toEqual(second.snapshot());
    expect(first.journal()).toEqual(second.journal());
    expect(first.snapshot()).not.toBe(second.snapshot());
    expect(first.journal()).not.toBe(second.journal());
    expect(first.snapshot().activeRunId).toBeNull();
  });
});
