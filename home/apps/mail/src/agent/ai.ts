/**
 * The Mail agent's only door to a model: `MatrixOS.ai.generate`, wrapped so
 * every call is bounded, cancellable and returns validated JSON or a typed
 * failure.
 */
import { MailAgentError, throwIfAborted } from "./errors";
import { parseLooseJson } from "./json";
import { MAX_PROMPT_CHARS, MAX_REPLY_CHARS } from "./limits";
import { buildPrompt } from "./prompt";

/** A text model. `generate` resolves the reply text. */
export interface MailAi {
  generate(prompt: string): Promise<string>;
}

interface BridgeAi {
  generate(input: { prompt: string }): Promise<{ text: string }>;
}

/** The model behind the injected bridge, or null when this host has none. */
export function bridgeMailAi(): MailAi | null {
  if (typeof window === "undefined") return null;
  const ai = (window as unknown as { MatrixOS?: { ai?: BridgeAi } }).MatrixOS?.ai;
  if (!ai || typeof ai.generate !== "function") return null;
  return {
    async generate(prompt) {
      const reply = await ai.generate({ prompt });
      return typeof reply?.text === "string" ? reply.text : "";
    },
  };
}

/** Checks a parsed value and returns it typed, or null when it does not fit. */
export type Validator<T> = (value: unknown) => T | null;

export interface GenerateOptions {
  signal?: AbortSignal;
}

async function ask(ai: MailAi, prompt: string, signal: AbortSignal | undefined): Promise<string> {
  throwIfAborted(signal);
  if (prompt.length > MAX_PROMPT_CHARS) throw new MailAgentError("prompt_too_large");
  let reply: string;
  try {
    reply = await ai.generate(prompt);
  } catch (error: unknown) {
    if (error instanceof MailAgentError) throw error;
    throw new MailAgentError("ai_failed");
  }
  throwIfAborted(signal);
  return typeof reply === "string" ? reply.slice(0, MAX_REPLY_CHARS) : "";
}

function read<T>(reply: string, validate: Validator<T>): T | null {
  const parsed = parseLooseJson(reply);
  return parsed.ok ? validate(parsed.value) : null;
}

/** The prompt for the one repair pass: the unusable reply, as untrusted data, and the shape it must take. */
export function repairPrompt(reply: string, schema: string): string {
  return buildPrompt({
    task: "The data below was meant to be one JSON value in the reply shape, but it could not be read. Return that JSON value, corrected. Keep its content; do not add new content.",
    schema,
    blocks: [{ label: "Unreadable reply", text: reply }],
  });
}

/**
 * Asks once, parses defensively, and when the reply is unusable asks once
 * more to repair it. Rejects with `MailAgentError` (`invalid_reply`,
 * `ai_failed`, `prompt_too_large` or `cancelled`).
 */
export async function generateJson<T>(ai: MailAi, prompt: string, validate: Validator<T>, schema: string, options: GenerateOptions = {}): Promise<T> {
  const first = await ask(ai, prompt, options.signal);
  const value = read(first, validate);
  if (value !== null) return value;
  const second = await ask(ai, repairPrompt(first, schema), options.signal);
  const repaired = read(second, validate);
  if (repaired !== null) return repaired;
  throw new MailAgentError("invalid_reply");
}
