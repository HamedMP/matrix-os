import { z } from "zod/v4";
import { isAllowedCommandPreview } from "../command-preview-policy.mjs";

/** Internal worker/broker display evidence, never a public Chat payload. */
export const BotToolDisplaySchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
  command: z.string().max(4000).refine(isAllowedCommandPreview).optional(),
  parameters: z.string().max(750).optional(),
  output: z.string().max(3000).optional(),
  truncated: z.boolean().optional(),
}).strict();
export type BotToolDisplay = z.infer<typeof BotToolDisplaySchema>;

const PARAMS = ["path", "relPath", "cwd", "service", "action", "serverId", "tool", "connectionId", "query", "pattern", "limit", "timeout", "offset", "length", "mimeType"] as const;
const PRIVATE_INPUT = /secret|password|credential|api[_-]?key|token|id_rsa|\.ssh\b|\.env\b|auth\.json/i;
export const BOT_TOOL_HIDDEN_OUTPUT = "Output withheld because it may contain private data.";
export const BOT_TOOL_EMPTY_OUTPUT = "No text result was returned.";
const bounded = (value: string, limit: number) => value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Tool arguments have already passed the model schema; still bound inspection. */
export function botToolDisplayInput(name: string, args: unknown): { display: BotToolDisplay; privateContext: boolean } {
  const values = record(args) ?? {};
  const nested = record(values.arguments) ?? record(values.params) ?? {};
  const display: BotToolDisplay = { name: /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name) ? name : "tool" };
  // Inspect values without serializing arbitrary objects into the display.
  let inspected = 0;
  function sensitive(value: unknown, depth: number): boolean {
    if (++inspected > 128 || depth > 4) return true;
    if (typeof value === "string") return value.length > 64 * 1024 || PRIVATE_INPUT.test(value) || (value.trim().length > 0 && !isAllowedCommandPreview(value.length <= 4000 ? value : value.slice(0, 4000)));
    if (Array.isArray(value)) return value.length > 32 || value.some(item => sensitive(item, depth + 1));
    const object = record(value);
    return object ? Object.entries(object).some(([key, item]) => PRIVATE_INPUT.test(key) || sensitive(item, depth + 1)) : false;
  }
  const privateContext = sensitive(args, 0);
  const command = nested.command ?? nested.cmd ?? values.command ?? values.cmd;
  if (typeof command === "string" && isAllowedCommandPreview(command)) display.command = command;
  const lines: string[] = [];
  for (const source of [values, nested]) {
    for (const field of PARAMS) {
      const value = source[field];
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
      const text = String(value);
      if (text.length <= 500 && (!text.trim() || isAllowedCommandPreview(text)) && !PRIVATE_INPUT.test(text)) lines.push(`${field}: ${text}`);
    }
  }
  if (lines.length) display.parameters = bounded(lines.join("\n"), 750);
  return { display, privateContext };
}

/** Only recognized text blocks; never stringify result/details/binary objects. */
export function botToolDisplayOutput(value: unknown, privateContext: boolean): Pick<BotToolDisplay, "output" | "truncated"> {
  if (privateContext) return { output: BOT_TOOL_HIDDEN_OUTPUT };
  const content = record(value)?.content;
  if (!Array.isArray(content)) return { output: "No displayable text result was recorded." };
  let output = ""; let truncated = false;
  for (const part of content.slice(0, 16)) {
    const block = record(part);
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    const text = block.text;
    // Scan before truncation: a credential later in a snapshot still hides it.
    if (text.trim() && !isAllowedCommandPreview(text.length > 4000 ? text.slice(0, 4000) : text)) return { output: BOT_TOOL_HIDDEN_OUTPUT };
    if (text.length > 64 * 1024) return { output: BOT_TOOL_HIDDEN_OUTPUT };
    for (let offset = 4000; offset < text.length; offset += 3900) {
      if (!isAllowedCommandPreview(text.slice(offset - 100, offset + 3900))) return { output: BOT_TOOL_HIDDEN_OUTPUT };
    }
    const next = `${output ? "\n" : ""}${text}`;
    truncated ||= output.length + next.length > 3000;
    output = bounded(output + next, 3000);
  }
  truncated ||= content.length > 16;
  return { output: output.trim() ? output : BOT_TOOL_EMPTY_OUTPUT, ...(truncated ? { truncated: true } : {}) };
}
