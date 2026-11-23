import { z } from "zod/v4";
import { NativeReferenceSchema } from "./codex-app-server-protocol.mjs";

// Bounds each discard step (waiting for thread/start, then thread/delete) so a
// failed account proof still fails closed promptly.
export const UNRECORDED_THREAD_DISCARD_TIMEOUT_MS = 3_000;

const StartedThreadSchema = z.object({ thread: z.object({ id: NativeReferenceSchema }).passthrough() }).passthrough();

function warn(step, error) {
  console.warn("[coding-agents] Unrecorded Codex thread discard skipped:", step, error instanceof Error ? error.name : "UnknownError");
}

function withDeadline(promise, timeoutMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("discard_timeout"), { name: "DiscardTimeout" })), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Best-effort deletion of a new native thread that was started concurrently
 * with an account proof that then failed. Matrix never recorded the thread
 * (no thread.started was persisted), so leaving it would orphan a Codex
 * conversation. Uses the qualified app-server `thread/delete` request
 * ({ threadId }). Never throws: the caller rethrows the proof error unchanged.
 *
 * @param {Promise<{ ok: true, value: unknown } | { ok: false, error: unknown }>} threadOutcome settled thread/start result
 * @param {(method: string, params: unknown, timeoutMs?: number) => Promise<unknown>} request app-server RPC
 */
export async function discardUnrecordedNativeThread(threadOutcome, request, timeoutMs = UNRECORDED_THREAD_DISCARD_TIMEOUT_MS) {
  let outcome;
  try {
    outcome = await withDeadline(threadOutcome, timeoutMs);
  } catch (error) {
    warn("thread_start", error);
    return false;
  }
  if (!outcome.ok) return false;
  const parsed = StartedThreadSchema.safeParse(outcome.value);
  if (!parsed.success) {
    warn("thread_identity", parsed.error);
    return false;
  }
  try {
    await request("thread/delete", { threadId: parsed.data.thread.id }, timeoutMs);
    return true;
  } catch (error) {
    warn("thread_delete", error);
    return false;
  }
}
