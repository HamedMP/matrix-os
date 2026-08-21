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
} from "lucide-react";
import { useState, type ComponentType, type CSSProperties } from "react";
import { CopyAction } from "./message";
import { Marker, MarkerContent, MarkerIcon } from "./marker";
import type {
  ConversationActivityPresentation,
  ConversationPresentationCallbacks,
} from "./presentation";

const ACTIVITY_ICON: Record<ConversationActivityPresentation["kind"], ComponentType<{ className?: string; style?: CSSProperties }>> = {
  command: SquareTerminal,
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
    <div className="group/activity flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-1">
        <Marker asChild>
          <button
            type="button"
            onClick={() => activity.detail && setOpen((value) => !value)}
            aria-expanded={open}
            aria-label={accessibleLabel}
            className="min-w-0 flex-1 rounded-md px-1 py-0.5 hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          >
            <MarkerIcon>
              <Icon className="size-3.5" style={{ color: "var(--text-tertiary)" }} />
            </MarkerIcon>
            <MarkerContent className="flex min-w-0 items-baseline gap-1.5">
              <span className="shrink-0 font-medium text-[var(--text-primary)]">{activity.label}</span>
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
              <LoaderCircle aria-hidden className="status-pulse size-3.5 shrink-0" />
            ) : activity.state === "failed" ? (
              <X aria-hidden className="size-3.5 shrink-0" style={{ color: "var(--danger)" }} />
            ) : activity.state === "stopped" ? (
              <Minus aria-hidden className="size-3.5 shrink-0" />
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
    <div className="flex min-w-0 flex-col gap-1.5">
      {previous.length > 0 ? (
        <button
          type="button"
          aria-expanded={showPrevious}
          aria-label={`${previous.length} previous tool ${previous.length === 1 ? "call" : "calls"}`}
          className="flex h-8 items-center rounded-lg px-2 text-left text-sm font-medium hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          style={{ color: "var(--text-secondary)" }}
          onClick={() => setShowPrevious((value) => !value)}
        >
          +{previous.length} previous tool {previous.length === 1 ? "call" : "calls"}
        </button>
      ) : null}
      {visible.map((activity) => (
        <ConversationActivity key={activity.id} activity={activity} callbacks={callbacks} />
      ))}
    </div>
  );
}
