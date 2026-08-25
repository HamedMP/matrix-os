import { createHash } from "node:crypto";
import {
  AgentModeSchema,
  CanonicalChatSafeErrorSchema,
  type AgentThreadEvent,
  type AgentThreadSnapshot,
  type CreateAgentThreadRequest,
} from "@matrix-os/contracts";
import type {
  CodingAgentThreadStore,
  CodingAgentTurnStore,
} from "../coding-agents/thread-store.js";
import { CodingAgentProviderResumeStateSchema } from "../coding-agents/provider-adapter.js";
import {
  CanonicalProviderRunEventSchema,
  parseCanonicalProviderRunInput,
  type CanonicalChatProviderAdapter,
  type CanonicalProviderRunEvent,
  type CanonicalProviderRunInput,
} from "./provider-adapter.js";

const MAX_BUFFERED_EVENTS = 500;

type CodingThreads = Pick<
  CodingAgentThreadStore & CodingAgentTurnStore,
  "createThread" | "acceptTurn" | "getThread" | "abortThread" | "registerEventSink"
>;

type CodingState = { conversationId: string; providerThreadId?: string };

function driverKind(providerId: string): "codex" | "claude_code" {
  if (providerId === "codex") return "codex";
  if (providerId === "claude") return "claude_code";
  throw new Error("Unsupported canonical coding Provider");
}

function legacyRequestId(runId: string): string {
  return `req_${runId.slice("run_".length)}`;
}

function principal(ownerId: string) {
  return { userId: ownerId, source: "configured-container" as const };
}

function permissions(permissionMode: string): Pick<CreateAgentThreadRequest, "approvalPolicy" | "sandboxMode"> {
  if (permissionMode === "full_access") return { approvalPolicy: "never", sandboxMode: "full_access" };
  if (permissionMode === "auto" || permissionMode === "auto_accept_edits") {
    return { approvalPolicy: "on_failure", sandboxMode: "workspace_write" };
  }
  if (permissionMode === "supervised") return { approvalPolicy: "on_request", sandboxMode: "workspace_write" };
  throw new Error("Unsupported canonical coding Provider permission mode");
}

function safeResourceId(path: string): string {
  return `file_${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
}

function normalizeEvent(event: AgentThreadEvent): CanonicalProviderRunEvent[] {
  if (event.type === "assistant.text.delta") {
    return [CanonicalProviderRunEventSchema.parse({ type: "assistant.delta", delta: event.delta })];
  }
  if (event.type === "tool.started") {
    return [CanonicalProviderRunEventSchema.parse({
      type: "tool.progress", toolCallId: event.toolCallId, label: event.displayName, status: "running",
    })];
  }
  if (event.type === "tool.output") {
    const candidate = CanonicalProviderRunEventSchema.safeParse({
      type: "tool.output", toolCallId: event.toolCallId, text: event.text, truncated: event.truncated ?? false,
    });
    return [candidate.success ? candidate.data : CanonicalProviderRunEventSchema.parse({
      type: "tool.output",
      toolCallId: event.toolCallId,
      text: "Provider tool output is available in the bound terminal.",
      truncated: true,
    })];
  }
  if (event.type === "tool.completed") {
    return [CanonicalProviderRunEventSchema.parse({
      type: "tool.progress",
      toolCallId: event.toolCallId,
      label: "Tool",
      status: event.outcome === "success" ? "completed" : event.outcome,
    })];
  }
  if (event.type === "terminal.bound") {
    return [CanonicalProviderRunEventSchema.parse({
      type: "terminal.bound", terminalSessionId: event.terminalSessionId,
    })];
  }
  if (event.type === "review.ready") {
    return [CanonicalProviderRunEventSchema.parse({
      type: "review.ready", reviewId: event.reviewId, summary: event.summary,
    })];
  }
  if (event.type === "file.changed") {
    return [CanonicalProviderRunEventSchema.parse({
      type: "resource.changed",
      resourceId: safeResourceId(event.path),
      resourceKind: "file",
      changeKind: event.changeKind,
    })];
  }
  if (event.type === "approval.requested") {
    return [CanonicalProviderRunEventSchema.parse({
      type: "approval.requested",
      approvalId: event.approval.approvalId,
      title: event.approval.title,
      risk: event.approval.risk,
    })];
  }
  if (event.type === "user_input.requested") {
    return [CanonicalProviderRunEventSchema.parse({
      type: "input.requested", requestId: event.request.requestId, title: event.request.title,
    })];
  }
  if (event.type === "thread.error") {
    return [CanonicalProviderRunEventSchema.parse({
      type: "run.completed",
      outcome: "failed",
      error: CanonicalChatSafeErrorSchema.parse({
        code: "run_failed",
        safeMessage: "The coding Provider Run failed.",
        retryable: true,
        recoveryActions: ["retry"],
      }),
    })];
  }
  if (event.type === "thread.completed") {
    return [CanonicalProviderRunEventSchema.parse({ type: "run.completed", outcome: event.outcome })];
  }
  return [];
}

function attachments(input: CanonicalProviderRunInput) {
  return input.parts.flatMap((part) => {
    if (part.type === "attachment_reference") {
      return [{
        id: part.attachmentId,
        kind: part.kind,
        label: part.label,
        ...(part.mimeType ? { mimeType: part.mimeType } : {}),
        ...(part.sizeBytes === undefined ? {} : { sizeBytes: part.sizeBytes }),
      }];
    }
    if (part.type === "resource_reference") {
      return [{ id: part.resource.id, kind: "structured_ref" as const, label: part.resource.label }];
    }
    return [];
  });
}

class ThreadEventInbox {
  private readonly queued: AgentThreadEvent[] = [];
  private failure: Error | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly signal: AbortSignal) {}

  push(events: AgentThreadEvent[]): void {
    if (this.signal.aborted || this.failure) return;
    if (this.queued.length + events.length > MAX_BUFFERED_EVENTS) {
      this.fail(new Error("Canonical coding Provider event buffer exceeded"));
      return;
    }
    this.queued.push(...events);
    this.wake?.();
    this.wake = undefined;
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.wake?.();
    this.wake = undefined;
  }

  async next(): Promise<AgentThreadEvent[] | null> {
    if (this.queued.length > 0) return this.queued.splice(0);
    if (this.failure) throw this.failure;
    if (this.signal.aborted) return null;
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        this.wake = undefined;
        resolve();
      };
      this.signal.addEventListener("abort", onAbort, { once: true });
      this.wake = () => {
        this.signal.removeEventListener("abort", onAbort);
        resolve();
      };
    });
    if (this.queued.length > 0) return this.queued.splice(0);
    if (this.failure) throw this.failure;
    return null;
  }
}

async function* normalizedEvents(
  initial: AgentThreadEvent[],
  inbox: ThreadEventInbox,
): AsyncGenerator<CanonicalProviderRunEvent> {
  const seen = new Set<string>();
  let batch: AgentThreadEvent[] | null = initial;
  while (batch !== null) {
    for (const event of batch) {
      if (seen.has(event.eventId)) continue;
      if (seen.size >= MAX_BUFFERED_EVENTS * 2) {
        throw new Error("Canonical coding Provider event history exceeded");
      }
      seen.add(event.eventId);
      for (const normalized of normalizeEvent(event)) {
        yield normalized;
        if (normalized.type === "run.completed") return;
      }
    }
    batch = await inbox.next();
  }
}

function eventsForAcceptedRun(snapshot: AgentThreadSnapshot, requestId: string): AgentThreadEvent[] {
  const index = snapshot.events.items.findIndex((event) =>
    event.type === "turn.accepted" && event.clientRequestId === requestId
  );
  if (index < 0) throw new Error("Canonical coding Provider Turn was not persisted");
  return snapshot.events.items.slice(index);
}

export function createCanonicalCodingChatProviderAdapter(options: {
  providerId: "codex" | "claude";
  threads: CodingThreads;
}): CanonicalChatProviderAdapter<CodingState> {
  const kind = driverKind(options.providerId);

  function validate(inputValue: CanonicalProviderRunInput<CodingState>) {
    const input = parseCanonicalProviderRunInput(inputValue);
    const mode = AgentModeSchema.safeParse(input.interactionMode);
    if (!mode.success) throw new Error("Unsupported canonical coding Provider mode");
    return { input, mode: mode.data };
  }

  return {
    driverKind: kind,
    stateSchemaVersion: 1,
    parseState: (value) => CodingAgentProviderResumeStateSchema.parse(value),
    serializeState: (value) => CodingAgentProviderResumeStateSchema.parse(value),
    async *start(inputValue) {
      const { input, mode } = validate(inputValue);
      const inbox = new ThreadEventInbox(input.signal);
      const buffered: Array<{ threadId: string; events: AgentThreadEvent[] }> = [];
      let bufferedEventCount = 0;
      let targetThreadId: string | undefined;
      const sink = options.threads.registerEventSink((published) => {
        if (published.ownerId !== input.owner.ownerId) return;
        if (targetThreadId === undefined) {
          if (bufferedEventCount + published.events.length > MAX_BUFFERED_EVENTS) {
            inbox.fail(new Error("Canonical coding Provider event buffer exceeded"));
            return;
          }
          bufferedEventCount += published.events.length;
          buffered.push({ threadId: published.threadId, events: published.events });
        } else if (published.threadId === targetThreadId) {
          inbox.push(published.events);
        }
      });
      try {
        const created = await options.threads.createThread(principal(input.owner.ownerId), {
          providerId: options.providerId,
          prompt: input.prompt,
          ...(input.projectSlug ? { projectId: input.projectSlug } : {}),
          ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
          mode,
          ...permissions(input.permissionMode),
          attachments: attachments(input),
          clientRequestId: legacyRequestId(input.runId),
        });
        targetThreadId = created.snapshot.thread.id;
        for (const published of buffered) {
          if (published.threadId === targetThreadId) inbox.push(published.events);
        }
        yield { type: "state.updated", state: { conversationId: targetThreadId } };
        yield* normalizedEvents(created.snapshot.events.items, inbox);
      } finally {
        sink.dispose();
      }
    },
    async *resume(inputValue) {
      const { input } = validate(inputValue);
      const state = CodingAgentProviderResumeStateSchema.parse(input.resumeState);
      const targetThreadId = state.conversationId;
      const inbox = new ThreadEventInbox(input.signal);
      const sink = options.threads.registerEventSink((published) => {
        if (published.ownerId === input.owner.ownerId && published.threadId === targetThreadId) {
          inbox.push(published.events);
        }
      });
      try {
        const requestId = legacyRequestId(input.runId);
        await options.threads.acceptTurn(principal(input.owner.ownerId), targetThreadId, {
          message: input.prompt,
          attachments: attachments(input),
          clientRequestId: requestId,
        });
        const current = await options.threads.getThread(principal(input.owner.ownerId), targetThreadId);
        yield* normalizedEvents(eventsForAcceptedRun(current, requestId), inbox);
      } finally {
        sink.dispose();
      }
    },
    async cancel(input) {
      if (!input.state) return;
      const state = CodingAgentProviderResumeStateSchema.parse(input.state);
      await options.threads.abortThread(
        principal(input.owner.ownerId),
        state.conversationId,
        legacyRequestId(input.runId),
      );
    },
  };
}
