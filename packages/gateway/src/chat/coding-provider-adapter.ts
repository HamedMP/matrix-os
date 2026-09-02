import { createHash } from "node:crypto";
import {
  AgentModeSchema,
  CanonicalChatSafeErrorSchema,
  type CanonicalChatAgentActivityKind,
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

const MAX_BUFFERED_EVENTS = 10_000;
const MAX_BUFFERED_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_RECENT_EVENT_IDS = MAX_BUFFERED_EVENTS * 2;
const MAX_ACTIVE_TOOL_ACTIVITIES = 128;
const MAX_ACTIVE_STEER_RUNS = 64;

type CodingThreads = Pick<
  CodingAgentThreadStore & CodingAgentTurnStore,
  "createThread" | "acceptTurn" | "steerTurn" | "getThread" | "abortThread" | "submitApproval" | "registerEventSink"
>;

type CodingState = { conversationId: string; providerThreadId?: string };

function driverKind(providerId: string): "codex" | "claude_code" | "opencode" | "pi" {
  if (providerId === "codex") return "codex";
  if (providerId === "claude") return "claude_code";
  if (providerId === "opencode") return "opencode";
  if (providerId === "pi") return "pi";
  throw new Error("Unsupported canonical coding Provider");
}

function legacyRequestId(runId: string): string {
  return `req_${runId.slice("run_".length)}`;
}

function principal(ownerId: string) {
  return { userId: ownerId, source: "configured-container" as const };
}

function permissions(
  permissionMode: string,
  providerId: "codex" | "claude" | "opencode" | "pi",
): Pick<CreateAgentThreadRequest, "approvalPolicy" | "sandboxMode"> {
  if (providerId === "pi" || providerId === "opencode") {
    if (permissionMode !== "supervised") {
      throw new Error(`Unsupported ${providerId === "pi" ? "Pi" : "OpenCode"} permission mode`);
    }
    return { approvalPolicy: "on_request", sandboxMode: "read_only" };
  }
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

interface ToolActivity {
  label: string;
  kind?: CanonicalChatAgentActivityKind;
  preview?: string;
  previewKind?: "command" | "path" | "text";
  detail?: string;
}

function activityKind(kind: string): CanonicalChatAgentActivityKind | undefined {
  if (kind === "command") return "command";
  if (kind === "file_change") return "file_change";
  if (kind === "mcp_tool") return "mcp_tool";
  if (kind === "dynamic_tool") return "dynamic_tool";
  if (kind === "agent" || kind === "delegation") return "delegation";
  if (kind === "search" || kind === "web_search") return "web_search";
  if (kind === "plan") return "plan";
  if (kind === "phase") return "phase";
  if (kind === "reasoning") return "reasoning";
  if (kind === "image" || kind === "image_inspection") return "image_inspection";
  return undefined;
}

function failedActivitySummary(kind: CanonicalChatAgentActivityKind): string {
  if (kind === "command") return "Command failed.";
  if (kind === "delegation") return "Delegated work failed.";
  if (kind === "web_search") return "Web search failed.";
  return "Activity failed.";
}

function normalizeEvent(
  event: AgentThreadEvent,
  toolActivities: Map<string, ToolActivity>,
): CanonicalProviderRunEvent[] {
  if (event.type === "assistant.text.delta") {
    return [CanonicalProviderRunEventSchema.parse({
      type: "assistant.delta",
      messageId: event.messageId,
      delta: event.delta,
    })];
  }
  if (event.type === "tool.started") {
    const toolActivity = {
      label: event.displayName,
      kind: activityKind(event.kind),
      ...(event.preview ? { preview: event.preview, previewKind: event.previewKind } : {}),
      ...(event.detail ? { detail: event.detail } : {}),
    };
    if (!toolActivities.has(event.toolCallId) && toolActivities.size >= MAX_ACTIVE_TOOL_ACTIVITIES) {
      const oldest = toolActivities.keys().next().value;
      if (oldest !== undefined) toolActivities.delete(oldest);
    }
    toolActivities.set(event.toolCallId, toolActivity);
    return [CanonicalProviderRunEventSchema.parse(toolActivity.kind ? {
      type: "agent.activity",
      activityId: event.toolCallId,
      kind: toolActivity.kind,
      label: toolActivity.label,
      status: "running",
      ...(toolActivity.preview ? { preview: toolActivity.preview, previewKind: toolActivity.previewKind } : {}),
      ...(toolActivity.detail ? { detail: toolActivity.detail } : {}),
    } : {
      type: "tool.progress",
      toolCallId: event.toolCallId,
      label: toolActivity.label,
      status: "running",
    })];
  }
  if (event.type === "tool.output") {
    return [];
  }
  if (event.type === "tool.completed") {
    const toolActivity = toolActivities.get(event.toolCallId);
    toolActivities.delete(event.toolCallId);
    return [CanonicalProviderRunEventSchema.parse(toolActivity?.kind ? {
      type: "agent.activity",
      activityId: event.toolCallId,
      kind: toolActivity.kind,
      label: toolActivity.label,
      status: event.outcome === "success" ? "completed" : event.outcome,
      ...(event.outcome === "failed" ? { summary: failedActivitySummary(toolActivity.kind) } : {}),
      ...(toolActivity.preview ? { preview: toolActivity.preview, previewKind: toolActivity.previewKind } : {}),
      ...(toolActivity.detail ? { detail: toolActivity.detail } : {}),
    } : {
      type: "tool.progress",
      toolCallId: event.toolCallId,
      label: toolActivity?.label ?? "Tool",
      status: event.outcome === "success" ? "completed" : event.outcome,
    })];
  }
  if (event.type === "terminal.bound") {
    if (!event.terminalSessionCreatedAt) return [];
    return [CanonicalProviderRunEventSchema.parse({
      type: "terminal.bound",
      terminalSessionId: event.terminalSessionId,
      terminalSessionCreatedAt: event.terminalSessionCreatedAt,
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
      allowedDecisions: event.approval.allowedDecisions,
    })];
  }
  if (event.type === "approval.resolved") {
    return [CanonicalProviderRunEventSchema.parse({
      type: "approval.resolved",
      approvalId: event.approvalId,
      decision: event.decision,
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
        ...(part.ownerReference ? { path: part.ownerReference } : {}),
      }];
    }
    if (part.type === "resource_reference") {
      return [{
        id: part.resource.id,
        kind: "structured_ref" as const,
        label: part.resource.label,
        ...(part.resource.path ? { path: part.resource.path } : {}),
      }];
    }
    return [];
  });
}

class ThreadEventInbox {
  private readonly queued: AgentThreadEvent[] = [];
  private queuedBytes = 0;
  private failure: Error | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly signal: AbortSignal) {}

  push(events: AgentThreadEvent[]): void {
    if (this.signal.aborted || this.failure) return;
    const incomingBytes = Buffer.byteLength(JSON.stringify(events), "utf8");
    if (this.queued.length + events.length > MAX_BUFFERED_EVENTS
      || this.queuedBytes + incomingBytes > MAX_BUFFERED_EVENT_BYTES) {
      this.fail(new Error("Canonical coding Provider event buffer exceeded"));
      return;
    }
    this.queued.push(...events);
    this.queuedBytes += incomingBytes;
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
    if (this.queued.length > 0) {
      const events = this.queued.splice(0);
      this.queuedBytes = 0;
      return events;
    }
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
    if (this.queued.length > 0) {
      const events = this.queued.splice(0);
      this.queuedBytes = 0;
      return events;
    }
    if (this.failure) throw this.failure;
    return null;
  }
}

async function* normalizedEvents(
  initial: AgentThreadEvent[],
  inbox: ThreadEventInbox,
): AsyncGenerator<CanonicalProviderRunEvent> {
  const recentEventIds = new Set<string>();
  const toolActivities = new Map<string, ToolActivity>();
  let batch: AgentThreadEvent[] | null = initial;
  while (batch !== null) {
    for (let index = 0; index < batch.length; index += 1) {
      const event = batch[index]!;
      if (recentEventIds.has(event.eventId)) continue;
      if (recentEventIds.size >= MAX_RECENT_EVENT_IDS) {
        const oldest = recentEventIds.values().next().value;
        if (oldest !== undefined) recentEventIds.delete(oldest);
      }
      recentEventIds.add(event.eventId);
      if (event.type === "assistant.text.delta") {
        let delta = event.delta;
        while (index + 1 < batch.length) {
          const next = batch[index + 1]!;
          if (next.type !== "assistant.text.delta" || next.messageId !== event.messageId
            || delta.length + next.delta.length > 4_000) break;
          index += 1;
          if (recentEventIds.has(next.eventId)) continue;
          if (recentEventIds.size >= MAX_RECENT_EVENT_IDS) {
            const oldest = recentEventIds.values().next().value;
            if (oldest !== undefined) recentEventIds.delete(oldest);
          }
          recentEventIds.add(next.eventId);
          delta += next.delta;
        }
        yield CanonicalProviderRunEventSchema.parse({
          type: "assistant.delta",
          messageId: event.messageId,
          delta,
        });
        continue;
      }
      for (const normalized of normalizeEvent(event, toolActivities)) {
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
  // The live sink is registered before admission and remains authoritative when
  // the bounded snapshot has already evicted this Turn's accepted marker.
  if (index < 0) return [];
  return snapshot.events.items.slice(index);
}

export function createCanonicalCodingChatProviderAdapter(options: {
  providerId: "codex" | "claude" | "opencode" | "pi";
  threads: CodingThreads;
}): CanonicalChatProviderAdapter<CodingState> {
  const kind = driverKind(options.providerId);
  const activeSteerRuns = new Map<string, {
    ownerId: string;
    threadId: string;
    legacyTurnId?: string;
  }>();

  function registerSteerRun(
    runId: string,
    value: { ownerId: string; threadId: string; legacyTurnId?: string },
  ): () => void {
    if (!activeSteerRuns.has(runId) && activeSteerRuns.size >= MAX_ACTIVE_STEER_RUNS) {
      throw new Error("Canonical coding steering registry exceeded");
    }
    activeSteerRuns.set(runId, value);
    return () => {
      if (activeSteerRuns.get(runId) === value) activeSteerRuns.delete(runId);
    };
  }

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
      let bufferedEventBytes = 0;
      let targetThreadId: string | undefined;
      let releaseSteerRun: (() => void) | undefined;
      const sink = options.threads.registerEventSink((published) => {
        if (published.ownerId !== input.owner.ownerId) return;
        if (targetThreadId === undefined) {
          const incomingBytes = Buffer.byteLength(JSON.stringify(published.events), "utf8");
          if (bufferedEventCount + published.events.length > MAX_BUFFERED_EVENTS
            || bufferedEventBytes + incomingBytes > MAX_BUFFERED_EVENT_BYTES) {
            inbox.fail(new Error("Canonical coding Provider event buffer exceeded"));
            return;
          }
          bufferedEventCount += published.events.length;
          bufferedEventBytes += incomingBytes;
          buffered.push({ threadId: published.threadId, events: published.events });
        } else if (published.threadId === targetThreadId) {
          inbox.push(published.events);
        }
      });
      try {
        const requestId = legacyRequestId(input.runId);
        const created = await options.threads.createThread(principal(input.owner.ownerId), {
          providerId: options.providerId,
          prompt: input.prompt,
          ...(input.projectSlug ? { projectId: input.projectSlug } : {}),
          ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
          mode,
          model: input.selection.model,
          modelOptions: input.selection.options ?? [],
          ...permissions(input.permissionMode, options.providerId),
          attachments: attachments(input),
          clientRequestId: requestId,
        });
        targetThreadId = created.snapshot.thread.id;
        releaseSteerRun = registerSteerRun(input.runId, {
          ownerId: input.owner.ownerId,
          threadId: targetThreadId,
        });
        for (const published of buffered) {
          if (published.threadId === targetThreadId) inbox.push(published.events);
        }
        yield { type: "state.updated", state: { conversationId: targetThreadId } };
        yield* normalizedEvents(created.snapshot.events.items, inbox);
      } finally {
        releaseSteerRun?.();
        sink.dispose();
      }
    },
    async *resume(inputValue) {
      const { input } = validate(inputValue);
      const state = CodingAgentProviderResumeStateSchema.parse(input.resumeState);
      const targetThreadId = state.conversationId;
      const inbox = new ThreadEventInbox(input.signal);
      let releaseSteerRun: (() => void) | undefined;
      const sink = options.threads.registerEventSink((published) => {
        if (published.ownerId === input.owner.ownerId && published.threadId === targetThreadId) {
          inbox.push(published.events);
        }
      });
      try {
        const requestId = legacyRequestId(input.runId);
        const accepted = await options.threads.acceptTurn(principal(input.owner.ownerId), targetThreadId, {
          message: input.prompt,
          attachments: attachments(input),
          model: input.selection.model,
          modelOptions: input.selection.options ?? [],
          ...permissions(input.permissionMode, options.providerId),
          clientRequestId: requestId,
        });
        releaseSteerRun = registerSteerRun(input.runId, {
          ownerId: input.owner.ownerId,
          threadId: targetThreadId,
          legacyTurnId: accepted.turnId,
        });
        const current = await options.threads.getThread(principal(input.owner.ownerId), targetThreadId);
        yield* normalizedEvents(eventsForAcceptedRun(current, requestId), inbox);
      } finally {
        releaseSteerRun?.();
        sink.dispose();
      }
    },
    async steer(input) {
      const active = activeSteerRuns.get(input.runId);
      if (!active || active.ownerId !== input.owner.ownerId) {
        throw new Error("Canonical coding Provider steering Run unavailable");
      }
      await options.threads.steerTurn(
        principal(input.owner.ownerId),
        active.threadId,
        {
          ...(active.legacyTurnId ? { expectedTurnId: active.legacyTurnId } : {}),
          message: input.prompt,
          clientRequestId: input.clientRequestId,
        },
      );
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
    async submitApproval(input) {
      if (!input.state) throw new Error("Canonical coding Provider approval state unavailable");
      const state = CodingAgentProviderResumeStateSchema.parse(input.state);
      const current = await options.threads.getThread(
        principal(input.owner.ownerId),
        state.conversationId,
      );
      let correlationId: string | null = null;
      for (const event of current.events.items) {
        if (event.type === "approval.requested" && event.approval.approvalId === input.approvalId) {
          correlationId = event.approval.correlationId;
        }
        if (event.type === "approval.resolved" && event.approvalId === input.approvalId) {
          correlationId = null;
        }
      }
      if (!correlationId) throw new Error("Canonical coding Provider approval request unavailable");
      await options.threads.submitApproval(
        principal(input.owner.ownerId),
        state.conversationId,
        input.approvalId,
        { decision: input.decision, clientRequestId: input.clientRequestId, correlationId },
      );
    },
  };
}
