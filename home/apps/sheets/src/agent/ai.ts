/**
 * The assistant's only door to a model: `window.MatrixOS.ai.generate`,
 * wrapped so every call is bounded in size and time and fails with a typed,
 * client-safe error.
 */

import { replyText } from "../../../_shared/office-ui/ai-access";
import type { AgentSession } from "./apply";
import { AI_TIMEOUT_MS, MAX_PROMPT_CHARS, MAX_REPLY_CHARS } from "./limits";

/** A text model. `generate` resolves the reply text. */
export interface SheetsAi {
  generate(prompt: string): Promise<string>;
}

interface BridgeAi {
  generate(input: { prompt: string }): Promise<{ text: string }>;
}

export type SheetsAgentErrorCode = "unavailable" | "prompt_too_large" | "ai_failed" | "timeout" | "cancelled" | "apply_failed" | "pending_change" | "stale";

const MESSAGES: Record<SheetsAgentErrorCode, string> = {
  unavailable: "The assistant is not available here.",
  prompt_too_large: "That request is too large for the assistant. Select a smaller range and try again.",
  ai_failed: "The assistant could not answer. Try again.",
  timeout: "The assistant took too long to answer. Try again.",
  cancelled: "Stopped.",
  apply_failed: "The changes could not be proposed. Nothing was changed.",
  pending_change: "Some of these cells already have a proposed change. Accept or reject it first, then try again.",
  stale: "The workbook changed while the assistant was answering, so its answer was set aside. Ask again.",
};

/** A failure with a sentence that is safe to show the owner. */
export class SheetsAgentError extends Error {
  readonly code: SheetsAgentErrorCode;

  constructor(code: SheetsAgentErrorCode) {
    super(MESSAGES[code]);
    this.name = "SheetsAgentError";
    this.code = code;
  }
}

/** The model behind the injected bridge, or null when this host has none. */
export function bridgeSheetsAi(target: unknown = typeof window === "undefined" ? undefined : window): SheetsAi | null {
  const ai = (target as { MatrixOS?: { ai?: BridgeAi | null } } | undefined)?.MatrixOS?.ai;
  if (ai === undefined || ai === null || typeof ai.generate !== "function") return null;
  return {
    async generate(prompt) {
      // A refused call (no AI access for Sheets) resolves an error body without `text`.
      const text = replyText(await ai.generate({ prompt }));
      if (text === null) throw new SheetsAgentError("unavailable");
      return text;
    },
  };
}

export interface AskOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  log?: (message: string, error: unknown) => void;
}

/** Sends one prompt. Rejects with {@link SheetsAgentError}; the reply is cut to the reply bound. */
export async function askModel(ai: SheetsAi | null, prompt: string, options: AskOptions = {}): Promise<string> {
  if (ai === null) throw new SheetsAgentError("unavailable");
  if (prompt.length === 0 || prompt.length > MAX_PROMPT_CHARS) throw new SheetsAgentError("prompt_too_large");
  const { signal } = options;
  if (signal?.aborted) throw new SheetsAgentError("cancelled");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SheetsAgentError("timeout")), options.timeoutMs ?? AI_TIMEOUT_MS);
    if (signal !== undefined) {
      onAbort = () => reject(new SheetsAgentError("cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  let waiting = true;
  try {
    const pending = Promise.resolve().then(() => ai.generate(prompt));
    // A reply that fails after a timeout or a stop has no one waiting for it: log it instead of leaving it unhandled.
    pending.catch((error: unknown) => {
      if (!waiting) options.log?.("a model reply failed after the assistant stopped waiting", error);
    });
    const reply = await Promise.race([pending, stop]);
    return typeof reply === "string" ? reply.slice(0, MAX_REPLY_CHARS) : "";
  } catch (error: unknown) {
    if (error instanceof SheetsAgentError) throw error;
    options.log?.("the assistant's model call failed", error);
    throw new SheetsAgentError("ai_failed");
  } finally {
    waiting = false;
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

export interface WorkbookQuestion extends AskOptions {
  ai: SheetsAi | null;
  session: Pick<AgentSession, "workbook" | "editMark">;
}

/**
 * Sends a prompt built from the workbook and returns the reply only when the
 * workbook is still the one the prompt describes: the same workbook (a reload
 * or another file replaces it) with no edit since. The owner may keep editing
 * while the model thinks, and a reply written for the earlier content could
 * otherwise overwrite those edits. Rejects with {@link SheetsAgentError}
 * `stale` when it changed.
 */
export async function askAboutWorkbook(question: WorkbookQuestion, prompt: string): Promise<string> {
  const { session } = question;
  const workbook = session.workbook;
  const mark = session.editMark();
  const reply = await askModel(question.ai, prompt, { signal: question.signal, timeoutMs: question.timeoutMs, log: question.log });
  if (session.workbook !== workbook || session.editMark() !== mark) throw new SheetsAgentError("stale");
  return reply;
}
