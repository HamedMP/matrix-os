import { query } from "@anthropic-ai/claude-agent-sdk";
import { kernelOptions, type KernelConfig } from "./options.js";

export interface KernelResult {
  sessionId: string;
  result?: string;
  cost: number;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  errors?: string[];
}

export type KernelEvent =
  | { type: "init"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_start"; tool: string }
  | { type: "tool_end"; input?: Record<string, unknown> }
  | { type: "result"; data: KernelResult }
  | { type: "aborted" };

export async function* spawnKernel(
  message: string,
  config: KernelConfig,
  /** Optional controller -- when aborted, the SDK halts and the generator
      yields a final `aborted` event before completing. Callers (gateway
      dispatcher) maintain a Map<requestId, AbortController> and call
      `.abort()` on the user's stop request. */
  abortController?: AbortController,
): AsyncGenerator<KernelEvent> {
  const opts = kernelOptions(config);

  // If resuming fails (stale session ID after container upgrade), retry without resume
  let retried = false;

  async function* run(options: typeof opts): AsyncGenerator<KernelEvent> {
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
      if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
        yield { type: "init", sessionId: msg.session_id };
        continue;
      }

      if (msg.type === "stream_event") {
        const event = msg.event as Record<string, unknown>;

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
        const usage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        const base = {
          sessionId: msg.session_id,
          cost: msg.total_cost_usd,
          turns: msg.num_turns,
          tokensIn: usage?.input_tokens ?? 0,
          tokensOut: usage?.output_tokens ?? 0,
        };

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
