/**
 * One call to the model, with the checks every flow needs: the prompt fits
 * the bridge, a cancelled request stops, a failure is logged and reported
 * generically, a long reply is cut to the bound that is read, and a reply
 * that arrives after another document was opened is ignored.
 */

import { replyText } from "../../../_shared/office-ui/ai-access";
import { MAX_PROMPT_CHARS, MAX_REPLY_CHARS, MESSAGES } from "./constants";
import type { DocumentSession } from "../session/index";
import type { AssistantDeps, AssistantFailure } from "./types";

export type ModelReply =
  | { ok: true; text: string }
  | { ok: false; status: "cancelled" }
  | { ok: false; status: "failed"; reason: AssistantFailure; message: string };

export function failure(reason: AssistantFailure): { ok: false; status: "failed"; reason: AssistantFailure; message: string } {
  return { ok: false, status: "failed", reason, message: MESSAGES[reason] };
}

export function defaultLog(message: string, error: unknown): void {
  console.warn(message, error instanceof Error ? error.name : error);
}

export function promptBudget(deps: AssistantDeps): number {
  const asked = deps.promptBudget ?? MAX_PROMPT_CHARS;
  return Math.max(1_000, Math.min(MAX_PROMPT_CHARS, Math.floor(asked)));
}

/** A token that changes when another document becomes active. */
export function documentToken(session: DocumentSession): number {
  return session.getState().documentKey;
}

export async function callModel(deps: AssistantDeps, prompt: string, token: number, signal?: AbortSignal): Promise<ModelReply> {
  if (signal?.aborted) return { ok: false, status: "cancelled" };
  if (prompt.length < 1 || prompt.length > promptBudget(deps)) return failure("instruction_too_long");
  let text: string | null;
  try {
    // A refused call (no AI access for the app) resolves an error body without `text`: the assistant is unavailable.
    text = replyText(await deps.generate({ prompt }));
  } catch (error) {
    (deps.log ?? defaultLog)("docs assistant: the model call failed", error);
    return failure("unavailable");
  }
  if (signal?.aborted) return { ok: false, status: "cancelled" };
  if (text === null) return failure("unavailable");
  if (documentToken(deps.session) !== token || deps.session.document === null) return failure("document_changed");
  return { ok: true, text: text.length > MAX_REPLY_CHARS ? text.slice(0, MAX_REPLY_CHARS) : text };
}
