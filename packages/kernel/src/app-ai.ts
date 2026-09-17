import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface AppTextOptions {
  prompt: string;
  model: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

/** A text-only SDK invocation, isolated from the owner's files and kernel tools. */
export async function generateAppText(options: AppTextOptions): Promise<{ text: string }> {
  options.signal.throwIfAborted();
  const cwd = await mkdtemp(join(tmpdir(), "matrix-app-ai-"));
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) controller.abort();
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const response = query({
      prompt: options.prompt,
      options: {
        cwd, env: options.env, model: options.model,
        abortController: controller,
        tools: [], mcpServers: {}, strictMcpConfig: true,
        settingSources: [], persistSession: false,
        systemPrompt: "Answer the supplied request using only the supplied text. You have no tools or access to files.",
        maxTurns: 1, maxBudgetUsd: 0.25,
        canUseTool: async () => ({ behavior: "deny" as const, message: "Tools are unavailable" }),
      },
    });
    try {
      for await (const message of response) {
        options.signal.throwIfAborted();
        if (message.type === "result") {
          if (message.subtype !== "success" || message.is_error || message.result.length > 64_000) {
            throw new Error("App AI generation failed");
          }
          return { text: message.result };
        }
      }
      throw new Error("App AI returned no result");
    } finally {
      response.close();
    }
  } finally {
    options.signal.removeEventListener("abort", abort);
    await rm(cwd, { recursive: true, force: true });
  }
}
