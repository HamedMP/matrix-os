import { CanonicalChatToolOutputTextSchema } from "@matrix-os/contracts";
import { codexToolHasPrivateContext, codexToolOutput } from "../coding-agents/codex-tool-output.mjs";

// Reuse the pre-publication privacy boundary used by the detached Codex runner.
// Keep only a private-context bit between frames, never raw tool arguments.
export function hermesToolHasPrivateContext(args: unknown): boolean {
  const values = typeof args === "object" && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const command = values.command ?? values.cmd;
  return /\.ssh(?:[\\/]|\b)/i.test(JSON.stringify(args) ?? "")
    || codexToolHasPrivateContext({ arguments: args, command: typeof command === "string" ? command : "" });
}

export function hermesToolOutput(name: string, result: unknown, privateContext: boolean, protection?: { key: Buffer; toolCallId: string }) {
  const normalized = name.trim().toLowerCase();
  const supported = ["terminal", "shell", "bash", "execute", "execute_code", "run_command", "read", "read_file"].includes(normalized)
    || normalized.includes("mcp");
  if (!supported) return undefined;
  const record = typeof result === "object" && result !== null && !Array.isArray(result)
    ? result as Record<string, unknown> : undefined;
  // Recognized text envelopes only. Never stringify an arbitrary provider result,
  // error object, binary/image payload, or summary supplied alongside the result.
  const value = typeof result === "string" ? result
    : typeof record?.output === "string" ? record.output
    : typeof record?.content === "string" ? record.content
    : Array.isArray(record?.content) ? { content: record.content } : undefined;
  const output = codexToolOutput({ result: value }, privateContext, protection);
  if (!output) return undefined;
  const text = CanonicalChatToolOutputTextSchema.safeParse(output.text);
  return text.success ? { ...output, text: text.data } : undefined;
}
