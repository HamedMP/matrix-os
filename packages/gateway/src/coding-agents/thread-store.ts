import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  AgentThreadEventSchema,
  AgentThreadSnapshotSchema,
  AgentThreadSummarySchema,
  ApprovalIdSchema,
  IsoTimestampSchema,
  ProviderIdSchema,
  RequestIdSchema,
  SafeClientErrorSchema,
  TerminalSessionIdSchema,
  type AgentProviderSummary,
  type AgentThreadEvent,
  type AgentThreadSummary,
  type ApprovalDecisionRequest,
  type CreateAgentThreadRequest,
  type SafeSetupAction,
  type UserInputAnswerRequest,
} from "@matrix-os/contracts";
import { atomicWriteJson } from "../state-ops.js";
import type { RequestPrincipal } from "../request-principal.js";

const THREAD_STORE_RELATIVE_PATH = ["system", "coding-agents", "threads.json"] as const;
const THREAD_LIST_LIMIT = 50;
const EVENT_REPLAY_LIMIT = 200;
const MAX_STORED_THREADS = 200;
const MAX_EVENTS_PER_THREAD = 500;
const MAX_ABORT_REQUEST_IDS = 50;
const MAX_APPROVAL_DECISION_REQUEST_IDS = 50;
const MAX_INPUT_ANSWER_REQUEST_IDS = 50;
const MAX_PENDING_TERMINAL_STOPS = 100;

const OwnerIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/);
const WorkspaceSessionIdSchema = z.string().min(1).max(160).regex(/^sess_[A-Za-z0-9_-]+$/);

const StoredThreadSchema = AgentThreadSummarySchema.extend({
  ownerId: OwnerIdSchema,
  clientRequestId: RequestIdSchema,
  abortClientRequestIds: z.array(RequestIdSchema).max(MAX_ABORT_REQUEST_IDS).default([]),
  approvalDecisionClientRequestIds: z.array(RequestIdSchema).max(MAX_APPROVAL_DECISION_REQUEST_IDS).default([]),
  inputAnswerClientRequestIds: z.array(RequestIdSchema).max(MAX_INPUT_ANSWER_REQUEST_IDS).default([]),
}).strict();

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
  pendingTerminalStops: z.array(PendingTerminalStopSchema).max(MAX_PENDING_TERMINAL_STOPS).default([]),
}).strict();

type StoredThread = z.infer<typeof StoredThreadSchema>;
type StoredThreadState = z.infer<typeof StoredThreadStateSchema>;
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

export interface CodingAgentProviderAdapter {
  providerId: string;
  getSummary?(input: {
    principal: RequestPrincipal;
    now: () => Date;
  }): Promise<AgentProviderSummary> | AgentProviderSummary;
  healthCheck?(input: {
    principal: RequestPrincipal;
    now: () => Date;
  }): Promise<{ ok: boolean }> | { ok: boolean };
  buildSetupAction?(input: {
    principal: RequestPrincipal;
    now: () => Date;
  }): Promise<SafeSetupAction[]> | SafeSetupAction[];
  startThread(input: {
    principal: RequestPrincipal;
    thread: AgentThreadSummary;
    request: CreateAgentThreadRequest;
    now: () => Date;
    nextEventId: () => string;
  }): Promise<AgentThreadEvent[]> | AgentThreadEvent[];
  abortThread?(input: {
    principal: RequestPrincipal;
    thread: AgentThreadSummary;
    clientRequestId: string;
    now: () => Date;
    nextEventId: () => string;
  }): Promise<AgentThreadEvent[]> | AgentThreadEvent[];
  submitApproval?(input: {
    principal: RequestPrincipal;
    thread: AgentThreadSummary;
    approvalId: string;
    request: ApprovalDecisionRequest;
    now: () => Date;
    nextEventId: () => string;
  }): Promise<AgentThreadEvent[]> | AgentThreadEvent[];
  submitInput?(input: {
    principal: RequestPrincipal;
    thread: AgentThreadSummary;
    inputRequestId: string;
    request: UserInputAnswerRequest;
    now: () => Date;
    nextEventId: () => string;
  }): Promise<AgentThreadEvent[]> | AgentThreadEvent[];
}

export interface CodingAgentThreadStoreOptions {
  homePath: string;
  now?: () => Date;
  providers: CodingAgentProviderAdapter[];
}

export interface CodingAgentThreadStore {
  createThread(principal: RequestPrincipal, request: CreateAgentThreadRequest): Promise<ThreadCreateResult>;
  listThreads(principal: RequestPrincipal): Promise<{ items: AgentThreadSummary[]; hasMore: boolean; limit: number }>;
  listAttentionThreads(principal: RequestPrincipal): Promise<{ items: AgentThreadSummary[]; hasMore: boolean; limit: number }>;
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

export class CodingAgentThreadError extends Error {
  constructor(
    readonly code: "provider_unavailable" | "thread_not_found" | "thread_store_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "CodingAgentThreadError";
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
      return [
        {
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
      ];
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
  return { version: 1, threads: [], events: [], pendingTerminalStops: [] };
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
  const latestEvents = state.events
    .slice()
    .reverse()
    .filter((event) => activeThreadIds.includes(event.threadId))
    .reduce<AgentThreadEvent[]>((kept, event) => {
      const countForThread = kept.filter((candidate) => candidate.threadId === event.threadId).length;
      if (countForThread < MAX_EVENTS_PER_THREAD) kept.push(event);
      return kept;
    }, []);
  const events = latestEvents.reverse();
  return {
    version: 1,
    threads,
    events,
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
  const parsed = events.map((event) => AgentThreadEventSchema.parse(event));
  if (parsed.some((event) => event.threadId !== threadId)) {
    throw new Error("Provider emitted event for another thread");
  }
  return parsed;
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

export function createCodingAgentThreadStore(options: CodingAgentThreadStoreOptions): CodingAgentThreadStore {
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
      await writeState(options.homePath, trimState(state));
      return result;
    });
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
        console.warn("[coding-agents] thread event sink failed:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  return {
    async createThread(principal, request) {
      const provider = providerFor(request.providerId);
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
        try {
          providerEvents = parseProviderEvents(await provider.startThread({
            principal,
            thread: stripOwner(thread),
            request,
            now,
            nextEventId,
          }), thread.id);
        } catch (err: unknown) {
          console.warn("[coding-agents] provider start failed:", err instanceof Error ? err.message : String(err));
          providerEvents = safeProviderRunFailureEvents(thread.id, now, nextEventId);
        }
        const events = [createdEvent, ...providerEvents];
        for (const event of events.slice(1)) {
          thread = applyEvent(thread, event);
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
        if (thread.abortClientRequestIds.includes(clientRequestId) || terminalThread(thread)) {
          return { state, result: { snapshot: snapshotFor(thread, state.events), eventsToPublish: [] } };
        }
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
            console.warn("[coding-agents] provider abort failed:", err instanceof Error ? err.message : String(err));
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
        nextThread = {
          ...nextThread,
          abortClientRequestIds: [...nextThread.abortClientRequestIds, clientRequestId].slice(-MAX_ABORT_REQUEST_IDS),
        };
        const nextState = {
          version: 1 as const,
          threads: state.threads.map((candidate) => candidate.id === thread.id ? nextThread : candidate),
          events: [...state.events, ...abortEvents],
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
            console.warn("[coding-agents] provider approval submit failed:", err instanceof Error ? err.message : String(err));
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
            console.warn("[coding-agents] provider input submit failed:", err instanceof Error ? err.message : String(err));
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
