import type { AgentThreadEvent } from "@matrix-os/contracts";

// Structured, payload-free detail for one tool call. The chip expansion shows
// kind, outcome, duration, and output statistics — never raw provider output
// (see the "no raw payloads" invariant in
// specs/105-coding-agent-shells/desktop-agent-chat-experience.md and the
// pinned assertions in tests/desktop/coding-agent-workspace.test.tsx).
// Rendering bounded diffs/command output needs structured payload fields on
// the contract's tool events, which today carry only displayName/kind and an
// opaque bounded output text.

export type ToolCallEvent = Extract<AgentThreadEvent, { type: "tool.started" | "tool.output" | "tool.completed" }>;

/** Human-readable kind label ("file_change" → "File change"). */
export function toolKindLabel(kind: string | undefined): string {
  if (!kind) return "Tool";
  const words = kind.split(/[-_]/).filter(Boolean);
  if (words.length === 0) return "Tool";
  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** Started→completed wall-clock label ("400ms", "1.2s", "30s", "2m 5s"), or null. */
export function toolCallDurationLabel(events: ToolCallEvent[]): string | null {
  const started = events.find((event) => event.type === "tool.started");
  const completed = events.find((event) => event.type === "tool.completed");
  if (!started || !completed) return null;
  const ms = Date.parse(completed.occurredAt) - Date.parse(started.occurredAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${Math.round(seconds * 10) / 10}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function outcomeLabel(events: ToolCallEvent[]): string {
  const completed = events.find((event) => event.type === "tool.completed");
  if (!completed || completed.type !== "tool.completed") return "Running";
  if (completed.outcome === "success") return "Succeeded";
  if (completed.outcome === "failed") return "Failed";
  return "Cancelled";
}

function outputStatsLabel(events: ToolCallEvent[]): string {
  const outputs = events.filter((event) => event.type === "tool.output");
  if (outputs.length === 0) return "No captured output";
  return `${outputs.length} output ${outputs.length === 1 ? "chunk" : "chunks"}`;
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1">
      <span style={{ color: "var(--text-tertiary)" }}>{label}</span>
      <span className="font-medium" style={{ color: "var(--text-secondary)" }}>{value}</span>
    </span>
  );
}

export function ToolCallDetailMeta({ events }: { events: ToolCallEvent[] }) {
  const started = events.find((event) => event.type === "tool.started");
  const duration = toolCallDurationLabel(events);
  return (
    <div className="mb-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
      <MetaItem label="Kind" value={toolKindLabel(started?.type === "tool.started" ? started.kind : undefined)} />
      <MetaItem label="Status" value={outcomeLabel(events)} />
      {duration ? <MetaItem label="Duration" value={duration} /> : null}
      <MetaItem label="Output" value={outputStatsLabel(events)} />
    </div>
  );
}
