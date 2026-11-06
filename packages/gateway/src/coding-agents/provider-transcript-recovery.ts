import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { CodingAgentProviderAdapter, CodingAgentProviderResumeState } from "./provider-adapter.js";
import type { WorkspaceSessionOrchestrator } from "../workspace-session-orchestrator.js";
import type { CodexControlClient } from "./codex-control-client.js";
import type { CodexExecutionAdmission } from "./codex-execution-admission.js";
import type { BackgroundAgentRuntime } from "../background-agent-runtime.js";
import type { AgentThreadEvent } from "@matrix-os/contracts";
import { completionEvents } from "./codex-terminal-events.js";
import { z } from "zod/v4";
import type { StoredThreadState } from "./thread-store.js";
import { boundedOperation } from "../bounded-operation.js";

export interface ProviderIdleObservation {
  ownerId: string;
  backgroundRefId: string;
  sessionId: string;
  providerThreadId: string;
  requestId?: string;
}

const CursorSchema = z.object({
  sessionId: z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/),
  expectedOffset: z.number().int().min(1).max(16 * 1024 * 1024),
  generation: z.uuid().optional(),
}).strict();

export function providerTranscriptUnavailable(thread: StoredThreadState["threads"][number], events: readonly AgentThreadEvent[]): boolean {
  const error = events.findLast(event => event.threadId === thread.id && event.type === "thread.error");
  return thread.providerId === "codex" && thread.status === "failed"
    && error?.type === "thread.error" && ["agent_history_unavailable", "agent_transcript_interrupted"].includes(error.error.code);
}

/** Called under the existing owner-store mutation lock; no native prompt is sent. */
export async function applyProviderTranscriptRecovery(state: StoredThreadState, input: {
  ownerId: string;
  threadId: string;
  cursor: z.input<typeof CursorSchema>;
  proveIdle: (observation: ProviderIdleObservation) => Promise<boolean>;
  now: () => Date;
  nextEventId: () => string;
}) {
  const cursor = CursorSchema.parse(input.cursor);
  const thread = state.threads.find(candidate => candidate.id === input.threadId && candidate.ownerId === input.ownerId);
  if (!thread || thread.providerId !== "codex" || thread.activeTurnId
    || !["queued", "starting", "running", "waiting_for_approval", "waiting_for_input"].includes(thread.status)
    || thread.providerResumeState?.conversationId !== cursor.sessionId
    || thread.providerEventOffset !== cursor.expectedOffset || !thread.providerResumeState.providerThreadId
    || thread.providerResumeState.eventGeneration !== cursor.generation
    || !thread.providerResumeState.backgroundRef) {
    return { state, result: [] as AgentThreadEvent[] };
  }
  const observation: ProviderIdleObservation = { ownerId: input.ownerId, backgroundRefId: thread.providerResumeState.backgroundRef.id,
    sessionId: cursor.sessionId, providerThreadId: thread.providerResumeState.providerThreadId,
    ...(thread.deliveredTurnId ? { requestId: `req_${thread.deliveredTurnId.slice("turn_".length)}` } : {}) };
  if (!await boundedOperation(() => input.proveIdle(observation), 5_000)) {
    return { state, result: [] as AgentThreadEvent[] };
  }
  const occurredAt = input.now().toISOString();
  const events = completionEvents({ threadId: thread.id, outcome: "failed", failureReason: "transcript_interrupted",
    occurredAt, nextEventId: input.nextEventId });
  // A shorter stream cannot prove which output/terminal belongs to this turn.
  // Preserve committed text and report lost history rather than fabricate success.
  const { deliveredTurnId: _delivered, ...rest } = thread;
  const next = { ...rest, providerResumeState: { ...thread.providerResumeState, eventStreamInterrupted: true },
    status: "failed" as const, attention: "failed" as const, updatedAt: occurredAt };
  return { state: { ...state, threads: state.threads.map(candidate => candidate === thread ? next : candidate),
    events: [...state.events, ...events] }, result: events };
}

export interface ProviderObservationResume {
  turnId: string;
  resumeState: CodingAgentProviderResumeState;
  proveStopped: (signal: AbortSignal) => Promise<boolean>;
}

async function observation(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error("Provider observation unavailable");
    return { size: info.size, identity: `${info.dev}:${info.ino}:${info.birthtimeMs}` };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { size: 0, identity: "missing" };
    throw error;
  }
}

/** Runs under the owner mutation queue, before the accepted prompt can be dispatched. */
export async function prepareProviderObservation(state: StoredThreadState, input: {
  homePath: string; ownerId: string; threadId: string; sessionId: string; resume: ProviderObservationResume;
}) {
  z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/).parse(input.sessionId);
  const thread = state.threads.find(candidate => candidate.ownerId === input.ownerId && candidate.id === input.threadId);
  const expected = input.resume.resumeState;
  const current = thread?.providerResumeState;
  const turn = state.turns.find(candidate => candidate.ownerId === input.ownerId && candidate.threadId === input.threadId && candidate.turnId === input.resume.turnId);
  if (!thread || thread.providerId !== "codex" || thread.activeTurnId !== input.resume.turnId
    || !turn || !["accepted", "running"].includes(turn.status) || !current
    || current.conversationId !== input.sessionId || current.conversationId !== expected.conversationId
    || !current.providerThreadId || current.providerThreadId !== expected.providerThreadId
    || !current.backgroundRef || current.backgroundRef.id !== expected.backgroundRef?.id
    || current.nativeAccountBinding !== expected.nativeAccountBinding
    || current.eventGeneration !== expected.eventGeneration) throw new Error("Provider observation identity changed");
  const path = join(input.homePath, "system", "coding-agents", "provider-events", `${input.sessionId}.jsonl`);
  const before = await observation(path);
  if (!current.eventStreamInterrupted && before.size >= Math.max(thread.providerEventOffset ?? 0, current.eventOffset ?? 0)) {
    return { state, result: undefined };
  }
  if (!await boundedOperation(input.resume.proveStopped, 5_000)) throw new Error("Provider execution stop unconfirmed");
  const after = await observation(path);
  if (after.identity !== before.identity || after.size !== before.size) throw new Error("Provider observation changed during recovery");
  const generation = randomUUID();
  const next = { ...thread, providerEventOffset: after.size, providerResumeState: {
    ...current, eventGeneration: generation, eventOffset: after.size, eventStreamInterrupted: false,
  } };
  return { state: { ...state, threads: state.threads.map(candidate => candidate === thread ? next : candidate) },
    result: { offset: after.size, generation } };
}

export function retainedProviderSessions(state: StoredThreadState): string[] {
  return state.threads.filter(thread => thread.providerId === "codex")
    .flatMap(thread => [`sess_${thread.id.slice("thread_".length)}`, ...(thread.providerResumeState ? [thread.providerResumeState.conversationId] : [])]);
}

type Input = Parameters<NonNullable<CodingAgentProviderAdapter["prepareHistoryResume"]>>[0];

/** Stops only an idle or already-stopped exact incarnation; never interrupts uncertain work. */
export async function proveCodexResumeStopped(input: Input, options: {
  runtime: Partial<Pick<WorkspaceSessionOrchestrator, "getSession" | "withSessionStart">>;
  control?: CodexControlClient;
  backgroundRuntime?: Pick<BackgroundAgentRuntime, "isRunning" | "stop">;
  admission?: CodexExecutionAdmission;
}): Promise<boolean> {
  const { principal, thread, resumeState, signal } = input;
  signal.throwIfAborted();
  const sessionId = `sess_${thread.id.slice("thread_".length)}`;
  if (resumeState.conversationId !== sessionId || !resumeState.providerThreadId || !resumeState.backgroundRef
    || !options.runtime.getSession || !options.runtime.withSessionStart || !options.control?.hibernate || !options.backgroundRuntime) return false;
  return options.runtime.withSessionStart(principal.userId, sessionId, async () => {
  await options.admission?.validate(principal.userId, resumeState.nativeAccountBinding, sessionId);
  signal.throwIfAborted();
  const readExact = async () => {
    const current = await options.runtime.getSession!(sessionId);
    signal.throwIfAborted();
    if (!current.ok || current.session.id !== sessionId || current.session.ownerId !== principal.userId
      || current.session.kind !== "agent" || current.session.agent !== "codex"
      || current.session.projectSlug !== thread.projectId || current.session.runtime.type !== "background"
      || current.session.backgroundRef?.id !== resumeState.backgroundRef!.id) throw new Error("Native resume identity unavailable");
    return current.session;
  };
  await readExact();
  const capturedRef = resumeState.backgroundRef!;
  const alive = await options.backgroundRuntime!.isRunning(capturedRef);
  signal.throwIfAborted();
  if (typeof alive !== "boolean") return false;
  if (alive !== false) {
    // The handshake reserves the idle boundary against queued input synchronously.
    await options.control!.hibernate!({ sessionId, providerThreadId: resumeState.providerThreadId!,
      clientRequestId: `req_resume_${thread.id.slice("thread_".length)}` });
    signal.throwIfAborted();
  }
  await readExact();
  await options.backgroundRuntime!.stop(capturedRef);
  signal.throwIfAborted();
  await readExact();
  const stillRunning = await options.backgroundRuntime!.isRunning(capturedRef);
  signal.throwIfAborted();
  return stillRunning === false;
  });
}
