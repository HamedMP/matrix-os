import {
  FAKE_CANONICAL_LIMITS,
  isRecord,
  requireCapacity,
  requireEnum,
  requireIdentifier,
  requireNonNegativeSafeInteger,
  requireTranscript,
} from "./harness-validation.js";

export { FAKE_CANONICAL_LIMITS } from "./harness-validation.js";

export type FakeAdmissionChoice = "send" | "queue" | "steer" | "reject";

export interface FakeCanonicalAdmissionRequest {
  requestId: string;
  finalityId: string;
  source: "voice" | "typed";
  localOrder: number;
  baseRevision: number;
  routeId: string;
  interactionMode: string;
  permissionMode: string;
  memoryMode: "ordinary" | "session_only";
  choice: FakeAdmissionChoice;
  transcript: string;
}

export interface FakeCanonicalJournalEntry {
  sequence: number;
  type: string;
  details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface FakeCanonicalSnapshot {
  revision: number;
  activeRunId: string | null;
  approvalWait: boolean;
  admittedRequestIds: readonly string[];
  queuedRequestIds: readonly string[];
  operations: readonly {
    operationId: string;
    state: "running" | "succeeded" | "failed" | "cancelled" | "outcome_unknown";
  }[];
  deliveries: readonly {
    responseId: string;
    state: "pending" | "complete" | "interrupted" | "unknown";
    revision: number;
  }[];
}

export type FakeAdmissionOutcome =
  | "sent"
  | "queued"
  | "steered"
  | "rejected"
  | "duplicate"
  | "stale_revision"
  | "waiting_for_approval";

export type AdmissionResult = {
  outcome: FakeAdmissionOutcome;
  canonicalTurnId?: string;
  runId?: string;
  revision: number;
};

type OperationState = FakeCanonicalSnapshot["operations"][number]["state"];
type DeliveryState = FakeCanonicalSnapshot["deliveries"][number]["state"];

const APPROVAL_BOUND_OPERATION_STATES: ReadonlySet<OperationState> = new Set([
  "running",
  "succeeded",
  "failed",
  "outcome_unknown",
]);
const TERMINAL_DELIVERY_STATES: ReadonlySet<DeliveryState> = new Set([
  "complete",
  "interrupted",
  "unknown",
]);

interface AdmissionRecord {
  requestId: string;
  finalityId: string;
  result: AdmissionResult;
}

interface QueuedTurn {
  requestId: string;
  canonicalTurnId: string;
}

interface ApprovalRecord {
  approvalId: string;
  operationId: string;
  argumentDigest: string;
  decision: "pending" | "approved" | "rejected";
}

interface OperationRecord {
  operationId: string;
  idempotencyKey: string;
  argumentDigest: string;
  consequential: boolean;
  state: OperationState;
}

interface DeliveryRecord {
  responseId: string;
  revision: number;
  state: DeliveryState;
}

function assertAdmissionRequest(request: FakeCanonicalAdmissionRequest): void {
  if (!isRecord(request)) {
    throw new TypeError("admission request must be an object");
  }
  requireIdentifier(request.requestId, "requestId");
  requireIdentifier(request.finalityId, "finalityId");
  requireEnum(request.source, "source", ["voice", "typed"]);
  requireNonNegativeSafeInteger(request.localOrder, "localOrder");
  requireNonNegativeSafeInteger(request.baseRevision, "baseRevision");
  requireIdentifier(request.routeId, "routeId");
  requireIdentifier(request.interactionMode, "interactionMode");
  requireIdentifier(request.permissionMode, "permissionMode");
  requireEnum(request.memoryMode, "memoryMode", ["ordinary", "session_only"]);
  requireEnum(request.choice, "choice", ["send", "queue", "steer", "reject"]);
  requireTranscript(request.transcript, "transcript");
}

export class FakeCanonicalChatHarness {
  private revision: number;
  private activeRunId: string | null;
  private approvalWait: boolean;
  private acceptedTurnCount = 0;
  private acceptedRunCount = 0;
  private queuedTurns: QueuedTurn[] = [];
  private terminalRunIds: string[] = [];
  private admissions: AdmissionRecord[] = [];
  private admittedRequestIds: string[] = [];
  private assistantEventIds: string[] = [];
  private approvals: ApprovalRecord[] = [];
  private operations: OperationRecord[] = [];
  private deliveries: DeliveryRecord[] = [];
  private journalEntries: FakeCanonicalJournalEntry[] = [];
  private nextJournalSequence = 1;

  constructor(seed: { revision?: number; activeRunId?: string | null; approvalWait?: boolean } = {}) {
    this.revision = seed.revision ?? 0;
    this.activeRunId = seed.activeRunId ?? null;
    this.approvalWait = seed.approvalWait ?? false;
  }

  admit(request: FakeCanonicalAdmissionRequest): AdmissionResult {
    assertAdmissionRequest(request);

    const prior = this.admissions.find(
      (record) => record.requestId === request.requestId || record.finalityId === request.finalityId,
    );
    if (prior) return { ...prior.result };

    // Queue and steer requests deliberately defer revision validation: a queued
    // turn re-reads Chat at dispatch and a steer targets the live run. Ordinary
    // sends and rejects still fail closed on a stale base revision.
    const revisionCheckedNow = request.choice === "send"
      || request.choice === "reject"
      || (request.choice === "steer" && this.activeRunId === null);
    if (revisionCheckedNow && request.baseRevision !== this.revision) {
      return this.rememberAdmission(request, { outcome: "stale_revision", revision: this.revision }, "admission.stale_revision");
    }

    if (this.approvalWait) {
      return this.rememberAdmission(
        request,
        { outcome: "waiting_for_approval", revision: this.revision },
        "admission.waiting_for_approval",
      );
    }

    const outcome = this.admissionOutcome(request.choice);
    if (outcome === "rejected") {
      return this.rememberAdmission(request, { outcome, revision: this.revision }, "admission.rejected");
    }

    requireCapacity(this.admittedRequestIds, "admittedRequestIds");
    this.assertAdmissionCapacity();
    this.acceptedTurnCount += 1;
    this.revision += 1;
    const canonicalTurnId = `cturn_${String(this.acceptedTurnCount).padStart(4, "0")}`;
    const result: AdmissionResult = {
      outcome,
      canonicalTurnId,
      revision: this.revision,
    };
    if (outcome === "sent") {
      result.runId = this.startRun();
    } else if (outcome === "steered") {
      result.runId = this.activeRunId ?? undefined;
    } else if (outcome === "queued") {
      requireCapacity(this.queuedTurns, "queuedTurns");
      this.queuedTurns.push({ requestId: request.requestId, canonicalTurnId });
    }
    this.admittedRequestIds.push(request.requestId);
    return this.rememberAdmission(request, result, "admission.accepted");
  }

  flushReorderedFinals(
    requests: readonly FakeCanonicalAdmissionRequest[],
  ): readonly ReturnType<FakeCanonicalChatHarness["admit"]>[] {
    const ordered: FakeCanonicalAdmissionRequest[] = [];
    let pendingVoice: Array<{ request: FakeCanonicalAdmissionRequest; inputOrder: number }> = [];
    const flushVoice = () => {
      pendingVoice.sort((left, right) => left.request.localOrder - right.request.localOrder
        || left.request.requestId.localeCompare(right.request.requestId)
        || left.request.finalityId.localeCompare(right.request.finalityId)
        || left.inputOrder - right.inputOrder);
      ordered.push(...pendingVoice.map(({ request }) => request));
      pendingVoice = [];
    };

    requests.forEach((request, inputOrder) => {
      if (request.source === "voice") {
        pendingVoice.push({ request, inputOrder });
        return;
      }
      flushVoice();
      ordered.push(request);
    });
    flushVoice();
    return ordered.map((request) => this.admit(request));
  }

  appendAssistantEvent(input: {
    runId: string;
    eventId: string;
    kind: "text" | "tool" | "approval" | "result";
    label?: string;
  }): void {
    requireIdentifier(input.runId, "runId");
    requireIdentifier(input.eventId, "eventId");
    requireEnum(input.kind, "kind", ["text", "tool", "approval", "result"]);
    if (input.label !== undefined) requireIdentifier(input.label, "label");
    if (this.assistantEventIds.includes(input.eventId)) return;

    const recordsTerminal =
      input.kind === "result" && !this.terminalRunIds.includes(input.runId);
    requireCapacity(this.assistantEventIds, "assistantEventIds");
    if (recordsTerminal) requireCapacity(this.terminalRunIds, "terminalRunIds");
    this.assertJournalCapacity(1);

    this.assistantEventIds.push(input.eventId);
    const details: Record<string, string | number | boolean | null> = {
      runId: input.runId,
      eventId: input.eventId,
    };
    if (input.label !== undefined) details.label = input.label;
    this.appendJournal(`assistant.${input.kind}`, details);
    if (recordsTerminal) {
      this.terminalRunIds.push(input.runId);
      if (this.activeRunId === input.runId) {
        this.activeRunId = null;
        this.promoteQueuedTurn();
      }
    }
  }

  recordApproval(input: {
    approvalId: string;
    operationId: string;
    argumentDigest: string;
    decision: "pending" | "approved" | "rejected";
  }): void {
    requireIdentifier(input.approvalId, "approvalId");
    requireIdentifier(input.operationId, "operationId");
    requireIdentifier(input.argumentDigest, "argumentDigest");
    requireEnum(input.decision, "decision", ["pending", "approved", "rejected"]);

    const index = this.approvals.findIndex((approval) => approval.approvalId === input.approvalId);
    const prior = index < 0 ? undefined : this.approvals[index];
    const digestDrifted = prior !== undefined && prior.argumentDigest !== input.argumentDigest;
    const operationDrifted = prior !== undefined && prior.operationId !== input.operationId;
    if (!digestDrifted
      && !operationDrifted
      && prior?.decision === input.decision
    ) {
      return;
    }

    const invalidations = (digestDrifted ? 1 : 0) + (operationDrifted ? 1 : 0);
    if (index < 0) requireCapacity(this.approvals, "approvals");
    this.assertJournalCapacity(1 + invalidations);

    let decision = input.decision;
    if (digestDrifted && prior !== undefined) {
      this.appendJournal("approval.invalidated_digest_drift", {
        approvalId: input.approvalId,
        operationId: input.operationId,
        priorArgumentDigest: prior.argumentDigest,
        argumentDigest: input.argumentDigest,
      });
      decision = "pending";
    }
    if (operationDrifted && prior !== undefined) {
      this.appendJournal("approval.invalidated_operation_drift", {
        approvalId: input.approvalId,
        priorOperationId: prior.operationId,
        operationId: input.operationId,
        argumentDigest: input.argumentDigest,
      });
      decision = "pending";
    }

    const record: ApprovalRecord = { ...input, decision };
    if (index < 0) this.approvals.push(record);
    else this.approvals[index] = record;
    this.approvalWait = this.approvals.some((approval) => approval.decision === "pending");
    this.appendJournal("approval.recorded", {
      approvalId: input.approvalId,
      operationId: input.operationId,
      argumentDigest: input.argumentDigest,
      decision,
    });
  }

  recordOperation(input: {
    operationId: string;
    idempotencyKey: string;
    argumentDigest: string;
    consequential: boolean;
    state: OperationState;
  }): void {
    requireIdentifier(input.operationId, "operationId");
    requireIdentifier(input.idempotencyKey, "idempotencyKey");
    requireIdentifier(input.argumentDigest, "argumentDigest");
    if (typeof input.consequential !== "boolean") {
      throw new TypeError("consequential must be a boolean");
    }
    requireEnum(input.state, "state", ["running", "succeeded", "failed", "cancelled", "outcome_unknown"]);

    const keyIndex = this.operations.findIndex(
      (operation) => operation.idempotencyKey === input.idempotencyKey,
    );
    if (keyIndex >= 0) {
      const prior = this.operations[keyIndex];
      if (
        prior.operationId !== input.operationId
        || prior.state === input.state
        || prior.state === "outcome_unknown"
      ) return;
      if (!this.assertExecutionApproved(input)) return;
      this.assertJournalCapacity(1);
      prior.state = input.state;
      this.appendJournal("operation.updated", {
        operationId: prior.operationId,
        idempotencyKey: prior.idempotencyKey,
        argumentDigest: prior.argumentDigest,
        state: prior.state,
      });
      return;
    }
    if (this.operations.some((operation) => operation.operationId === input.operationId)) return;

    if (!this.assertExecutionApproved(input)) return;
    requireCapacity(this.operations, "operations");
    this.assertJournalCapacity(1);
    this.operations.push({ ...input });
    this.appendJournal("operation.recorded", {
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      argumentDigest: input.argumentDigest,
      state: input.state,
    });
  }

  recordDelivery(input: {
    responseId: string;
    revision: number;
    state: DeliveryState;
  }): void {
    requireIdentifier(input.responseId, "responseId");
    requireNonNegativeSafeInteger(input.revision, "revision");
    requireEnum(input.state, "state", ["pending", "complete", "interrupted", "unknown"]);

    const index = this.deliveries.findIndex((delivery) => delivery.responseId === input.responseId);
    const prior = index < 0 ? undefined : this.deliveries[index];
    if (prior === undefined && input.state !== "pending") {
      throw new TypeError("first delivery record must be pending");
    }
    if (prior !== undefined && input.revision <= prior.revision) return;
    if (prior !== undefined && TERMINAL_DELIVERY_STATES.has(prior.state)) {
      this.assertJournalCapacity(1);
      this.appendJournal("delivery.terminal_ignored", {
        responseId: input.responseId,
        revision: input.revision,
        state: input.state,
        priorState: prior.state,
      });
      return;
    }

    if (index < 0) requireCapacity(this.deliveries, "deliveries");
    this.assertJournalCapacity(1);
    const record: DeliveryRecord = { ...input };
    if (index < 0) this.deliveries.push(record);
    else this.deliveries[index] = record;
    this.appendJournal("delivery.recorded", {
      responseId: input.responseId,
      revision: input.revision,
      state: input.state,
    });
  }

  restart(): FakeCanonicalChatHarness {
    const activeRunIsTerminal = this.activeRunId !== null
      && this.terminalRunIds.includes(this.activeRunId);
    const restarted = new FakeCanonicalChatHarness({
      revision: this.revision,
      activeRunId: activeRunIsTerminal ? null : this.activeRunId,
      approvalWait: this.approvalWait,
    });
    restarted.acceptedTurnCount = this.acceptedTurnCount;
    restarted.acceptedRunCount = this.acceptedRunCount;
    restarted.queuedTurns = this.queuedTurns.map((turn) => ({ ...turn }));
    restarted.terminalRunIds = [...this.terminalRunIds];
    restarted.admissions = this.admissions.map((record) => ({
      requestId: record.requestId,
      finalityId: record.finalityId,
      result: { ...record.result },
    }));
    restarted.admittedRequestIds = [...this.admittedRequestIds];
    restarted.assistantEventIds = [...this.assistantEventIds];
    restarted.approvals = this.approvals.map((approval) => ({ ...approval }));
    restarted.operations = this.operations.map((operation) => ({ ...operation }));
    restarted.deliveries = this.deliveries.map((delivery) => ({ ...delivery }));
    restarted.journalEntries = this.journalEntries.map((entry) => ({
      sequence: entry.sequence,
      type: entry.type,
      details: { ...entry.details },
    }));
    restarted.nextJournalSequence = this.nextJournalSequence;
    restarted.promoteQueuedTurn();
    return restarted;
  }

  snapshot(): FakeCanonicalSnapshot {
    return {
      revision: this.revision,
      activeRunId: this.activeRunId,
      approvalWait: this.approvalWait,
      admittedRequestIds: [...this.admittedRequestIds],
      queuedRequestIds: this.queuedTurns.map((turn) => turn.requestId),
      operations: this.operations.map(({ operationId, state }) => ({ operationId, state })),
      deliveries: this.deliveries.map(({ responseId, state, revision }) => ({
        responseId,
        state,
        revision,
      })),
    };
  }

  journal(): readonly FakeCanonicalJournalEntry[] {
    return this.journalEntries.map((entry) => ({
      sequence: entry.sequence,
      type: entry.type,
      details: { ...entry.details },
    }));
  }

  private admissionOutcome(choice: FakeAdmissionChoice): "sent" | "queued" | "steered" | "rejected" {
    if (choice === "reject") return "rejected";
    if (this.activeRunId !== null && choice === "send") return "rejected";
    if (choice === "queue") return "queued";
    if (choice === "steer" && this.activeRunId !== null) return "steered";
    return "sent";
  }

  private startRun(): string {
    this.acceptedRunCount += 1;
    const runId = `run_${String(this.acceptedRunCount).padStart(4, "0")}`;
    this.activeRunId = runId;
    return runId;
  }

  private promoteQueuedTurn(): void {
    if (this.activeRunId !== null || this.queuedTurns.length === 0) return;
    const next = this.queuedTurns.shift();
    if (next === undefined) return;
    const record = this.admissions.find((admission) => admission.requestId === next.requestId);
    this.revision += 1;
    const result: AdmissionResult = {
      outcome: "sent",
      canonicalTurnId: next.canonicalTurnId,
      runId: this.startRun(),
      revision: this.revision,
    };
    if (record !== undefined) record.result = { ...result };
    this.appendJournal("admission.queue_promoted", {
      requestId: next.requestId,
      canonicalTurnId: next.canonicalTurnId,
      runId: result.runId ?? null,
      revision: this.revision,
    });
  }

  private assertExecutionApproved(input: {
    operationId: string;
    idempotencyKey: string;
    argumentDigest: string;
    consequential: boolean;
    state: OperationState;
  }): boolean {
    if (!input.consequential || !APPROVAL_BOUND_OPERATION_STATES.has(input.state)) {
      return true;
    }
    const approved = this.approvals.some(
      (approval) => approval.operationId === input.operationId
        && approval.argumentDigest === input.argumentDigest
        && approval.decision === "approved",
    );
    if (approved) return true;
    this.assertJournalCapacity(1);
    this.appendJournal("operation.unapproved_rejected", {
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      argumentDigest: input.argumentDigest,
      state: input.state,
    });
    return false;
  }

  private assertAdmissionCapacity(): void {
    requireCapacity(this.admissions, "admissions");
    this.assertJournalCapacity(1);
  }

  private assertJournalCapacity(entries = 1): void {
    if (this.journalEntries.length + entries > FAKE_CANONICAL_LIMITS.maxJournalEntries) {
      throw new RangeError(`journal exceeds ${FAKE_CANONICAL_LIMITS.maxJournalEntries} entries`);
    }
  }

  private rememberAdmission(
    request: FakeCanonicalAdmissionRequest,
    result: AdmissionResult,
    eventType: string,
  ): AdmissionResult {
    this.assertAdmissionCapacity();
    this.admissions.push({
      requestId: request.requestId,
      finalityId: request.finalityId,
      result: { ...result },
    });
    const details: Record<string, string | number | boolean | null> = {
      requestId: request.requestId,
      finalityId: request.finalityId,
      source: request.source,
      localOrder: request.localOrder,
      baseRevision: request.baseRevision,
      routeId: request.routeId,
      interactionMode: request.interactionMode,
      permissionMode: request.permissionMode,
      memoryMode: request.memoryMode,
      choice: request.choice,
      textLength: request.transcript.length,
      outcome: result.outcome,
      revision: result.revision,
    };
    if (result.canonicalTurnId !== undefined) {
      details.canonicalTurnId = result.canonicalTurnId;
    }
    if (result.runId !== undefined) {
      details.runId = result.runId;
    }
    this.appendJournal(eventType, details);
    return { ...result };
  }

  private appendJournal(
    type: string,
    details: Readonly<Record<string, string | number | boolean | null>>,
  ): void {
    this.assertJournalCapacity(1);
    this.journalEntries.push({
      sequence: this.nextJournalSequence,
      type,
      details: { ...details },
    });
    this.nextJournalSequence += 1;
  }
}
