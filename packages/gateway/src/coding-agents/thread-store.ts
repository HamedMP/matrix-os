import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  AgentThreadEventSchema,
  AgentThreadSnapshotSchema,
  AgentThreadSummarySchema,
  ProviderIdSchema,
  RequestIdSchema,
  SafeClientErrorSchema,
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

const OwnerIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/);

const StoredThreadSchema = AgentThreadSummarySchema.extend({
  ownerId: OwnerIdSchema,
  clientRequestId: RequestIdSchema,
  abortClientRequestIds: z.array(RequestIdSchema).max(MAX_ABORT_REQUEST_IDS).default([]),
}).strict();

const StoredThreadStateSchema = z.object({
  version: z.literal(1),
  threads: z.array(StoredThreadSchema).max(MAX_STORED_THREADS),
  events: z.array(AgentThreadEventSchema).max(MAX_STORED_THREADS * MAX_EVENTS_PER_THREAD),
}).strict();

type StoredThread = z.infer<typeof StoredThreadSchema>;
type StoredThreadState = z.infer<typeof StoredThreadStateSchema>;
type AgentThreadSnapshot = z.infer<typeof AgentThreadSnapshotSchema>;
type ThreadCreateResult = { snapshot: AgentThreadSnapshot; existing: boolean };
type ThreadCreateMutationResult = ThreadCreateResult & { eventsToPublish: AgentThreadEvent[] };
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
  getThread(principal: RequestPrincipal, threadId: string, cursor?: string): Promise<AgentThreadSnapshot>;
  abortThread(principal: RequestPrincipal, threadId: string, clientRequestId: string): Promise<AgentThreadSnapshot>;
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
  return { version: 1, threads: [], events: [] };
}

function statePath(homePath: string): string {
  return join(homePath, ...THREAD_STORE_RELATIVE_PATH);
}

async function readState(homePath: string): Promise<StoredThreadState> {
  try {
    const raw = await readFile(statePath(homePath), "utf-8");
    return StoredThreadStateSchema.parse(JSON.parse(raw));
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
    return { ...thread, status: event.status, updatedAt };
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
  const startIndex = cursor ? cursorIndex + 1 : 0;
  const window = eventsForThread.slice(startIndex, startIndex + EVENT_REPLAY_LIMIT);
  return AgentThreadSnapshotSchema.parse({
    thread: stripOwner(thread),
    events: {
      items: window,
      hasMore: eventsForThread.length - Math.max(0, startIndex) > window.length,
      nextCursor: window.at(-1)?.eventId,
      limit: EVENT_REPLAY_LIMIT,
    },
  });
}

function stripOwner(thread: StoredThread): AgentThreadSummary {
  const { ownerId: _ownerId, clientRequestId: _clientRequestId, abortClientRequestIds: _abortClientRequestIds, ...summary } = thread;
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
  return { version: 1, threads, events };
}

function activeThread(thread: StoredThread): boolean {
  return !["completed", "failed", "aborted", "archived"].includes(thread.status);
}

function terminalThread(thread: StoredThread): boolean {
  return !activeThread(thread);
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

function parseProviderEvents(events: AgentThreadEvent[]): AgentThreadEvent[] {
  return events.map((event) => AgentThreadEventSchema.parse(event));
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
          }));
        } catch (err: unknown) {
          console.warn("[coding-agents] provider start failed:", err instanceof Error ? err.message : String(err));
          providerEvents = safeProviderRunFailureEvents(thread.id, now, nextEventId);
        }
        const events = [createdEvent, ...providerEvents];
        for (const event of events.slice(1)) {
          thread = applyEvent(thread, event);
        }
        const nextState = {
          version: 1 as const,
          threads: [thread, ...state.threads],
          events: [...state.events, ...events],
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
            }));
            if (abortEvents.length === 0) {
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
        nextThread = {
          ...nextThread,
          abortClientRequestIds: [...nextThread.abortClientRequestIds, clientRequestId].slice(-MAX_ABORT_REQUEST_IDS),
        };
        const nextState = {
          version: 1 as const,
          threads: state.threads.map((candidate) => candidate.id === thread.id ? nextThread : candidate),
          events: [...state.events, ...abortEvents],
        };
        return {
          state: nextState,
          result: { snapshot: snapshotFor(nextThread, nextState.events), eventsToPublish: abortEvents },
        };
      });
      publish(principal.userId, threadId, result.eventsToPublish);
      return result.snapshot;
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
