import { redactAssistantPaths } from "../chat/safe-activity-projection.js";
import { BotToolDisplaySchema, CanonicalChatToolOutputTextSchema, BOT_TOOL_HIDDEN_OUTPUT, type BotEvent } from "@matrix-os/contracts";
import { isAllowedCommandPreview } from "@matrix-os/contracts/command-preview-policy";
import { codexToolOutput } from "../coding-agents/codex-tool-output.mjs";
import { sealToolPreview } from "../coding-agents/protected-tool-output.mjs";
import { CanonicalProviderRunEventSchema, type CanonicalProviderRunEvent } from "../chat/provider-adapter.js";

type Progress = Extract<BotEvent["event"], { type: "tool_progress" }>;
/** Revalidate untrusted worker evidence and seal before any canonical event is yielded. */
export function projectBotToolDisplay(event: Progress, id: string, label: string, key?: Buffer): CanonicalProviderRunEvent[] | undefined {
  const parsed = BotToolDisplaySchema.safeParse(event.display);
  if (!parsed.success) return undefined; // Old worker: retain its payload-free lifecycle.
  const display = parsed.data;
  const command = display.command && isAllowedCommandPreview(display.command) ? display.command : undefined;
  const status = event.phase === "started" || event.phase === "updated" ? "running" : event.phase;
  const activity = CanonicalProviderRunEventSchema.parse({ type: "agent.activity", activityId: id,
    kind: command ? "command" : "dynamic_tool", label: command ? "Run command" : label, status,
    ...(key && command ? { protectedPreview: sealToolPreview(key, id, command) } : {}) });
  const parameters = display.parameters && isAllowedCommandPreview(display.parameters)
    ? display.parameters.split("\n").map(line => {
      const safe = CanonicalChatToolOutputTextSchema.safeParse(redactAssistantPaths(line));
      return safe.success && codexToolOutput({ result: safe.data })?.text !== BOT_TOOL_HIDDEN_OUTPUT
        ? safe.data : "A parameter was withheld for display.";
    }).join("\n") : undefined;
  const result = display.output ?? "Waiting for tool output.";
  const filtered = codexToolOutput({ result });
  const safeResult = filtered?.text === BOT_TOOL_HIDDEN_OUTPUT ? filtered.text : result;
  const heading = status === "failed" ? "Tool failed" : status === "cancelled" ? "Tool stopped" : "Output";
  const text = `Tool: ${display.name}${parameters ? `\n${parameters}` : ""}\n\n${heading}:\n${safeResult}`;
  const output = codexToolOutput({ result: text }, false, key ? { key, toolCallId: id } : undefined);
  return [activity, ...(output ? [CanonicalProviderRunEventSchema.parse({ type: "tool.output", toolCallId: id,
    ...output, truncated: Boolean(output.truncated || display.truncated) })] : [])];
}
