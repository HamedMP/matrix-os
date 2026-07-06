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
  type AgentThreadEvent,
  type AgentThreadSummary,
  type CreateAgentThreadRequest,
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

export interface CodingAgentProviderAdapter {
  providerId: string;
  startThread(input: {
    thread: AgentThreadSummary;
    request: CreateAgentThreadRequest;
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

export function createFakeCodingAgentProvider(options: { providerId: string }): CodingAgentProviderAdapter {
  const providerId = ProviderIdSchema.parse(options.providerId);
  return {
    providerId,
    startThread({ thread, now, nextEventId }) {
      return [
        {
          type: "thread.status",
          eventId: nextEventId(),
          threadId: thread.id,
          occurredAt: now().toISOString(),
          status: "running",
        },
        {
          type: "assistant.text.delta",
          eventId: nextEventId(),
          threadId: thread.id,
          occurredAt: now().toISOString(),
          messageId: "msg_fake_provider_started",
          delta: "Agent run started.",
        },
      ];
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
      attention: event.outcome === "failed" ? "failed" : thread.attention,
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
  const startIndex = cursor ? eventsForThread.findIndex((event) => event.eventId === cursor) + 1 : 0;
  const window = eventsForThread.slice(Math.max(0, startIndex)).slice(-EVENT_REPLAY_LIMIT);
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

  return {
    async createThread(principal, request) {
      const provider = providerFor(request.providerId);
      return mutate(async (state) => {
        const existing = state.threads.find((thread) =>
          thread.ownerId === principal.userId && thread.clientRequestId === request.clientRequestId
        );
        if (existing) {
          const result: ThreadCreateResult = { snapshot: snapshotFor(existing, state.events), existing: true };
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
        const providerEvents = await provider.startThread({
          thread: stripOwner(thread),
          request,
          now,
          nextEventId,
        });
        const events = [createdEvent, ...providerEvents.map((event) => AgentThreadEventSchema.parse(event))];
        for (const event of events.slice(1)) {
          thread = applyEvent(thread, event);
        }
        const nextState = {
          version: 1 as const,
          threads: [thread, ...state.threads],
          events: [...state.events, ...events],
        };
        const result: ThreadCreateResult = { snapshot: snapshotFor(thread, nextState.events), existing: false };
        return { state: nextState, result };
      });
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
      return mutate(async (state) => {
        const thread = state.threads.find((candidate) => candidate.ownerId === principal.userId && candidate.id === threadId);
        if (!thread) throw new CodingAgentThreadError("thread_not_found", "Thread not found");
        if (thread.abortClientRequestIds.includes(clientRequestId) || thread.status === "aborted") {
          const abortClientRequestIds = thread.abortClientRequestIds.includes(clientRequestId)
            ? thread.abortClientRequestIds
            : [...thread.abortClientRequestIds, clientRequestId].slice(-MAX_ABORT_REQUEST_IDS);
          const nextThread = {
            ...thread,
            abortClientRequestIds,
          };
          const nextThreads = state.threads.map((candidate) => candidate.id === thread.id ? nextThread : candidate);
          const nextState = { ...state, threads: nextThreads };
          return { state: nextState, result: snapshotFor(nextThread, state.events) };
        }
        const occurredAt = now().toISOString();
        const statusEvent = AgentThreadEventSchema.parse({
          type: "thread.status",
          eventId: nextEventId(),
          threadId,
          occurredAt,
          status: "aborted",
        });
        const completedEvent = AgentThreadEventSchema.parse({
          type: "thread.completed",
          eventId: nextEventId(),
          threadId,
          occurredAt: now().toISOString(),
          outcome: "aborted",
        });
        let nextThread = applyEvent(thread, statusEvent);
        nextThread = {
          ...applyEvent(nextThread, completedEvent),
          abortClientRequestIds: [...nextThread.abortClientRequestIds, clientRequestId].slice(-MAX_ABORT_REQUEST_IDS),
        };
        const nextState = {
          version: 1 as const,
          threads: state.threads.map((candidate) => candidate.id === thread.id ? nextThread : candidate),
          events: [...state.events, statusEvent, completedEvent],
        };
        return { state: nextState, result: snapshotFor(nextThread, nextState.events) };
      });
    },
  };
}
