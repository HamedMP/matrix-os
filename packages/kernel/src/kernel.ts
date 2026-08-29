import { kernelOptions, type KernelConfig } from "./options.js";

let _query: typeof import("@anthropic-ai/claude-agent-sdk").query | undefined;
async function getQuery() {
  if (!_query) {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    _query = sdk.query;
  }
  return _query;
}

export interface KernelResult {
  sessionId: string;
  result?: string;
  cost: number;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  model?: string;
  provider?: string;
  modelUsage?: KernelModelUsage[];
  errors?: string[];
}

export interface KernelModelUsage {
  model: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

export type KernelEvent =
  | { type: "init"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_start"; tool: string }
  | { type: "tool_end"; input?: Record<string, unknown> }
  | { type: "refusal"; reason: "model_refusal_no_fallback"; stopReason: "refusal" }
  | { type: "result"; data: KernelResult }
  | { type: "aborted" };

interface SdkModelUsageLike {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadInputTokens?: unknown;
  cacheCreationInputTokens?: unknown;
  costUSD?: unknown;
  canonicalModel?: unknown;
  provider?: unknown;
}

interface SdkResultLike {
  session_id: string;
  total_cost_usd: number;
  num_turns: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  modelUsage?: Record<string, SdkModelUsageLike>;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function safeCost(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function safeUsageLabel(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value)
    ? value
    : fallback;
}

export function normalizeSdkResult(message: SdkResultLike): KernelResult {
  const modelUsage = Object.entries(message.modelUsage ?? {}).map(([rawModel, usage]) => ({
    model: safeUsageLabel(usage.canonicalModel, safeUsageLabel(rawModel, "unknown")),
    ...(typeof usage.provider === "string"
      ? { provider: safeUsageLabel(usage.provider, "unknown") }
      : {}),
    inputTokens: safeCount(usage.inputTokens),
    outputTokens: safeCount(usage.outputTokens),
    cacheReadInputTokens: safeCount(usage.cacheReadInputTokens),
    cacheCreationInputTokens: safeCount(usage.cacheCreationInputTokens),
    costUsd: safeCost(usage.costUSD),
  }));
  if (modelUsage.length === 0) {
    return {
      sessionId: message.session_id,
      cost: safeCost(message.total_cost_usd),
      turns: safeCount(message.num_turns),
      tokensIn: safeCount(message.usage?.input_tokens),
      tokensOut: safeCount(message.usage?.output_tokens),
    };
  }

  const first = modelUsage[0];
  return {
    sessionId: message.session_id,
    cost: Number(modelUsage.reduce((total, usage) => total + usage.costUsd, 0).toFixed(12)),
    turns: safeCount(message.num_turns),
    tokensIn: modelUsage.reduce(
      (total, usage) => total
        + usage.inputTokens
        + usage.cacheReadInputTokens
        + usage.cacheCreationInputTokens,
      0,
    ),
    tokensOut: modelUsage.reduce((total, usage) => total + usage.outputTokens, 0),
    ...(first ? { model: first.model, ...(first.provider ? { provider: first.provider } : {}) } : {}),
    modelUsage,
  };
}

export function sdkSystemEvent(message: unknown): KernelEvent | null {
  if (typeof message !== "object" || message === null) return null;
  const value = message as Record<string, unknown>;
  if (value.type !== "system" || value.subtype !== "model_refusal_no_fallback") return null;
  return {
    type: "refusal",
    reason: "model_refusal_no_fallback",
    stopReason: "refusal",
  };
}

export async function* spawnKernel(
  message: string,
  config: KernelConfig,
  /** Optional controller -- when aborted, the SDK halts and the generator
      yields a final `aborted` event before completing. Callers (gateway
      dispatcher) maintain a Map<requestId, AbortController> and call
      `.abort()` on the user's stop request. */
  abortController?: AbortController,
): AsyncGenerator<KernelEvent> {
  const opts = await kernelOptions(config);

  // If resuming fails (stale session ID after container upgrade), retry without resume
  let retried = false;
  let refusalEmitted = false;

  async function* run(options: typeof opts): AsyncGenerator<KernelEvent> {
    const query = await getQuery();
    const response = query({
      prompt: message,
      options: {
        ...options,
        includePartialMessages: true,
        abortController,
        stderr: (data: Buffer | string) => {
          const line = data.toString().trim();
          if (line) console.error("[kernel:stderr]", line);
        },
      } as Parameters<typeof query>[0]["options"],
    });

    let activeTool: string | null = null;
    let toolInputBuf = "";

    for await (const msg of response) {
      const normalizedSystemEvent = sdkSystemEvent(msg);
      if (normalizedSystemEvent) {
        refusalEmitted = true;
        yield normalizedSystemEvent;
        continue;
      }
      if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
        yield { type: "init", sessionId: msg.session_id };
        continue;
      }

      if (msg.type === "stream_event") {
        const event = msg.event as unknown as Record<string, unknown>;

        if (event.type === "content_block_start") {
          const block = (event as Record<string, Record<string, string>>)
            .content_block;
          if (block?.type === "tool_use") {
            activeTool = block.name;
            toolInputBuf = "";
            yield { type: "tool_start", tool: activeTool };
          }
        } else if (event.type === "content_block_delta") {
          const delta = (event as Record<string, Record<string, string>>).delta;
          if (delta?.type === "text_delta") {
            yield { type: "text", text: delta.text };
          } else if (delta?.type === "input_json_delta" && activeTool) {
            toolInputBuf += delta.partial_json ?? "";
          }
        } else if (event.type === "content_block_stop" && activeTool) {
          let input: Record<string, unknown> | undefined;
          if (toolInputBuf) {
            try {
              input = JSON.parse(toolInputBuf);
            } catch (err) {
              console.warn("[kernel] failed to parse streamed tool input JSON:", err instanceof Error ? err.message : String(err));
            }
          }
          yield { type: "tool_end", input };
          activeTool = null;
          toolInputBuf = "";
        }
        continue;
      }

      if (msg.type === "result") {
        const base = normalizeSdkResult(msg);

        if (msg.subtype === "success") {
          yield { type: "result", data: { ...base, result: msg.result } };
        } else {
          yield { type: "result", data: { ...base, errors: msg.errors } };
        }
      }
    }
  }

  try {
    yield* run(opts);
  } catch (error) {
    // Aborted: SDK throws AbortError when controller fires. Convert to a
    // clean `aborted` event so dispatcher / gateway can treat it as a
    // normal terminal state instead of an exception.
    if (abortController?.signal.aborted) {
      yield { type: "aborted" };
      return;
    }
    if (refusalEmitted) return;
    // If we were resuming a session and it failed, retry without resume
    if (!retried && opts.resume) {
      retried = true;
      const { resume: _, ...optsWithoutResume } = opts;
      yield* run(optsWithoutResume);
    } else {
      throw error;
    }
  }
}
