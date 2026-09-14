import {
  Check,
  ChevronRight,
  Eye,
  FilePenLine,
  LoaderCircle,
  Minus,
  Search,
  SquareTerminal,
  Wrench,
  X,
} from "@renderer/lib/hugeicons";
import { useState, type ComponentType, type CSSProperties } from "react";
import { CopyAction } from "./message";
import { Marker, MarkerContent, MarkerIcon } from "./marker";
import type {
  ConversationActivityPresentation,
  ConversationPresentationCallbacks,
} from "./presentation";

const ACTIVITY_ICON: Record<ConversationActivityPresentation["kind"], ComponentType<{ className?: string; style?: CSSProperties }>> = {
  phase: Wrench,
  reasoning: Eye,
  plan: Check,
  command: SquareTerminal,
  file_change: FilePenLine,
  mcp_tool: Wrench,
  dynamic_tool: Wrench,
  delegation: Wrench,
  web_search: Search,
  image_inspection: Eye,
  read: Eye,
  edit: FilePenLine,
  search: Search,
  tool: Wrench,
};

export function ConversationActivity({
  activity,
  callbacks,
}: {
  activity: ConversationActivityPresentation;
  callbacks: ConversationPresentationCallbacks;
}) {
  const [open, setOpen] = useState(false);
  const Icon = ACTIVITY_ICON[activity.kind];
  const accessibleLabel = activity.preview ? `${activity.label}: ${activity.preview}` : activity.label;

  return (
    <div className="group/activity flex w-fit max-w-full min-w-0 flex-col">
      <div className="flex w-fit max-w-full min-w-0 items-center gap-1">
        <Marker asChild>
          <button
            type="button"
            onClick={() => activity.detail && setOpen((value) => !value)}
            aria-expanded={open}
            aria-label={accessibleLabel}
            className="w-fit max-w-full min-w-0 rounded-md px-1 py-0.5 hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          >
            <MarkerIcon>
              <Icon className="size-3.5" style={{ color: "var(--text-tertiary)" }} />
            </MarkerIcon>
            <MarkerContent className="flex min-w-0 items-baseline gap-1.5">
              <span className={`shrink-0 font-medium text-[var(--text-primary)] ${activity.kind === "reasoning" && activity.state === "running" ? "shimmer" : ""}`}>
                {activity.label}
              </span>
              {activity.preview ? (
                <span
                  title={activity.preview}
                  className={activity.previewKind === "command"
                    ? "truncate rounded-md border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-secondary)]"
                    : activity.previewKind === "path"
                      ? "truncate rounded-md border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-secondary)]"
                      : "truncate font-mono text-xs text-[var(--text-tertiary)]"}
                >
                  {activity.preview}
                </span>
              ) : null}
            </MarkerContent>
            {activity.state === "running" ? (
              <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
            ) : activity.state === "failed" ? (
              <X aria-hidden className="size-3.5 shrink-0" style={{ color: "var(--danger)" }} />
            ) : activity.state === "stopped" ? (
              <Minus aria-hidden className="size-3.5 shrink-0" />
            ) : activity.state === "partial" ? (
              <Minus aria-hidden className="size-3.5 shrink-0" style={{ color: "var(--warning)" }} />
            ) : (
              <Check aria-hidden className="size-3.5 shrink-0" />
            )}
            {activity.detail ? (
              <ChevronRight
                aria-hidden
                className="size-3.5 shrink-0"
                style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms" }}
              />
            ) : null}
          </button>
        </Marker>
        {activity.copyText ? (
          <CopyAction
            text={activity.copyText}
            target={activity.kind === "command" ? "command" : "activity"}
            copyText={callbacks.copyText}
            className="opacity-0 transition-opacity group-hover/activity:opacity-100 group-focus-within/activity:opacity-100"
          />
        ) : null}
      </div>
      {open && activity.detail ? (
        <pre
          className="mt-1 ml-7 max-h-64 overflow-auto border-l pl-3 font-mono text-xs whitespace-pre-wrap wrap-break-word"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
        >
          {activity.detail}
        </pre>
      ) : null}
    </div>
  );
}

export function ConversationActivityGroup({
  activities,
  callbacks,
}: {
  activities: ConversationActivityPresentation[];
  callbacks: ConversationPresentationCallbacks;
}) {
  const [showPrevious, setShowPrevious] = useState(false);
  const previous = activities.slice(0, -1);
  const visible = showPrevious ? activities : activities.slice(-1);
  return (
    <div className="flex w-fit max-w-full min-w-0 flex-col gap-1.5">
      {previous.length > 0 ? (
        <button
          type="button"
          aria-expanded={showPrevious}
          aria-label={`${previous.length} previous ${previous.length === 1 ? "activity" : "activities"}`}
          className="flex h-8 items-center rounded-lg px-2 text-left text-sm font-medium hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          style={{ color: "var(--text-secondary)" }}
          onClick={() => setShowPrevious((value) => !value)}
        >
          +{previous.length} previous {previous.length === 1 ? "activity" : "activities"}
        </button>
      ) : null}
      {visible.map((activity) => (
        <ConversationActivity key={activity.id} activity={activity} callbacks={callbacks} />
      ))}
    </div>
  );
}
