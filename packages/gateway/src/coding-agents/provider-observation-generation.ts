import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type { StoredThreadState } from "./thread-store.js";
import type { CodingAgentProviderResumeState } from "./provider-adapter.js";
import { boundedOperation } from "../bounded-operation.js";

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
