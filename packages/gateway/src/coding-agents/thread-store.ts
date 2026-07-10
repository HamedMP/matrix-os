import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  AdoptAgentThreadResponseSchema,
  AgentThreadEventSchema,
  AgentThreadSnapshotSchema,
  AgentThreadSummarySchema,
  AgentTurnIdSchema,
  AgentTurnStatusSchema,
  ApprovalIdSchema,
  CreateAgentTurnRequestSchema,
  CreateAgentTurnResponseSchema,
  IsoTimestampSchema,
  ProviderIdSchema,
  RequestIdSchema,
  SafeClientErrorSchema,
  TerminalSessionIdSchema,
  type AgentThreadEvent,
  type AgentThreadSummary,
  type AdoptAgentThreadRequest,
  type AdoptAgentThreadResponse,
  type ApprovalDecisionRequest,
  type CreateAgentThreadRequest,
  type CreateAgentTurnRequest,
  type CreateAgentTurnResponse,
  type UserInputAnswerRequest,
} from "@matrix-os/contracts";
import { atomicWriteJson } from "../state-ops.js";
import type { RequestPrincipal } from "../request-principal.js";
import { logCodingAgentWarning } from "./diagnostics.js";
import {
  CodingAgentProjectWorkspaceError,
  type CodingAgentProjectThreadProjection,
  type CodingAgentProjectWorkspaceQuery,
  type CodingAgentTaskThreadAggregate,
} from "./project-workspace.js";
import {
  CodingAgentThreadRelationError,
  type CodingAgentThreadRelationValidator,
} from "./thread-relations.js";
import {
  CodingAgentProviderResumeStateSchema,
  parseCodingAgentProviderEvents,
  parseCodingAgentProviderRunResult,
  type CodingAgentProviderAdapter,
  type CodingAgentProviderResumeState,
} from "./provider-adapter.js";
import { createCodingAgentTurnDispatcher } from "./turn-dispatcher.js";
import {
  deriveThreadProjectionChanges,
  publishThreadProjectionChanges,
  type CodingAgentThreadProjectionPublisher,
} from "./thread-projection.js";

export type {
  CodingAgentThreadProjectionChange,
  CodingAgentThreadProjectionPublisher,
} from "./thread-projection.js";

export type {
  CodingAgentProviderAdapter,
  CodingAgentProviderResumeState,
  CodingAgentProviderRunResult,
} from "./provider-adapter.js";

const THREAD_STORE_RELATIVE_PATH = ["system", "coding-agents", "threads.json"] as const;
const THREAD_LIST_LIMIT = 50;
const EVENT_REPLAY_LIMIT = 200;
const MAX_STORED_THREADS = 200;
const MAX_EVENTS_PER_THREAD = 500;
const MAX_ABORT_REQUEST_IDS = 50;
const MAX_APPROVAL_DECISION_REQUEST_IDS = 50;
const MAX_INPUT_ANSWER_REQUEST_IDS = 50;
const MAX_PENDING_TERMINAL_STOPS = 100;
// Retain bounded request payloads for dispatch/idempotency. At the shared
// 96 KiB request limit, this caps worst-case turn payload storage below 10 MiB.
const MAX_STORED_TURNS = 100;
const MAX_TURNS_PER_THREAD = 50;

const OwnerIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/);
const WorkspaceSessionIdSchema = z.string().min(1).max(160).regex(/^sess_[A-Za-z0-9_-]+$/);

const StoredThreadSchema = AgentThreadSummarySchema.extend({
  ownerId: OwnerIdSchema,
  clientRequestId: RequestIdSchema,
  abortClientRequestIds: z.array(RequestIdSchema).max(MAX_ABORT_REQUEST_IDS).default([]),
  approvalDecisionClientRequestIds: z.array(RequestIdSchema).max(MAX_APPROVAL_DECISION_REQUEST_IDS).default([]),
  inputAnswerClientRequestIds: z.array(RequestIdSchema).max(MAX_INPUT_ANSWER_REQUEST_IDS).default([]),
  activeTurnId: AgentTurnIdSchema.optional(),
  providerResumeState: CodingAgentProviderResumeStateSchema.optional(),
}).strict();

const StoredTurnSchema = z.object({
  message: CreateAgentTurnRequestSchema.shape.message.optional(),
  attachments: CreateAgentTurnRequestSchema.shape.attachments,
  clientRequestId: CreateAgentTurnRequestSchema.shape.clientRequestId,
  ownerId: OwnerIdSchema,
  threadId: AgentThreadSummarySchema.shape.id,
  turnId: AgentTurnIdSchema,
  status: AgentTurnStatusSchema,
  acceptedAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict().superRefine((turn, context) => {
  if ((turn.status === "accepted" || turn.status === "running") && !turn.message) {
    context.addIssue({ code: "custom", message: "Active turns require a message" });
  }
});

const TerminalSessionStoppedReconciliationSchema = z.object({
  ownerId: OwnerIdSchema,
  workspaceSessionId: WorkspaceSessionIdSchema.optional(),
  terminalSessionId: TerminalSessionIdSchema,
  runtimeStatus: z.enum(["starting", "running", "idle", "waiting", "exited", "failed", "degraded"]),
}).strict();
const TerminalStoppedStatusSchema = z.enum(["exited", "failed", "degraded"]);
const PendingTerminalStopSchema = z.object({
  ownerId: OwnerIdSchema,
  workspaceSessionId: WorkspaceSessionIdSchema.optional(),
  terminalSessionId: TerminalSessionIdSchema,
  runtimeStatus: TerminalStoppedStatusSchema,
  occurredAt: IsoTimestampSchema,
}).strict();

const StoredThreadStateSchema = z.object({
  version: z.literal(1),
  threads: z.array(StoredThreadSchema).max(MAX_STORED_THREADS),
  events: z.array(AgentThreadEventSchema).max(MAX_STORED_THREADS * MAX_EVENTS_PER_THREAD),
  turns: z.array(StoredTurnSchema).max(MAX_STORED_TURNS).default([]),
  pendingTerminalStops: z.array(PendingTerminalStopSchema).max(MAX_PENDING_TERMINAL_STOPS).default([]),
}).strict();

type StoredThread = z.infer<typeof StoredThreadSchema>;
type StoredThreadState = z.infer<typeof StoredThreadStateSchema>;
type StoredTurn = z.infer<typeof StoredTurnSchema>;
type TurnAcceptMutationResult = {
  response: CreateAgentTurnResponse;
  eventsToPublish: AgentThreadEvent[];
  dispatch?: { thread: StoredThread; turn: StoredTurn };
};
type PendingTerminalStop = z.infer<typeof PendingTerminalStopSchema>;
type AgentThreadSnapshot = z.infer<typeof AgentThreadSnapshotSchema>;
type ThreadCreateResult = { snapshot: AgentThreadSnapshot; existing: boolean };
type ThreadCreateMutationResult = ThreadCreateResult & { eventsToPublish: AgentThreadEvent[] };
type TerminalSessionStoppedReconciliation = z.infer<typeof TerminalSessionStoppedReconciliationSchema>;
type ThreadEventSink = (input: {
  ownerId: string;
  threadId: string;
  events: AgentThreadEvent[];
}) => void;

export interface CodingAgentThreadStoreOptions {
  homePath: string;
  now?: () => Date;
  providers: CodingAgentProviderAdapter[];
  relationValidator?: CodingAgentThreadRelationValidator;
  projectionPublisher?: CodingAgentThreadProjectionPublisher;
  maxTurnDispatches?: number;
  turnDispatchTimeoutMs?: number;
}

export interface CodingAgentThreadStore {
  createThread(principal: RequestPrincipal, request: CreateAgentThreadRequest): Promise<ThreadCreateResult>;
  createShellThread(principal: RequestPrincipal, request: CreateAgentThreadRequest): Promise<ThreadCreateResult>;
  adoptLegacyThread(
    principal: RequestPrincipal,
    threadId: string,
    request: AdoptAgentThreadRequest,
  ): Promise<AdoptAgentThreadResponse>;
  listThreads(principal: RequestPrincipal): Promise<{ items: AgentThreadSummary[]; hasMore: boolean; limit: number }>;
  listAttentionThreads(principal: RequestPrincipal): Promise<{ items: AgentThreadSummary[]; hasMore: boolean; limit: number }>;
  listProjectCounts(principal: RequestPrincipal): Promise<Array<{
    projectId: string;
    threadCount: number;
    attentionCount: number;
  }>>;
  getProjectWorkspaceThreads(
    principal: RequestPrincipal,
    projectId: string,
    query: CodingAgentProjectWorkspaceQuery,
    validTaskIds: readonly string[],
  ): Promise<CodingAgentProjectThreadProjection>;
  getThread(principal: RequestPrincipal, threadId: string, cursor?: string): Promise<AgentThreadSnapshot>;
  abortThread(principal: RequestPrincipal, threadId: string, clientRequestId: string): Promise<AgentThreadSnapshot>;
  submitApproval(
    principal: RequestPrincipal,
    threadId: string,
    approvalId: string,
    request: ApprovalDecisionRequest,
  ): Promise<AgentThreadSnapshot>;
  submitInput(
    principal: RequestPrincipal,
    threadId: string,
    inputRequestId: string,
    request: UserInputAnswerRequest,
  ): Promise<AgentThreadSnapshot>;
  reconcileTerminalSessionStopped(input: TerminalSessionStoppedReconciliation): Promise<AgentThreadSnapshot[]>;
  registerEventSink(sink: ThreadEventSink): { dispose(): void };
}

export interface CodingAgentTurnStore {
  acceptTurn(
    principal: RequestPrincipal,
    threadId: string,
    request: CreateAgentTurnRequest,
  ): Promise<CreateAgentTurnResponse>;
  recoverActiveTurns(): Promise<void>;
  shutdownTurns(): Promise<void>;
}

export class CodingAgentThreadError extends Error {
  constructor(
    readonly code: "provider_unavailable" | "thread_not_found" | "thread_store_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "CodingAgentThreadError";
  }
}

export class CodingAgentTurnError extends Error {
  constructor(readonly code: "thread_busy" | "thread_not_found" | "turn_unavailable") {
    super(code);
    this.name = "CodingAgentTurnError";
  }
}

export function createFakeCodingAgentProvider(options: { providerId: string; deltaCount?: number }): CodingAgentProviderAdapter {
  const providerId = ProviderIdSchema.parse(options.providerId);
  const deltaCount = Math.max(1, Math.min(options.deltaCount ?? 1, 300));
  return {
    providerId,
    getSummary({ now }) {
      const checkedAt = now().toISOString();
      return {
        id: providerId,
        displayName: providerId === "codex" ? "Codex" : "Coding agent",
        kind: providerId === "codex" ? "codex" : "custom",
        availability: "available",
        installStatus: "installed",
        authStatus: "authenticated",
        supportedModes: ["default", "review"],
        defaultMode: "default",
        setupActions: [],
        lastCheckedAt: checkedAt,
      };
    },
    healthCheck() {
      return { ok: true };
    },
    buildSetupAction() {
      return [];
    },
    startThread({ thread, now, nextEventId }) {
      return {
        events: [{
          type: "thread.status",
          eventId: nextEventId(),
          threadId: thread.id,
          occurredAt: now().toISOString(),
          status: "running",
        },
        ...Array.from({ length: deltaCount }, (_, index) => ({
          type: "assistant.text.delta",
          eventId: nextEventId(),
          threadId: thread.id,
          occurredAt: now().toISOString(),
          messageId: "msg_fake_provider_started",
          delta: index === 0 ? "Agent run started." : `Agent event ${index + 1}.`,
        } satisfies AgentThreadEvent)),
        ],
        resumeState: { conversationId: `conversation_${thread.id}` },
      };
    },
    resumeTurn({ thread, turn, resumeState, now, nextEventId }) {
      return {
        events: [AgentThreadEventSchema.parse({
          type: "assistant.text.delta",
          eventId: nextEventId(),
          threadId: thread.id,
          occurredAt: now().toISOString(),
          messageId: `msg_${turn.turnId}`,
          delta: "Agent turn completed.",
        })],
        resumeState,
        outcome: "completed",
      };
    },
    abortThread({ thread, now, nextEventId }) {
      return defaultAbortEvents(thread.id, now, nextEventId);
    },
    submitApproval() {
      return [];
    },
    submitInput() {
      return [];
    },
  };
}

function emptyState(): StoredThreadState {
  return { version: 1, threads: [], events: [], turns: [], pendingTerminalStops: [] };
}

function statePath(homePath: string): string {
  return join(homePath, ...THREAD_STORE_RELATIVE_PATH);
}

async function readState(homePath: string): Promise<StoredThreadState> {
  try {
    const raw = await readFile(statePath(homePath), "utf-8");
    const parsed = StoredThreadStateSchema.parse(JSON.parse(raw));
    return {
      ...parsed,
      threads: parsed.threads.map(normalizeThreadAttention),
    };
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyState();
    }
    throw err;
  }
}

async function writeState(homePath: string, state: StoredThreadState): Promise<void> {
  await atomicWriteJson(statePath(homePath), StoredThreadStateSchema.parse(state));
}

function nextThreadId(): string {
  return `thread_${randomUUID()}`;
}

function nextEventId(): string {
  return `evt_${randomUUID()}`;
}

function genericTitle(): string {
  return "Coding agent run";
}

function applyEvent(thread: StoredThread, event: AgentThreadEvent): StoredThread {
  const updatedAt = event.occurredAt;
  if (event.type === "thread.status") {
    return normalizeThreadAttention({ ...thread, status: event.status, updatedAt });
  }
  if (event.type === "thread.completed") {
    return {
      ...thread,
      status: event.outcome === "completed" ? "completed" : event.outcome === "aborted" ? "aborted" : "failed",
      attention: event.outcome === "failed" ? "failed" : "none",
      updatedAt,
    };
  }
  if (event.type === "approval.requested") {
    return { ...thread, status: "waiting_for_approval", attention: "approval_required", updatedAt };
  }
  if (event.type === "user_input.requested") {
    return { ...thread, status: "waiting_for_input", attention: "input_required", updatedAt };
  }
  if (event.type === "approval.resolved" || event.type === "user_input.answered") {
    return { ...thread, status: "running", attention: "none", updatedAt };
  }
  if (event.type === "terminal.bound") {
    return { ...thread, terminalSessionId: event.terminalSessionId, updatedAt };
  }
  if (event.type === "thread.error") {
    return { ...thread, status: "failed", attention: "failed", updatedAt };
  }
  return { ...thread, updatedAt };
}

function snapshotFor(thread: StoredThread, allEvents: AgentThreadEvent[], cursor?: string): AgentThreadSnapshot {
  const eventsForThread = allEvents.filter((event) => event.threadId === thread.id);
  const cursorIndex = cursor ? eventsForThread.findIndex((event) => event.eventId === cursor) : -1;
  if (cursor && cursorIndex < 0) {
    throw new CodingAgentThreadError("thread_not_found", "Thread cursor not found");
  }
  const startIndex = cursor ? cursorIndex + 1 : Math.max(0, eventsForThread.length - EVENT_REPLAY_LIMIT);
  const window = eventsForThread.slice(startIndex, startIndex + EVENT_REPLAY_LIMIT);
  return AgentThreadSnapshotSchema.parse({
    thread: stripOwner(thread),
    events: {
      items: window,
      hasMore: cursor
        ? eventsForThread.length - Math.max(0, startIndex) > window.length
        : startIndex > 0,
      nextCursor: cursor ? window.at(-1)?.eventId : undefined,
      limit: EVENT_REPLAY_LIMIT,
    },
  });
}

function stripOwner(thread: StoredThread): AgentThreadSummary {
  const {
    ownerId: _ownerId,
    clientRequestId: _clientRequestId,
    abortClientRequestIds: _abortClientRequestIds,
    approvalDecisionClientRequestIds: _approvalDecisionClientRequestIds,
    inputAnswerClientRequestIds: _inputAnswerClientRequestIds,
    activeTurnId: _activeTurnId,
    providerResumeState: _providerResumeState,
    ...summary
  } = thread;
  return AgentThreadSummarySchema.parse(summary);
}

function trimState(state: StoredThreadState): StoredThreadState {
  const threads = state.threads
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, MAX_STORED_THREADS);
  const activeThreadIds = threads.map((thread) => thread.id);
  const eventCounts = Object.create(null) as Record<string, number>;
  const latestEvents: AgentThreadEvent[] = [];
  for (const event of state.events.slice().reverse()) {
    if (!activeThreadIds.includes(event.threadId)) continue;
    const count = eventCounts[event.threadId] ?? 0;
    if (count >= MAX_EVENTS_PER_THREAD) continue;
    eventCounts[event.threadId] = count + 1;
    latestEvents.push(event);
  }
  const events = latestEvents.reverse();
  const turnCounts = Object.create(null) as Record<string, number>;
  const latestTurns: StoredTurn[] = [];
  for (const turn of state.turns.slice().reverse()) {
    if (!activeThreadIds.includes(turn.threadId) || latestTurns.length >= MAX_STORED_TURNS) continue;
    const count = turnCounts[turn.threadId] ?? 0;
    if (count >= MAX_TURNS_PER_THREAD) continue;
    turnCounts[turn.threadId] = count + 1;
    latestTurns.push(turn);
  }
  const turns = latestTurns.reverse();
  return {
    version: 1,
    threads,
    events,
    turns,
    pendingTerminalStops: state.pendingTerminalStops.slice(-MAX_PENDING_TERMINAL_STOPS),
  };
}

function activeThread(thread: StoredThread): boolean {
  return !["completed", "failed", "aborted", "archived"].includes(thread.status);
}

function normalizeThreadAttention(thread: StoredThread): StoredThread {
  if (thread.status === "failed") return { ...thread, attention: "failed" };
  if (thread.status === "waiting_for_approval") return { ...thread, attention: "approval_required" };
  if (thread.status === "waiting_for_input") return { ...thread, attention: "input_required" };
  if (["queued", "starting", "running", "completed", "aborted", "archived"].includes(thread.status)) {
    return { ...thread, attention: "none" };
  }
  return thread;
}

function terminalThread(thread: StoredThread): boolean {
  return !activeThread(thread);
}

function attentionThread(thread: StoredThread): boolean {
  return thread.attention !== "none" && thread.status !== "archived";
}

function projectThreadPage(
  threads: StoredThread[],
  cursor: string | undefined,
  limit: number,
): { items: AgentThreadSummary[]; hasMore: boolean; nextCursor?: string; limit: number } {
  const cursorIndex = cursor ? threads.findIndex((thread) => thread.id === cursor) : -1;
  if (cursor && cursorIndex < 0) {
    throw new CodingAgentProjectWorkspaceError("invalid_cursor");
  }
  const startIndex = cursor ? cursorIndex + 1 : 0;
  const items = threads.slice(startIndex, startIndex + limit).map(stripOwner);
  const hasMore = startIndex + items.length < threads.length;
  return {
    items,
    hasMore,
    ...(hasMore && items.length > 0 ? { nextCursor: items.at(-1)!.id } : {}),
    limit,
  };
}

function taskThreadAggregates(threads: StoredThread[]): CodingAgentTaskThreadAggregate[] {
  const aggregates: CodingAgentTaskThreadAggregate[] = [];
  for (const thread of threads) {
    if (!thread.taskId) continue;
    let aggregate = aggregates.find((candidate) => candidate.taskId === thread.taskId);
    if (!aggregate) {
      aggregate = {
        taskId: thread.taskId,
        threadCount: 0,
        activeThreadCount: 0,
        attentionCount: 0,
        latestThreadAt: thread.updatedAt,
      };
      aggregates.push(aggregate);
    }
    aggregate.threadCount += 1;
    if (activeThread(thread)) aggregate.activeThreadCount += 1;
    if (attentionThread(thread)) aggregate.attentionCount += 1;
    if (!aggregate.latestThreadAt || thread.updatedAt > aggregate.latestThreadAt) {
      aggregate.latestThreadAt = thread.updatedAt;
    }
  }
  return aggregates.sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function stoppedRuntimeStatus(
  runtimeStatus: TerminalSessionStoppedReconciliation["runtimeStatus"],
): runtimeStatus is PendingTerminalStop["runtimeStatus"] {
  return TerminalStoppedStatusSchema.safeParse(runtimeStatus).success;
}

function appendPendingTerminalStop(
  pendingTerminalStops: PendingTerminalStop[],
  stop: PendingTerminalStop,
): PendingTerminalStop[] {
  return [
    ...pendingTerminalStops.filter((candidate) =>
      candidate.ownerId !== stop.ownerId ||
      candidate.workspaceSessionId !== stop.workspaceSessionId ||
      candidate.terminalSessionId !== stop.terminalSessionId
    ),
    stop,
  ].slice(-MAX_PENDING_TERMINAL_STOPS);
}

function workspaceSessionIdForThread(threadId: string): string {
  return `sess_${threadId.slice("thread_".length)}`;
}

function terminalStopMatchesThread(stop: Pick<PendingTerminalStop, "ownerId" | "workspaceSessionId" | "terminalSessionId">, thread: StoredThread): boolean {
  return thread.ownerId === stop.ownerId &&
    thread.terminalSessionId === stop.terminalSessionId &&
    (stop.workspaceSessionId === undefined || stop.workspaceSessionId === workspaceSessionIdForThread(thread.id));
}

function consumePendingTerminalStop(
  pendingTerminalStops: PendingTerminalStop[],
  thread: StoredThread,
): { pendingStop?: PendingTerminalStop; pendingTerminalStops: PendingTerminalStop[] } {
  if (!thread.terminalSessionId) {
    return { pendingTerminalStops };
  }
  const pendingStop = pendingTerminalStops.find((candidate) => terminalStopMatchesThread(candidate, thread));
  if (!pendingStop) {
    return { pendingTerminalStops };
  }
  return {
    pendingStop,
    pendingTerminalStops: pendingTerminalStops.filter((candidate) => candidate !== pendingStop),
  };
}

function safeProviderRunFailureEvents(threadId: string, now: () => Date, eventId: () => string): AgentThreadEvent[] {
  return [
    AgentThreadEventSchema.parse({
      type: "thread.error",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      error: SafeClientErrorSchema.parse({
        code: "provider_run_failed",
        safeMessage: "Agent run could not continue. Try again.",
        retryable: true,
        recoveryActions: ["retry"],
      }),
    }),
    AgentThreadEventSchema.parse({
      type: "thread.completed",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      outcome: "failed",
    }),
  ];
}

function defaultAbortEvents(threadId: string, now: () => Date, eventId: () => string): AgentThreadEvent[] {
  return [
    AgentThreadEventSchema.parse({
      type: "thread.status",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      status: "aborted",
    }),
    AgentThreadEventSchema.parse({
      type: "thread.completed",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      outcome: "aborted",
    }),
  ];
}

function terminalStoppedEvents(
  threadId: string,
  runtimeStatus: TerminalSessionStoppedReconciliation["runtimeStatus"],
  now: () => Date,
  eventId: () => string,
): AgentThreadEvent[] {
  const failed = runtimeStatus !== "exited";
  return [
    AgentThreadEventSchema.parse({
      type: "thread.status",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      status: failed ? "failed" : "completed",
    }),
    AgentThreadEventSchema.parse({
      type: "thread.completed",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      outcome: failed ? "failed" : "completed",
    }),
  ];
}

function defaultApprovalDecisionEvents(
  threadId: string,
  approvalId: string,
  request: ApprovalDecisionRequest,
  now: () => Date,
  eventId: () => string,
): AgentThreadEvent[] {
  return [
    AgentThreadEventSchema.parse({
      type: "approval.resolved",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      approvalId,
      decision: request.decision,
    }),
    AgentThreadEventSchema.parse({
      type: "thread.status",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      status: "running",
    }),
  ];
}

function defaultInputAnswerEvents(
  threadId: string,
  inputRequestId: string,
  request: UserInputAnswerRequest,
  now: () => Date,
  eventId: () => string,
): AgentThreadEvent[] {
  return [
    AgentThreadEventSchema.parse({
      type: "user_input.answered",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      requestId: inputRequestId,
      correlationId: request.correlationId,
    }),
    AgentThreadEventSchema.parse({
      type: "thread.status",
      eventId: eventId(),
      threadId,
      occurredAt: now().toISOString(),
      status: "running",
    }),
  ];
}

function parseProviderEvents(events: AgentThreadEvent[], threadId: string): AgentThreadEvent[] {
  return parseCodingAgentProviderEvents(events, threadId);
}

function includesAbortedCompletion(events: AgentThreadEvent[]): boolean {
  return events.some((event) => event.type === "thread.completed" && event.outcome === "aborted");
}

function includesNonAbortedCompletion(events: AgentThreadEvent[]): boolean {
  return events.some((event) => event.type === "thread.completed" && event.outcome !== "aborted");
}

export function safeThreadError(code: CodingAgentThreadError["code"]) {
  if (code === "provider_unavailable") {
    return SafeClientErrorSchema.parse({
      code,
      safeMessage: "Selected provider is unavailable. Choose another provider or try again.",
      retryable: true,
      recoveryActions: ["retry"],
    });
  }
  if (code === "thread_not_found") {
    return SafeClientErrorSchema.parse({
      code,
      safeMessage: "Thread is unavailable. Refresh and try again.",
      retryable: true,
      recoveryActions: ["retry"],
    });
  }
  return SafeClientErrorSchema.parse({
    code,
    safeMessage: "Agent thread state is temporarily unavailable. Try again.",
    retryable: true,
    recoveryActions: ["retry"],
  });
}

export function createCodingAgentThreadStore(
  options: CodingAgentThreadStoreOptions,
): CodingAgentThreadStore & CodingAgentTurnStore {
  const now = options.now ?? (() => new Date());
  const providers = options.providers.map((provider) => ({
    ...provider,
    providerId: ProviderIdSchema.parse(provider.providerId),
  }));
  const eventSinks: ThreadEventSink[] = [];
  let queue = Promise.resolve();

  async function mutate<T>(fn: (state: StoredThreadState) => Promise<{ state: StoredThreadState; result: T }>): Promise<T> {
    const run = queue.then(async () => {
      const current = await readState(options.homePath);
      const { state, result } = await fn(current);
      const persisted = trimState(state);
      await writeState(options.homePath, persisted);
      await publishThreadProjectionChanges({
        changes: deriveThreadProjectionChanges({
          previous: current.threads,
          next: persisted.threads,
          toSummary: stripOwner,
        }),
        publisher: options.projectionPublisher,
        logFailure: (err) => logCodingAgentWarning("thread projection publish failed", err),
      });
      return result;
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function inspect<T>(fn: (state: StoredThreadState) => T): Promise<T> {
    const run = queue.then(async () => fn(await readState(options.homePath)));
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  function providerFor(providerId: string): CodingAgentProviderAdapter {
    const provider = providers.find((candidate) => candidate.providerId === providerId);
    if (!provider) {
      throw new CodingAgentThreadError("provider_unavailable", "Provider unavailable");
    }
    return provider;
  }

  function publish(ownerId: string, threadId: string, events: AgentThreadEvent[]): void {
    if (events.length === 0) return;
    for (const sink of eventSinks) {
      try {
        sink({ ownerId, threadId, events });
      } catch (err: unknown) {
        logCodingAgentWarning("thread event sink failed", err);
      }
    }
  }

  function turnStatusEvent(
    threadId: string,
    turnId: string,
    status: "running" | "completed" | "failed" | "aborted",
  ): AgentThreadEvent {
    return AgentThreadEventSchema.parse({
      type: "turn.status",
      eventId: nextEventId(),
      threadId,
      occurredAt: now().toISOString(),
      turnId,
      status,
    });
  }

  function clearActiveTurn(thread: StoredThread): StoredThread {
    const { activeTurnId: _activeTurnId, ...cleared } = thread;
    return cleared;
  }

  function settledTurn(
    turn: StoredTurn,
    status: "completed" | "failed" | "aborted",
    updatedAt: string,
  ): StoredTurn {
    const { message: _message, attachments: _attachments, ...record } = turn;
    return StoredTurnSchema.parse({ ...record, status, updatedAt });
  }

  function terminalTurnEvents(
    threadId: string,
    turnId: string,
    outcome: "completed" | "failed" | "aborted" | "delivered",
  ): AgentThreadEvent[] {
    const lifecycle = turnStatusEvent(
      threadId,
      turnId,
      outcome === "delivered" ? "completed" : outcome,
    );
    if (outcome === "delivered") return [lifecycle];
    if (outcome === "failed") {
      return [lifecycle, ...safeProviderRunFailureEvents(threadId, now, nextEventId)];
    }
    if (outcome === "aborted") {
      return [lifecycle, ...defaultAbortEvents(threadId, now, nextEventId)];
    }
    return [lifecycle, ...terminalStoppedEvents(threadId, "exited", now, nextEventId)];
  }

  async function markTurnRunning(ownerId: string, threadId: string, turnId: string): Promise<void> {
    const result = await mutate(async (state) => {
      const thread = state.threads.find((candidate) =>
        candidate.ownerId === ownerId && candidate.id === threadId && candidate.activeTurnId === turnId
      );
      if (!thread) return { state, result: [] as AgentThreadEvent[] };
      const event = turnStatusEvent(threadId, turnId, "running");
      return {
        state: {
          ...state,
          threads: state.threads.map((candidate) =>
            candidate === thread ? { ...thread, status: "running", attention: "none", updatedAt: event.occurredAt } : candidate
          ),
          events: [...state.events, event],
          turns: state.turns.map((turn) =>
            turn.ownerId === ownerId && turn.threadId === threadId && turn.turnId === turnId
              ? { ...turn, status: "running", updatedAt: event.occurredAt }
              : turn
          ),
        },
        result: [event],
      };
    });
    publish(ownerId, threadId, result);
  }

  async function finishTurn(input: {
    ownerId: string;
    threadId: string;
    turnId: string;
    providerEvents: AgentThreadEvent[];
    outcome: "completed" | "failed" | "aborted" | "delivered";
    resumeState?: CodingAgentProviderResumeState;
  }): Promise<void> {
    const result = await mutate(async (state) => {
      const thread = state.threads.find((candidate) =>
        candidate.ownerId === input.ownerId &&
        candidate.id === input.threadId &&
        candidate.activeTurnId === input.turnId
      );
      if (!thread) return { state, result: [] as AgentThreadEvent[] };
      if (input.providerEvents.some((event) =>
        event.type === "turn.accepted" ||
        event.type === "turn.status" ||
        event.type === "thread.created" ||
        event.type === "thread.completed"
      )) {
        throw new Error("Provider emitted reserved lifecycle event");
      }
      const events = [
        ...input.providerEvents,
        ...terminalTurnEvents(input.threadId, input.turnId, input.outcome),
      ];
      let nextThread = thread;
      for (const event of events) nextThread = applyEvent(nextThread, event);
      nextThread = clearActiveTurn({
        ...nextThread,
        ...(input.resumeState ? { providerResumeState: input.resumeState } : {}),
      });
      return {
        state: {
          ...state,
          threads: state.threads.map((candidate) => candidate === thread ? nextThread : candidate),
          events: [...state.events, ...events],
          turns: state.turns.map((turn) =>
            turn.ownerId === input.ownerId && turn.threadId === input.threadId && turn.turnId === input.turnId
              ? settledTurn(
                turn,
                input.outcome === "delivered" ? "completed" : input.outcome,
                events.at(-1)!.occurredAt,
              )
              : turn
          ),
        },
        result: events,
      };
    });
    publish(input.ownerId, input.threadId, result);
  }

  const turnDispatcher = createCodingAgentTurnDispatcher({
    getProvider: providerFor,
    markRunning: markTurnRunning,
    finish: finishTurn,
    nextEventId,
    now,
    logFailure: logCodingAgentWarning,
    maxDispatches: options.maxTurnDispatches,
    timeoutMs: options.turnDispatchTimeoutMs,
  });

  async function recoverActiveTurnsInternal(): Promise<void> {
    const publications = await mutate(async (state) => {
      const recovered: Array<{ ownerId: string; threadId: string; events: AgentThreadEvent[] }> = [];
      let threads = state.threads;
      let turns = state.turns;
      let events = state.events;
      for (const thread of state.threads) {
        if (!thread.activeTurnId) continue;
        const recoveryEvents = terminalTurnEvents(thread.id, thread.activeTurnId, "failed");
        let nextThread = thread;
        for (const event of recoveryEvents) nextThread = applyEvent(nextThread, event);
        nextThread = clearActiveTurn(nextThread);
        threads = threads.map((candidate) => candidate === thread ? nextThread : candidate);
        turns = turns.map((turn) =>
          turn.ownerId === thread.ownerId && turn.threadId === thread.id && turn.turnId === thread.activeTurnId
            ? settledTurn(turn, "failed", recoveryEvents.at(-1)!.occurredAt)
            : turn
        );
        events = [...events, ...recoveryEvents];
        recovered.push({ ownerId: thread.ownerId, threadId: thread.id, events: recoveryEvents });
      }
      return {
        state: { ...state, threads, turns, events },
        result: recovered,
      };
    });
    for (const publication of publications) {
      publish(publication.ownerId, publication.threadId, publication.events);
    }
  }

  async function persistedDuplicateTurn(
    principal: RequestPrincipal,
    threadId: string,
    clientRequestId: string,
  ): Promise<CreateAgentTurnResponse | undefined> {
    return inspect((state) => {
      const existing = state.turns.find((turn) =>
        turn.ownerId === principal.userId &&
        turn.threadId === threadId &&
        turn.clientRequestId === clientRequestId
      );
      if (!existing) return undefined;
      return CreateAgentTurnResponseSchema.parse({
        threadId,
        turnId: existing.turnId,
        status: "already_accepted",
        acceptedAt: existing.acceptedAt,
      });
    });
  }

  async function createThreadInternal(
    principal: RequestPrincipal,
    request: CreateAgentThreadRequest,
    relationValidator?: CodingAgentThreadRelationValidator,
  ): Promise<ThreadCreateResult> {
    const result = await mutate(async (state) => {
      const existing = state.threads.find((thread) =>
        thread.ownerId === principal.userId && thread.clientRequestId === request.clientRequestId
      );
      if (existing) {
        const result: ThreadCreateMutationResult = {
          snapshot: snapshotFor(existing, state.events),
          existing: true,
          eventsToPublish: [],
        };
        return { state, result };
      }

      if (relationValidator) await relationValidator.validateCreate(principal, request);
      const provider = providerFor(request.providerId);

      const createdAt = now().toISOString();
      let thread: StoredThread = {
        id: nextThreadId(),
        ownerId: principal.userId,
        clientRequestId: request.clientRequestId,
        abortClientRequestIds: [],
        approvalDecisionClientRequestIds: [],
        inputAnswerClientRequestIds: [],
        providerId: request.providerId,
        title: genericTitle(),
        status: "queued",
        attention: "none",
        projectId: request.projectId,
        taskId: request.taskId,
        terminalSessionId: request.terminalSessionId,
        createdAt,
        updatedAt: createdAt,
      };
      const createdEvent = AgentThreadEventSchema.parse({
        type: "thread.created",
        eventId: nextEventId(),
        threadId: thread.id,
        occurredAt: createdAt,
        thread: stripOwner(thread),
      });
      let providerEvents: AgentThreadEvent[];
      let providerResumeState: CodingAgentProviderResumeState | undefined;
      try {
        const providerResult = parseCodingAgentProviderRunResult(await provider.startThread({
          principal,
          thread: stripOwner(thread),
          request,
          now,
          nextEventId,
        }), thread.id);
        providerEvents = providerResult.events;
        providerResumeState = providerResult.resumeState;
      } catch (err: unknown) {
        logCodingAgentWarning("provider start failed", err);
        providerEvents = safeProviderRunFailureEvents(thread.id, now, nextEventId);
      }
      const events = [createdEvent, ...providerEvents];
      for (const event of events.slice(1)) {
        thread = applyEvent(thread, event);
      }
      if (providerResumeState) {
        thread = { ...thread, providerResumeState };
      }
      const pending = consumePendingTerminalStop(state.pendingTerminalStops, thread);
      if (pending.pendingStop && activeThread(thread)) {
        const stopEvents = terminalStoppedEvents(thread.id, pending.pendingStop.runtimeStatus, now, nextEventId);
        events.push(...stopEvents);
        for (const event of stopEvents) {
          thread = applyEvent(thread, event);
        }
      }
      const nextState = {
        version: 1 as const,
        threads: [thread, ...state.threads],
        events: [...state.events, ...events],
        turns: state.turns,
        pendingTerminalStops: pending.pendingTerminalStops,
      };
      const result: ThreadCreateMutationResult = {
        snapshot: snapshotFor(thread, nextState.events),
        existing: false,
        eventsToPublish: events,
      };
      return { state: nextState, result };
    });
    if (!result.existing) {
      publish(principal.userId, result.snapshot.thread.id, result.eventsToPublish);
    }
    return { snapshot: result.snapshot, existing: result.existing };
  }

  return {
    createThread(principal, request) {
      return createThreadInternal(principal, request);
    },
    createShellThread(principal, request) {
      if (!options.relationValidator) {
        throw new CodingAgentThreadRelationError("validation_unavailable");
      }
      return createThreadInternal(principal, request, options.relationValidator);
    },
    async adoptLegacyThread(principal, threadId, request) {
      const relationValidator = options.relationValidator?.validateThread;
      if (!relationValidator) {
        throw new CodingAgentThreadRelationError("validation_unavailable");
      }
      return mutate(async (state) => {
        const thread = state.threads.find((candidate) =>
          candidate.ownerId === principal.userId && candidate.id === threadId
        );
        if (!thread) {
          throw new CodingAgentThreadError("thread_not_found", "Thread not found");
        }
        if (thread.projectId === request.projectId && thread.taskId === request.taskId) {
          return {
            state,
            result: AdoptAgentThreadResponseSchema.parse({
              thread: stripOwner(thread),
              status: "already_adopted",
            }),
          };
        }
        if (thread.projectId !== undefined || thread.taskId !== undefined) {
          throw new CodingAgentThreadRelationError("invalid_relation");
        }
        await relationValidator(principal, {
          projectId: request.projectId,
          taskId: request.taskId,
        });
        const nextThread: StoredThread = {
          ...thread,
          projectId: request.projectId,
          taskId: request.taskId,
          updatedAt: now().toISOString(),
        };
        return {
          state: {
            ...state,
            threads: state.threads.map((candidate) => candidate === thread ? nextThread : candidate),
          },
          result: AdoptAgentThreadResponseSchema.parse({
            thread: stripOwner(nextThread),
            status: "adopted",
          }),
        };
      });
    },
    async acceptTurn(principal, threadId, request) {
      const relationValidator = options.relationValidator?.validateThread;
      if (!relationValidator) throw new CodingAgentTurnError("turn_unavailable");
      const reservation = turnDispatcher.reserve();
      if (!reservation) {
        const duplicate = await persistedDuplicateTurn(principal, threadId, request.clientRequestId);
        if (duplicate) return duplicate;
        throw new CodingAgentTurnError("turn_unavailable");
      }
      try {
        const result = await mutate<TurnAcceptMutationResult>(async (state) => {
          const thread = state.threads.find((candidate) =>
            candidate.ownerId === principal.userId && candidate.id === threadId
          );
          if (!thread) throw new CodingAgentTurnError("thread_not_found");
          const existing = state.turns.find((turn) =>
            turn.ownerId === principal.userId &&
            turn.threadId === threadId &&
            turn.clientRequestId === request.clientRequestId
          );
          if (existing) {
            return {
              state,
              result: {
                response: CreateAgentTurnResponseSchema.parse({
                  threadId,
                  turnId: existing.turnId,
                  status: "already_accepted",
                  acceptedAt: existing.acceptedAt,
                }),
                eventsToPublish: [] as AgentThreadEvent[],
              },
            };
          }
          if (thread.activeTurnId) {
            throw new CodingAgentTurnError("thread_busy");
          }
          if (!["running", "completed", "failed", "aborted"].includes(thread.status)) {
            throw new CodingAgentTurnError("turn_unavailable");
          }
          await relationValidator(principal, { projectId: thread.projectId, taskId: thread.taskId });
          const provider = providerFor(thread.providerId);
          if (!provider.resumeTurn || !thread.providerResumeState) {
            throw new CodingAgentTurnError("turn_unavailable");
          }
          const acceptedAt = now().toISOString();
          const turnId = AgentTurnIdSchema.parse(`turn_${randomUUID()}`);
          const event = AgentThreadEventSchema.parse({
            type: "turn.accepted",
            eventId: nextEventId(),
            threadId,
            occurredAt: acceptedAt,
            turnId,
            clientRequestId: request.clientRequestId,
            acceptedAt,
          });
          const nextThread: StoredThread = {
            ...thread,
            activeTurnId: turnId,
            status: "running",
            attention: "none",
            updatedAt: acceptedAt,
          };
          const turn = StoredTurnSchema.parse({
            ...request,
            ownerId: principal.userId,
            threadId,
            turnId,
            status: "accepted",
            acceptedAt,
            updatedAt: acceptedAt,
          });
          return {
            state: {
              ...state,
              threads: state.threads.map((candidate) => candidate === thread ? nextThread : candidate),
              events: [...state.events, event],
              turns: [...state.turns, turn],
            },
            result: {
              response: CreateAgentTurnResponseSchema.parse({
                threadId,
                turnId,
                status: "accepted",
                acceptedAt,
              }),
              eventsToPublish: [event],
              dispatch: { thread: nextThread, turn },
            },
          };
        });
        publish(principal.userId, threadId, result.eventsToPublish);
        if (result.dispatch) {
          turnDispatcher.start(reservation, {
            principal,
            thread: stripOwner(result.dispatch.thread),
            providerResumeState: result.dispatch.thread.providerResumeState!,
            turn: {
              turnId: result.dispatch.turn.turnId,
              message: result.dispatch.turn.message!,
              ...(result.dispatch.turn.attachments
                ? { attachments: result.dispatch.turn.attachments }
                : {}),
            },
          });
        } else {
          turnDispatcher.release(reservation);
        }
        return result.response;
      } catch (err: unknown) {
        turnDispatcher.release(reservation);
        throw err;
      }
    },
    async recoverActiveTurns() {
      await recoverActiveTurnsInternal();
    },
    async shutdownTurns() {
      await turnDispatcher.shutdown();
      await queue;
      await recoverActiveTurnsInternal();
    },
    async listThreads(principal) {
      const state = await readState(options.homePath);
      const ownerThreads = state.threads
        .filter((thread) => thread.ownerId === principal.userId && activeThread(thread))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      return {
        items: ownerThreads.slice(0, THREAD_LIST_LIMIT).map(stripOwner),
        hasMore: ownerThreads.length > THREAD_LIST_LIMIT,
        limit: THREAD_LIST_LIMIT,
      };
    },
    async listAttentionThreads(principal) {
      const state = await readState(options.homePath);
      const ownerThreads = state.threads
        .filter((thread) => thread.ownerId === principal.userId && attentionThread(thread))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      return {
        items: ownerThreads.slice(0, THREAD_LIST_LIMIT).map(stripOwner),
        hasMore: ownerThreads.length > THREAD_LIST_LIMIT,
        limit: THREAD_LIST_LIMIT,
      };
    },
    async listProjectCounts(principal) {
      const state = await readState(options.homePath);
      const counts: Array<{ projectId: string; threadCount: number; attentionCount: number }> = [];
      for (const thread of state.threads) {
        if (thread.ownerId !== principal.userId || !thread.projectId || !activeThread(thread)) continue;
        let count = counts.find((candidate) => candidate.projectId === thread.projectId);
        if (!count) {
          count = { projectId: thread.projectId, threadCount: 0, attentionCount: 0 };
          counts.push(count);
        }
        count.threadCount += 1;
        if (attentionThread(thread)) count.attentionCount += 1;
      }
      return counts;
    },
    async getProjectWorkspaceThreads(principal, projectId, query, validTaskIds) {
      const state = await readState(options.homePath);
      const projectThreads = state.threads
        .filter((thread) =>
          thread.ownerId === principal.userId &&
          thread.projectId === projectId &&
          thread.status !== "archived"
        )
        .sort((left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id)
        );
      const unboundThreads = projectThreads.filter((thread) => thread.taskId === undefined);
      const taskThreads = projectThreads.filter((thread) =>
        thread.taskId !== undefined && validTaskIds.includes(thread.taskId)
      );
      const validProjectThreads = [...unboundThreads, ...taskThreads];
      return {
        projectThreads: projectThreadPage(
          unboundThreads,
          query.projectThreadCursor,
          query.projectThreadLimit,
        ),
        taskThreads: projectThreadPage(taskThreads, query.taskThreadCursor, query.taskThreadLimit),
        taskAggregates: taskThreadAggregates(taskThreads),
        threadCount: validProjectThreads.length,
        attentionCount: validProjectThreads.filter(attentionThread).length,
      };
    },
    async getThread(principal, threadId, cursor) {
      const state = await readState(options.homePath);
      const thread = state.threads.find((candidate) => candidate.ownerId === principal.userId && candidate.id === threadId);
      if (!thread) throw new CodingAgentThreadError("thread_not_found", "Thread not found");
      return snapshotFor(thread, state.events, cursor);
    },
    async abortThread(principal, threadId, clientRequestId) {
      const result = await mutate(async (state) => {
        const thread = state.threads.find((candidate) => candidate.ownerId === principal.userId && candidate.id === threadId);
        if (!thread) throw new CodingAgentThreadError("thread_not_found", "Thread not found");
        if (thread.abortClientRequestIds.includes(clientRequestId) || (terminalThread(thread) && !thread.activeTurnId)) {
          return { state, result: { snapshot: snapshotFor(thread, state.events), eventsToPublish: [] } };
        }
        const activeTurnId = thread.activeTurnId;
        if (activeTurnId) turnDispatcher.abort(activeTurnId);
        const provider = providers.find((candidate) => candidate.providerId === thread.providerId);
        let abortEvents: AgentThreadEvent[];
        if (provider?.abortThread) {
          try {
            abortEvents = parseProviderEvents(await provider.abortThread({
              principal,
              thread: stripOwner(thread),
              clientRequestId,
              now,
              nextEventId,
            }), threadId);
            if (abortEvents.length === 0 || includesNonAbortedCompletion(abortEvents)) {
              abortEvents = defaultAbortEvents(threadId, now, nextEventId);
            }
          } catch (err: unknown) {
            logCodingAgentWarning("provider abort failed", err);
            abortEvents = defaultAbortEvents(threadId, now, nextEventId);
          }
        } else {
          abortEvents = defaultAbortEvents(threadId, now, nextEventId);
        }
        let nextThread = thread;
        for (const event of abortEvents) {
          nextThread = applyEvent(nextThread, event);
        }
        if (nextThread.status !== "aborted" || !includesAbortedCompletion(abortEvents)) {
          const fallbackEvents = defaultAbortEvents(threadId, now, nextEventId);
          abortEvents = [...abortEvents, ...fallbackEvents];
          for (const event of fallbackEvents) {
            nextThread = applyEvent(nextThread, event);
          }
        }
        if (activeTurnId) {
          abortEvents = [turnStatusEvent(threadId, activeTurnId, "aborted"), ...abortEvents];
          nextThread = clearActiveTurn(nextThread);
        }
        nextThread = {
          ...nextThread,
          abortClientRequestIds: [...nextThread.abortClientRequestIds, clientRequestId].slice(-MAX_ABORT_REQUEST_IDS),
        };
        const nextState = {
          version: 1 as const,
          threads: state.threads.map((candidate) => candidate.id === thread.id ? nextThread : candidate),
          events: [...state.events, ...abortEvents],
          turns: activeTurnId
            ? state.turns.map((turn) =>
              turn.ownerId === principal.userId && turn.threadId === threadId && turn.turnId === activeTurnId
                ? settledTurn(turn, "aborted", abortEvents.at(-1)!.occurredAt)
                : turn
            )
            : state.turns,
          pendingTerminalStops: state.pendingTerminalStops,
        };
        return {
          state: nextState,
          result: { snapshot: snapshotFor(nextThread, nextState.events), eventsToPublish: abortEvents },
        };
      });
      publish(principal.userId, threadId, result.eventsToPublish);
      return result.snapshot;
    },
    async submitApproval(principal, threadId, approvalId, request) {
      const parsedApprovalId = ApprovalIdSchema.parse(approvalId);
      const result = await mutate(async (state) => {
        const thread = state.threads.find((candidate) => candidate.ownerId === principal.userId && candidate.id === threadId);
        if (!thread) throw new CodingAgentThreadError("thread_not_found", "Thread not found");
        if (thread.approvalDecisionClientRequestIds.includes(request.clientRequestId) || terminalThread(thread)) {
          return { state, result: { snapshot: snapshotFor(thread, state.events), eventsToPublish: [] } };
        }
        const provider = providers.find((candidate) => candidate.providerId === thread.providerId);
        let approvalEvents: AgentThreadEvent[];
        if (provider?.submitApproval) {
          try {
            approvalEvents = parseProviderEvents(await provider.submitApproval({
              principal,
              thread: stripOwner(thread),
              approvalId: parsedApprovalId,
              request,
              now,
              nextEventId,
            }), threadId);
          } catch (err: unknown) {
            logCodingAgentWarning("provider approval submit failed", err);
            throw new CodingAgentThreadError("thread_store_unavailable", "Provider approval submit failed");
          }
        } else {
          approvalEvents = defaultApprovalDecisionEvents(threadId, parsedApprovalId, request, now, nextEventId);
        }
        if (approvalEvents.length === 0) {
          approvalEvents = defaultApprovalDecisionEvents(threadId, parsedApprovalId, request, now, nextEventId);
        }
        let nextThread = thread;
        for (const event of approvalEvents) {
          nextThread = applyEvent(nextThread, event);
        }
        nextThread = {
          ...nextThread,
          approvalDecisionClientRequestIds: [
            ...nextThread.approvalDecisionClientRequestIds,
            request.clientRequestId,
          ].slice(-MAX_APPROVAL_DECISION_REQUEST_IDS),
        };
        const nextState = {
          version: 1 as const,
          threads: state.threads.map((candidate) => candidate.id === thread.id ? nextThread : candidate),
          events: [...state.events, ...approvalEvents],
          turns: state.turns,
          pendingTerminalStops: state.pendingTerminalStops,
        };
        return {
          state: nextState,
          result: { snapshot: snapshotFor(nextThread, nextState.events), eventsToPublish: approvalEvents },
        };
      });
      publish(principal.userId, threadId, result.eventsToPublish);
      return result.snapshot;
    },
    async submitInput(principal, threadId, inputRequestId, request) {
      const parsedInputRequestId = RequestIdSchema.parse(inputRequestId);
      const result = await mutate(async (state) => {
        const thread = state.threads.find((candidate) => candidate.ownerId === principal.userId && candidate.id === threadId);
        if (!thread) throw new CodingAgentThreadError("thread_not_found", "Thread not found");
        if (thread.inputAnswerClientRequestIds.includes(request.clientRequestId) || terminalThread(thread)) {
          return { state, result: { snapshot: snapshotFor(thread, state.events), eventsToPublish: [] } };
        }
        const provider = providers.find((candidate) => candidate.providerId === thread.providerId);
        let inputEvents: AgentThreadEvent[];
        if (provider?.submitInput) {
          try {
            inputEvents = parseProviderEvents(await provider.submitInput({
              principal,
              thread: stripOwner(thread),
              inputRequestId: parsedInputRequestId,
              request,
              now,
              nextEventId,
            }), threadId);
          } catch (err: unknown) {
            logCodingAgentWarning("provider input submit failed", err);
            throw new CodingAgentThreadError("thread_store_unavailable", "Provider input submit failed");
          }
        } else {
          inputEvents = defaultInputAnswerEvents(threadId, parsedInputRequestId, request, now, nextEventId);
        }
        if (inputEvents.length === 0) {
          inputEvents = defaultInputAnswerEvents(threadId, parsedInputRequestId, request, now, nextEventId);
        }
        let nextThread = thread;
        for (const event of inputEvents) {
          nextThread = applyEvent(nextThread, event);
        }
        nextThread = {
          ...nextThread,
          inputAnswerClientRequestIds: [
            ...nextThread.inputAnswerClientRequestIds,
            request.clientRequestId,
          ].slice(-MAX_INPUT_ANSWER_REQUEST_IDS),
        };
        const nextState = {
          version: 1 as const,
          threads: state.threads.map((candidate) => candidate.id === thread.id ? nextThread : candidate),
          events: [...state.events, ...inputEvents],
          turns: state.turns,
          pendingTerminalStops: state.pendingTerminalStops,
        };
        return {
          state: nextState,
          result: { snapshot: snapshotFor(nextThread, nextState.events), eventsToPublish: inputEvents },
        };
      });
      publish(principal.userId, threadId, result.eventsToPublish);
      return result.snapshot;
    },
    async reconcileTerminalSessionStopped(input) {
      const parsed = TerminalSessionStoppedReconciliationSchema.parse(input);
      if (!stoppedRuntimeStatus(parsed.runtimeStatus)) {
        return [];
      }
      const runtimeStatus = parsed.runtimeStatus;

      const result = await mutate(async (state) => {
        const stopKey = {
          ownerId: parsed.ownerId,
          workspaceSessionId: parsed.workspaceSessionId,
          terminalSessionId: parsed.terminalSessionId,
        };
        const threadsForTerminal = state.threads.filter((thread) => terminalStopMatchesThread(stopKey, thread));
        const matchingThreads = threadsForTerminal.filter(activeThread);
        if (matchingThreads.length === 0) {
          if (threadsForTerminal.some(terminalThread)) {
            return {
              state: {
                ...state,
                pendingTerminalStops: state.pendingTerminalStops.filter((stop) =>
                  !(
                    stop.ownerId === parsed.ownerId &&
                    stop.workspaceSessionId === parsed.workspaceSessionId &&
                    stop.terminalSessionId === parsed.terminalSessionId
                  )
                ),
              },
              result: {
                snapshots: [] as AgentThreadSnapshot[],
                eventsToPublish: [] as Array<{ ownerId: string; threadId: string; events: AgentThreadEvent[] }>,
              },
            };
          }
          const nextState = {
            ...state,
            pendingTerminalStops: appendPendingTerminalStop(state.pendingTerminalStops, {
              ownerId: parsed.ownerId,
              workspaceSessionId: parsed.workspaceSessionId,
              terminalSessionId: parsed.terminalSessionId,
              runtimeStatus,
              occurredAt: now().toISOString(),
            }),
          };
          return {
            state: nextState,
            result: {
              snapshots: [] as AgentThreadSnapshot[],
              eventsToPublish: [] as Array<{ ownerId: string; threadId: string; events: AgentThreadEvent[] }>,
            },
          };
        }

        const reconciledThreads = matchingThreads.map((thread) => {
          const events = terminalStoppedEvents(thread.id, runtimeStatus, now, nextEventId);
          let nextThread = thread;
          for (const event of events) {
            nextThread = applyEvent(nextThread, event);
          }
          return { thread, nextThread, events };
        });

        const nextEvents = [
          ...state.events,
          ...reconciledThreads.flatMap((entry) => entry.events),
        ];
        const nextState = {
          version: 1 as const,
          threads: state.threads.map((thread) =>
            reconciledThreads.find((entry) => entry.thread.id === thread.id)?.nextThread ?? thread
          ),
          events: nextEvents,
          turns: state.turns,
          pendingTerminalStops: state.pendingTerminalStops.filter((stop) =>
            !(
              stop.ownerId === parsed.ownerId &&
              stop.workspaceSessionId === parsed.workspaceSessionId &&
              stop.terminalSessionId === parsed.terminalSessionId
            )
          ),
        };
        const snapshots = reconciledThreads.map((entry) => snapshotFor(entry.nextThread, nextState.events));
        return {
          state: nextState,
          result: {
            snapshots,
            eventsToPublish: reconciledThreads.map((entry) => ({
              ownerId: entry.thread.ownerId,
              threadId: entry.thread.id,
              events: entry.events,
            })),
          },
        };
      });

      for (const item of result.eventsToPublish) {
        publish(item.ownerId, item.threadId, item.events);
      }
      return result.snapshots;
    },
    registerEventSink(sink) {
      if (eventSinks.length >= 8) {
        throw new CodingAgentThreadError("thread_store_unavailable", "Too many thread event sinks");
      }
      eventSinks.push(sink);
      return {
        dispose() {
          const index = eventSinks.indexOf(sink);
          if (index >= 0) {
            eventSinks.splice(index, 1);
          }
        },
      };
    },
  };
}
