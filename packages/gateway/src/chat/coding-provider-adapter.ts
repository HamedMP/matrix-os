import { sealToolOutput } from "../coding-agents/protected-tool-output.mjs";
import { coarseToolOutputText } from "../coding-agents/codex-tool-output.mjs";
import { ChatInputNotDeliveredError } from "./input-delivery-error.js";
import { BackgroundProjectionDetached } from "./background-run-control.js";
import { createHash } from "node:crypto";
import { boundedOperation } from "../bounded-operation.js";
import type { CodingAbortScope } from "../coding-agents/thread-abort.js";
import type { CodingAgentProviderAdapter } from "../coding-agents/provider-adapter.js";
import {
  AgentModeSchema,
  CanonicalChatSafeErrorSchema,
  CanonicalChatToolOutputTextSchema,
  CanonicalExecutionPolicySchema,
  type CanonicalChatAgentActivityKind,
  type CanonicalExecutionPolicy,
  type AgentThreadEvent,
  type AgentThreadSnapshot,
  type CreateAgentThreadRequest,
} from "@matrix-os/contracts";
import {
  CodingAgentCanonicalExecutionSchema,
  type CodingAgentCanonicalExecution,
} from "../coding-agents/provider-adapter.js";
import {
  CodingAgentTurnError,
  type CodingAgentThreadStore,
  type CodingAgentTurnStore,
} from "../coding-agents/thread-store.js";
import { canonicalJsonStringify } from "./argument-digest.js";
import type { ActionQualificationInput } from "./action-policy.js";
import type { QualifiedActionTool } from "./action-tools.js";
import type { AiTokenUsage } from "../ai-analytics.js";
import { projectCodingActivity } from "./coding-activity-projection.js";
import { CodingChatStateSchema, recoveryState, recoverCodingRun, type CodingChatState } from "./coding-run-recovery.js";
import {
  CanonicalProviderRunEventSchema,
  parseCanonicalProviderRunInput,
  type CanonicalChatProviderAdapter,
  type CanonicalProviderRunEvent,
  type CanonicalProviderRunInput,
} from "./provider-adapter.js";

import { MAX_BUFFERED_EVENTS, MAX_BUFFERED_EVENT_BYTES, ThreadEventInbox } from "./thread-event-inbox.js";
const MAX_RECENT_EVENT_IDS = MAX_BUFFERED_EVENTS * 2;
const MAX_ACTIVE_TOOL_ACTIVITIES = 128;
const MAX_ACTIVE_STEER_RUNS = 64;

type CodingThreads = Pick<
  CodingAgentThreadStore & CodingAgentTurnStore,
  "createThread" | "acceptTurn" | "steerTurn" | "getThread" | "abortThread" | "submitApproval" | "submitInput" | "registerEventSink"
>;

type CodingState = CodingChatState;

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
  if (kind === "image_generation") return "image_generation";
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
  providerId: "codex" | "claude" | "opencode" | "pi",
  toolOutputKey?: Buffer,
): CanonicalProviderRunEvent[] {
  // External supervision can terminate a run after its runner died before publishing tool completion.
  // Settle every observed activity before the terminal event reaches any renderer.
  const settled = event.type === "thread.error" || event.type === "thread.completed"
    ? [...toolActivities.keys()].flatMap((toolCallId) => normalizeEvent({
      type: "tool.completed", eventId: event.eventId, threadId: event.threadId, occurredAt: event.occurredAt,
      toolCallId, outcome: event.type === "thread.error" || event.outcome === "failed" ? "failed" : "cancelled",
    }, toolActivities, providerId, toolOutputKey)) : [];
  if (event.type === "assistant.text.delta") {
    return [CanonicalProviderRunEventSchema.parse({
      type: "assistant.delta",
      messageId: event.messageId,
      delta: event.delta,
    })];
  }
  if (event.type === "assistant.attachment") {
    return [CanonicalProviderRunEventSchema.parse({
      type: "assistant.attachment",
      attachment: event.attachment,
    })];
  }
  if (event.type === "subagent.activity") {
    const status = event.subagent.status;
    return [CanonicalProviderRunEventSchema.parse({
      type: "agent.activity", activityId: event.activityId, kind: "delegation",
      label: event.subagent.name, subagent: event.subagent,
      status: status === "waiting" ? "running" : status === "unknown" ? "partial" : status,
    })];
  }
  if (event.type === "tool.started") {
    const toolActivity = {
      ...projectCodingActivity(event),
      kind: activityKind(event.kind),
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
    const text = CanonicalChatToolOutputTextSchema.safeParse(event.text);
    if (!text.success) return [];
    // Codex must seal before journaling; never recover unsealed legacy Codex text.
    // Other coding harnesses retain their existing thread contract, but seal at
    // this boundary before canonical activities/outbox persistence.
    const protectedOutput = event.protectedOutput ?? (providerId !== "codex" && toolOutputKey
      ? sealToolOutput(toolOutputKey, event.toolCallId, text.data) : undefined);
    return [{ type: "tool.output", toolCallId: event.toolCallId,
      text: coarseToolOutputText(text.data), truncated: event.truncated ?? false,
      ...(protectedOutput ? { protectedOutput } : {}) }];
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
    const terminalSessionId = event.terminalRef
      ? `${event.terminalRef.workspaceId}:${event.terminalRef.tabId}`
      : event.terminalSessionId;
    if (!terminalSessionId) return [];
    return [CanonicalProviderRunEventSchema.parse({
      type: "terminal.bound",
      terminalSessionId,
      terminalSessionCreatedAt: event.terminalSessionCreatedAt ?? event.occurredAt,
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
      questions: event.request.questions, safeDescription: event.request.safeDescription, expiresAt: event.request.expiresAt,
    })];
  }
  if (event.type === "user_input.answered") {
    return [CanonicalProviderRunEventSchema.parse({ type: "input.resolved", requestId: event.requestId, reason: event.reason ?? "answered" })];
  }
  if (event.type === "thread.error") {
    return [...settled, CanonicalProviderRunEventSchema.parse({
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
    return [...settled, CanonicalProviderRunEventSchema.parse({ type: "run.completed", outcome: event.outcome })];
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

async function* normalizedEvents(
  initial: AgentThreadEvent[],
  inbox: ThreadEventInbox,
  providerId: "codex" | "claude" | "opencode" | "pi",
  toolOutputKey?: Buffer,
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
      inbox.lastEventId = event.eventId;
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
          inbox.lastEventId = next.eventId;
          delta += next.delta;
        }
        yield CanonicalProviderRunEventSchema.parse({
          type: "assistant.delta",
          messageId: event.messageId,
          delta,
        });
        continue;
      }
      for (const normalized of normalizeEvent(event, toolActivities, providerId, toolOutputKey)) {
        if (normalized.type === "run.completed") {
          const tokenUsage = inbox.takeTokenUsage();
          yield CanonicalProviderRunEventSchema.parse({
            ...normalized,
            ...(tokenUsage ? {
              tokenUsage,
              ...(providerId === "codex" ? { provider: "openai" } : {}),
            } : {}),
          });
        } else {
          yield normalized;
        }
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

/**
 * Server-composed attestation that the constrained Codex path is live: the
 * event bridge carries a bound grant into `invokeCodexCanonicalAction`, the
 * control client returns results, and the session launch chain transports
 * `canonicalExecution`. Composition must only pass this when every hop is
 * wired — the adapter treats its presence as proof and fails closed on any
 * missing piece at dispatch time.
 */
export interface CanonicalCodingExecutionCapability {
  /** Frozen server tool descriptors the isolated runner may advertise. */
  inventory: readonly QualifiedActionTool[];
  /** Owner CLI `auth.json` bound into the isolated home when provisioned. */
  authFile?: string;
  /** Live check that the bridge dispatch and authority are still wired. */
  isDispatchLive(): boolean;
}

export const CANONICAL_CODEX_POLICY_REVISION = "codex_canonical_v1";
const CANONICAL_CODEX_PERMISSION_MODES = new Set(["full_access", "auto", "auto_accept_edits", "supervised"]);
const CANONICAL_WORKSPACE_SCOPE = /^apps(?::[a-z0-9][a-z0-9-]{0,63})?$/;

/**
 * The single policy shape the constrained Codex runner can enforce for a
 * qualification request. Admission compares the frozen run policy byte-for-byte
 * against this — the voice/session decision must carry it verbatim, so the
 * derivation is deterministic per (driver, permissionMode, workspaceScope).
 */
function qualifiedCanonicalCodexPolicy(
  capability: CanonicalCodingExecutionCapability,
  permissionMode: string,
  workspaceScope: string,
): CanonicalExecutionPolicy | undefined {
  if (!capability.isDispatchLive()) return undefined;
  if (!CANONICAL_CODEX_PERMISSION_MODES.has(permissionMode)) return undefined;
  if (!CANONICAL_WORKSPACE_SCOPE.test(workspaceScope)) return undefined;
  return CanonicalExecutionPolicySchema.parse({
    revision: CANONICAL_CODEX_POLICY_REVISION,
    actionMode: "canonical_actions",
    workspaceScope,
    tools: capability.inventory.map((tool) => tool.toolId),
    delegation: false,
  });
}

const RUNNER_SCHEMA_DIALECT = new Set([
  "type", "description", "enum", "properties", "required", "additionalProperties",
  "minLength", "maxLength", "minimum", "maximum", "items", "minItems", "maxItems", "anyOf",
]);

/**
 * The constrained runner advertises a deliberately small JSON-schema dialect:
 * no regex (`pattern`), no `$schema`/`format` metadata. Dropping those keys
 * only widens the dispatch pre-filter — the authority normalizer still parses
 * the exact Zod schema before any effect, so nothing loosens server-side.
 */
function runnerSafeJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(runnerSafeJsonSchema);
  if (!value || typeof value !== "object") return value;
  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!RUNNER_SCHEMA_DIALECT.has(key)) continue;
    safe[key] = runnerSafeJsonSchema(child);
  }
  // The runner dialect requires every string to carry a bounded maxLength;
  // regex-stripped strings get the transport bound, normalization still wins.
  if (safe.type === "string" && !Number.isSafeInteger(safe.maxLength)) {
    safe.maxLength = 65_536;
  }
  return safe;
}

function canonicalGrantDescriptors(
  capability: CanonicalCodingExecutionCapability,
): CodingAgentCanonicalExecution["inventory"] {
  const toolIdSchema = CodingAgentCanonicalExecutionSchema.shape.inventory.element.shape.toolId;
  return capability.inventory.map(({ toolId, schemaRevision, description, effect, inputSchema }) => (
    { toolId: toolIdSchema.parse(toolId), schemaRevision, description, effect, inputSchema: runnerSafeJsonSchema(inputSchema) }
  ));
}

export function createCanonicalCodingChatProviderAdapter(options: {
  providerId: "codex" | "claude" | "opencode" | "pi";
  threads: CodingThreads;
  toolOutputKey?: Buffer;
  nativeInputProvider?: Pick<CodingAgentProviderAdapter, "deferInput">;
  /**
   * Present only when composition wired the isolated Codex app-server path
   * end-to-end. Other drivers never receive it: they cannot transport the
   * grant, so any canonical run policy on them fails closed.
   */
  canonical?: CanonicalCodingExecutionCapability;
}): CanonicalChatProviderAdapter<CodingState> {
  const kind = driverKind(options.providerId);
  const capability = kind === "codex" ? options.canonical : undefined;
  const activeSteerRuns = new Map<string, {
    ownerId: string;
    chatId: string;
    threadId: string;
    legacyTurnId?: string;
    canonical?: boolean;
    executionPolicy?: CanonicalExecutionPolicy;
  }>();

  /**
   * A frozen run policy is only dispatchable when it is byte-for-byte the
   * policy this adapter can currently enforce. Anything else fails closed —
   * a sandbox alone never transports a canonical grant.
   */
  function canonicalGrantFor(
    input: CanonicalProviderRunInput<CodingState>,
  ): CodingAgentCanonicalExecution | undefined {
    const frozen = input.runPolicy?.executionPolicy;
    if (!frozen) return undefined;
    if (!capability) throw new Error("Provider requires qualified canonical execution");
    const qualified = qualifiedCanonicalCodexPolicy(capability, input.permissionMode, frozen.workspaceScope);
    if (!qualified || canonicalJsonStringify(qualified) !== canonicalJsonStringify(frozen)) {
      throw new Error("Provider requires qualified canonical execution");
    }
    return CodingAgentCanonicalExecutionSchema.parse({
      executionPolicy: frozen,
      inventory: canonicalGrantDescriptors(capability),
      identity: { owner: input.owner, chatId: input.chatId, runId: input.runId },
      ...(capability.authFile ? { authFile: capability.authFile } : {}),
    });
  }

  function registerSteerRun(
    runId: string,
    value: { ownerId: string; chatId: string; threadId: string; legacyTurnId?: string; canonical?: boolean; executionPolicy?: CanonicalExecutionPolicy },
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
    // Drivers that cannot transport the server-only canonical grant to a
    // constrained runner never execute a frozen policy. A sandbox is not a
    // tool allowlist.
    if (input.runPolicy?.executionPolicy && !capability) {
      throw new Error("Provider requires qualified canonical execution");
    }
    const mode = AgentModeSchema.safeParse(input.interactionMode);
    if (!mode.success) throw new Error("Unsupported canonical coding Provider mode");
    return { input, mode: mode.data };
  }

  async function stopUnprojectedRun(input: CanonicalProviderRunInput<CodingState>, threadId: string, scope: CodingAbortScope) {
    try {
      await boundedOperation(() => options.threads.abortThread(
        principal(input.owner.ownerId), threadId, legacyRequestId(input.runId), scope,
      ), 10_000);
    } catch (error) {
      input.onCleanupUnconfirmed?.();
      throw error;
    }
  }

  const adapter: CanonicalChatProviderAdapter<CodingState> = {
    driverKind: kind,
    stateSchemaVersion: 1,
    ...(capability ? {
      qualifyPolicy: async (input: ActionQualificationInput) =>
        qualifiedCanonicalCodexPolicy(capability, input.permissionMode, input.workspaceScope),
    } : {}),
    parseState: (value) => CodingChatStateSchema.parse(value),
    serializeState: (value) => CodingChatStateSchema.parse(value),
    ...(options.providerId === "codex" ? {
      async isBackingRunActive(input: { owner: CanonicalProviderRunInput["owner"]; state: CodingState; signal: AbortSignal }) {
        input.signal.throwIfAborted();
        const state = CodingChatStateSchema.parse(input.state);
        const snapshot = await options.threads.getThread(principal(input.owner.ownerId), state.conversationId);
        input.signal.throwIfAborted();
        return ["queued", "starting", "running", "waiting_for_approval", "waiting_for_input"].includes(snapshot.thread.status);
      },
    } : {}),
    detachOnShutdown: options.providerId === "codex",
    async recover(input) {
      const state = CodingChatStateSchema.parse(input.state);
      return recoverCodingRun({ ...input, state, includePending: options.providerId === "codex",
        read: (cursor) => options.threads.getThread(principal(input.owner.ownerId), state.conversationId, cursor),
      });
    },
    async *start(inputValue) {
      const { input, mode } = validate(inputValue);
      const inbox = new ThreadEventInbox(input.signal);
      const buffered: Array<{ threadId: string; events: AgentThreadEvent[]; tokenUsage?: AiTokenUsage }> = [];
      let bufferedEventCount = 0;
      let bufferedEventBytes = 0;
      let targetThreadId: string | undefined;
      let terminalObserved = false;
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
          buffered.push({
            threadId: published.threadId,
            events: published.events,
            ...(published.tokenUsage ? { tokenUsage: published.tokenUsage } : {}),
          });
        } else if (published.threadId === targetThreadId) {
          inbox.push(published.events, published.tokenUsage);
        }
      });
      try {
        const requestId = legacyRequestId(input.continuationId ?? input.runId);
        // The grant leaves this process only through the internal createThread
        // argument — never inside the client-shaped thread request.
        const canonicalExecution = canonicalGrantFor(input);
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
        }, canonicalExecution ? { canonicalExecution } : undefined);
        targetThreadId = created.snapshot.thread.id;
        releaseSteerRun = registerSteerRun(input.runId, {
          ownerId: input.owner.ownerId,
          chatId: input.chatId,
          threadId: targetThreadId,
          ...(canonicalExecution ? { canonical: true, executionPolicy: canonicalExecution.executionPolicy } : {}),
        });
        for (const published of buffered) {
          if (published.threadId === targetThreadId) inbox.push(published.events, published.tokenUsage);
        }
        yield { type: "state.updated", state: recoveryState(targetThreadId, input.runId, created.snapshot.events.items, canonicalExecution !== undefined) };
        inbox.reconcileWith(async () => {
          const recovered = await options.threads.getThread(principal(input.owner.ownerId), targetThreadId!, inbox.lastEventId);
          return recovered.events.items;
        });
        for await (const event of normalizedEvents(created.snapshot.events.items, inbox, options.providerId, options.toolOutputKey)) {
          if (event.type === "run.completed") terminalObserved = true;
          yield event;
        }
      } finally {
        releaseSteerRun?.();
        sink.dispose();
        // for-await consumer failures call return(), not throw(). Settle the
        // accepted native run before returning control to Chat's failure path.
        if (options.providerId === "codex" && targetThreadId && !terminalObserved && !(input.signal.reason instanceof BackgroundProjectionDetached)) {
          await stopUnprojectedRun(input, targetThreadId, { initialRequestId: legacyRequestId(input.runId) });
        }
      }
    },
    async *resume(inputValue) {
      const { input } = validate(inputValue);
      const state = CodingChatStateSchema.parse(input.resumeState);
      // A canonical thread is one immutable isolated turn. Native continuation
      // is structurally absent, so resume must fail closed rather than attach
      // a turn the runner is forbidden to accept.
      if (state.canonical) throw new Error("Provider requires qualified canonical execution");
      const targetThreadId = state.conversationId;
      const inbox = new ThreadEventInbox(input.signal);
      let releaseSteerRun: (() => void) | undefined;
      let admittedTurnId: string | undefined;
      let terminalObserved = false;
      let restartFresh = false;
      const sink = options.threads.registerEventSink((published) => {
        if (published.ownerId === input.owner.ownerId && published.threadId === targetThreadId) {
          inbox.push(published.events, published.tokenUsage);
        }
      });
      try {
        const requestId = legacyRequestId(input.continuationId ?? input.runId);
        const accepted = await options.threads.acceptTurn(principal(input.owner.ownerId), targetThreadId, {
          message: input.prompt,
          attachments: attachments(input),
          model: input.selection.model,
          modelOptions: input.selection.options ?? [],
          ...permissions(input.permissionMode, options.providerId),
          clientRequestId: requestId,
        });
        admittedTurnId = accepted.turnId;
        releaseSteerRun = registerSteerRun(input.runId, {
          ownerId: input.owner.ownerId,
          chatId: input.chatId,
          threadId: targetThreadId,
          legacyTurnId: accepted.turnId,
        });
        const current = await options.threads.getThread(principal(input.owner.ownerId), targetThreadId);
        yield { type: "state.updated", state: recoveryState(targetThreadId, input.continuationId ?? input.runId, current.events.items) };
        inbox.lastEventId = current.events.items.at(-1)?.eventId;
        inbox.reconcileWith(async () => {
          const recovered = await options.threads.getThread(principal(input.owner.ownerId), targetThreadId, inbox.lastEventId);
          return recovered.events.items;
        });
        for await (const event of normalizedEvents(eventsForAcceptedRun(current, requestId), inbox, options.providerId, options.toolOutputKey)) {
          if (event.type === "run.completed") terminalObserved = true;
          yield event;
        }
      } catch (error) {
        // A failed initial launch can persist a Chat reference before the
        // provider establishes resumable state. Replace only that stale seam;
        // ordinary admission and capacity failures must continue to fail closed.
        if (error instanceof CodingAgentTurnError && error.code === "thread_not_resumable") {
          restartFresh = true;
        } else {
          throw error;
        }
      } finally {
        releaseSteerRun?.();
        sink.dispose();
        if (options.providerId === "codex" && admittedTurnId && !terminalObserved && !(input.signal.reason instanceof BackgroundProjectionDetached)) {
          await stopUnprojectedRun(input, targetThreadId, { turnId: admittedTurnId });
        }
      }
      if (restartFresh) yield* adapter.start(inputValue);
    },
    async steer(input) {
      const active = activeSteerRuns.get(input.runId);
      if (!active || active.ownerId !== input.owner.ownerId || active.canonical) {
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
      const state = CodingChatStateSchema.parse(input.state);
      await options.threads.abortThread(
        principal(input.owner.ownerId),
        state.conversationId,
        legacyRequestId(input.runId),
        ...(options.providerId === "codex" ? [{ runRequestId: legacyRequestId(state.runId ?? input.runId) }] : []),
      );
    },
    ...(options.nativeInputProvider?.deferInput ? { deferInput: async (input: { owner: CanonicalProviderRunInput["owner"]; chatId: string; runId: string; requestId: string }) => {
      const active = activeSteerRuns.get(input.runId);
      if (!active || active.ownerId !== input.owner.ownerId || active.chatId !== input.chatId
        || (active.canonical && (!active.executionPolicy || active.executionPolicy.actionMode !== "canonical_actions"
          || active.executionPolicy.delegation))) throw new Error("Input Run unavailable");
      const snapshot = await options.threads.getThread(principal(input.owner.ownerId), active.threadId);
      const requested = snapshot.events.items.some(event => event.type === "user_input.requested" && event.request.requestId === input.requestId);
      const resolved = snapshot.events.items.some(event => event.type === "user_input.answered" && event.requestId === input.requestId);
      if (!requested || resolved) throw new Error("Input unavailable");
      await options.nativeInputProvider!.deferInput!({ principal: principal(input.owner.ownerId), thread: snapshot.thread, inputRequestId: input.requestId });
    } } : {}),
    async submitInput(input) {
      const active = activeSteerRuns.get(input.runId);
      if (!active || active.ownerId !== input.owner.ownerId || active.chatId !== input.chatId
        || (active.canonical && (!active.executionPolicy || active.executionPolicy.actionMode !== "canonical_actions"
          || active.executionPolicy.delegation))) {
        throw new ChatInputNotDeliveredError();
      }
      const current = await options.threads.getThread(principal(input.owner.ownerId), active.threadId);
      let correlationId: string | undefined;
      for (const event of current.events.items) {
        if (event.type === "user_input.requested" && event.request.requestId === input.requestId) correlationId = event.request.correlationId;
        if (event.type === "user_input.answered" && event.requestId === input.requestId) correlationId = undefined;
      }
      if (!correlationId) throw new ChatInputNotDeliveredError();
      await options.threads.submitInput(principal(input.owner.ownerId), active.threadId, input.requestId, {
        answer: input.answer ?? Object.values(input.structuredAnswers ?? {}).flat().join("\n"),
        ...(input.structuredAnswers ? { structuredAnswers: input.structuredAnswers } : {}),
        clientRequestId: input.clientRequestId, correlationId,
      });
    },
    async submitApproval(input) {
      if (!input.state) throw new Error("Canonical coding Provider approval state unavailable");
      const state = CodingChatStateSchema.parse(input.state);
      // Canonical runs only carry authority-bound `action_` approvals handled
      // by the orchestrator; the native provider approval path is absent.
      if (state.canonical) throw new Error("Canonical coding Provider approval request unavailable");
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
  return adapter;
}
