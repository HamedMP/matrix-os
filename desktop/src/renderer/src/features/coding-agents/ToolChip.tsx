import { CanonicalChatAgentActivityPayloadSchema } from "@matrix-os/contracts";
import { Check, Eye, Minus, SquarePen, SquareTerminal, Wrench, X } from "@renderer/lib/hugeicons";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { Marker, MarkerContent, MarkerIcon } from "../chat/elements/marker";
import type { ToolEvent } from "./conversation-timeline";
import { ToolCallDetailMeta } from "./tool-call-detail";

function toolKindIcon(displayName: string) {
  if (/shell|command|terminal|bash|exec|run/i.test(displayName)) return SquareTerminal;
  if (/write|edit|apply|patch|create/i.test(displayName)) return SquarePen;
  if (/read|view|open|list|search|glob|grep/i.test(displayName)) return Eye;
  return Wrench;
}

// A tool call renders as a Marker-style one-line row: kind icon, heading
// (shimmering while the call runs), muted preview, and a trailing status
// glyph. Expansion reveals the same bounded detail copy the old cards showed
// — no raw payloads.
export function ToolChip({ events }: { events: ToolEvent[] }) {
  const [open, setOpen] = useState(false);
  const started = events.find((event): event is Extract<ToolEvent, { type: "tool.started" }> => event.type === "tool.started");
  const outputs = events.filter((event): event is Extract<ToolEvent, { type: "tool.output" }> => event.type === "tool.output");
  const completed = events.find((event): event is Extract<ToolEvent, { type: "tool.completed" }> => event.type === "tool.completed");
  const name = started?.displayName ?? "Tool";
  const fields = CanonicalChatAgentActivityPayloadSchema.shape;
  const preview = fields.preview.safeParse(started?.preview);
  const metadata = fields.detail.safeParse(started?.detail);
  const visiblePreview = preview.success ? preview.data : undefined;
  const visibleDetail = metadata.success ? metadata.data : undefined;
  const failed = completed?.outcome === "failed";
  const cancelled = completed?.outcome === "cancelled";
  const detail = completed
    ? `${name} completed ${completed.outcome === "success" ? "successfully" : completed.outcome === "failed" ? "with errors" : "cancelled"}${outputs.length ? (outputs.some((event) => event.truncated) ? " after receiving partial output" : " after receiving output") : " without captured output"}`
    : `${name} running${outputs.length ? " with output received" : ""}`;
  const KindIcon = toolKindIcon(name);
  const StatusIcon = completed ? (failed ? X : cancelled ? Minus : Check) : Minus;
  return (
    <div className="flex min-w-0 flex-col">
      <Marker asChild>
        <button
          type="button"
          className="rounded-md px-1 py-0.5 hover:bg-[var(--bg-hover)]"
          aria-label={`Tool call ${name}`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <MarkerIcon>
            <KindIcon className="size-3.5" style={{ color: "var(--text-tertiary)" }} />
          </MarkerIcon>
          <MarkerContent
            className={cn("shrink truncate text-[12px] font-medium", completed ? undefined : "shimmer")}
            style={{ color: failed ? "var(--danger)" : "var(--text-primary)" }}
          >
            {name}
          </MarkerContent>
          <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--text-tertiary)" }}>
            {visiblePreview ?? detail}
          </span>
          <StatusIcon
            className="size-3.5 shrink-0"
            style={{ color: failed ? "var(--danger)" : completed && !cancelled ? "var(--success)" : "var(--text-tertiary)" }}
            aria-label={completed ? (failed ? "Failed" : cancelled ? "Cancelled" : "Completed") : "Running"}
          />
        </button>
      </Marker>
      {open ? (
        <div className="mt-1 ml-7 border-l pl-3" style={{ borderColor: "var(--border-subtle)" }}>
          <ToolCallDetailMeta events={events} />
          <pre className="max-h-64 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--text-secondary)" }} data-selectable>
            {[visiblePreview, visibleDetail, detail].filter(Boolean).join("\n\n")}
            {outputs.some((event) => event.truncated) ? "\nOutput was truncated for display." : ""}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
