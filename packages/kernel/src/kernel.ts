import { query } from "@anthropic-ai/claude-agent-sdk";
import { kernelOptions, type KernelConfig } from "./options.js";

export interface KernelResult {
  sessionId: string;
  result?: string;
  cost: number;
  turns: number;
  errors?: string[];
}

export type KernelEvent =
  | { type: "init"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_start"; tool: string }
  | { type: "tool_end" }
  | { type: "result"; data: KernelResult };

export async function* spawnKernel(
  message: string,
  config: KernelConfig,
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
      },
    });

    let activeTool: string | null = null;

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
            yield { type: "tool_start", tool: activeTool };
          }
        } else if (event.type === "content_block_delta") {
          const delta = (event as Record<string, Record<string, string>>).delta;
          if (delta?.type === "text_delta") {
            yield { type: "text", text: delta.text };
          }
        } else if (event.type === "content_block_stop" && activeTool) {
          yield { type: "tool_end" };
          activeTool = null;
        }
        continue;
      }

      if (msg.type === "result") {
        const base = {
          sessionId: msg.session_id,
          cost: msg.total_cost_usd,
          turns: msg.num_turns,
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
