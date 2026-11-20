"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Calendar03Icon, Cancel01Icon, WorkflowSquare03Icon } from "@hugeicons/core-free-icons";
import type { MessageBoardClient } from "./client.js";
import { actorLabel, channelScopeLabel } from "./model.js";
import { chipClass, formatBoardTime, formatUntil, iconButtonClass, subtleBorder, textPrimary, textSecondary, textTertiary } from "./presentation.js";
import type { BoardSchedule, BoardWatcher, BoardWatcherAction } from "./types.js";
import type { MutationResult, Resource } from "./use-message-board.js";
import type { BoardSidePanel } from "./ChannelSidebar.js";

export interface AutomationPanelProps {
  panel: BoardSidePanel;
  watchers: Resource<BoardWatcher[]>;
  schedules: Resource<BoardSchedule[]>;
  viewerId: string;
  nowMs: number;
  mutate(work: (client: MessageBoardClient, board: string) => Promise<unknown>): Promise<MutationResult>;
  onClose(): void;
  onBack?: () => void;
  onOpenThread(id: string): void;
}

function describeAction(action: BoardWatcherAction): string {
  if (action.kind === "start") return `Start ${action.template} in ${action.project}`;
  if (action.kind === "send") return `Send to ${action.session}`;
  return `Run routine ${action.routine}`;
}

/** Watchers and schedules as simple lists; only the owner changes them. */
export function AutomationPanel({ panel, watchers, schedules, viewerId, nowMs, mutate, onClose, onBack, onOpenThread }: AutomationPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const run = async (work: (client: MessageBoardClient, board: string) => Promise<unknown>) => {
    setError(null);
    const result = await mutate(work);
    if (!result.ok) setError(result.error);
  };
  const resource = panel === "watchers" ? watchers : schedules;
  const title = panel === "watchers" ? "Watchers" : "Schedules";
  const description = panel === "watchers"
    ? "A watcher wakes an agent or routine when a matching post arrives. Each run spends from your AI budget."
    : "Posts that go out later, once or on a repeat. Agents use them to leave themselves follow-ups.";

  return <section aria-label={title} className="flex h-full min-h-0 flex-col">
    <header className="flex items-start gap-2 border-b px-3 pb-2.5 pt-2.5" style={subtleBorder}>
      {onBack ? <button type="button" aria-label="Back to channels" className={iconButtonClass} onClick={onBack}>
        <HugeiconsIcon icon={ArrowLeft01Icon} size={16} aria-hidden />
      </button> : null}
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-semibold" style={textPrimary}>{title}</h2>
        <p className="mt-0.5 text-xs" style={textTertiary}>{description}</p>
      </div>
      <button type="button" aria-label={`Close ${title}`} className={iconButtonClass} onClick={onClose}>
        <HugeiconsIcon icon={Cancel01Icon} size={15} aria-hidden style={textTertiary} />
      </button>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {error ? <p role="alert" className="pb-2 text-xs" style={{ color: "var(--danger-text)" }}>{error}</p> : null}
      {!resource.data
        ? <p role={resource.status === "error" ? "alert" : "status"} className="py-8 text-center text-xs" style={textTertiary}>{resource.status === "error" ? resource.error : "Loading…"}</p>
        : resource.data.length === 0
          ? <div className="flex flex-col items-center gap-1 py-10 text-center">
              <span aria-hidden className="mb-1 grid size-8 place-items-center rounded-lg" style={{ background: "var(--bg-sunken, var(--muted))", ...textTertiary }}>
                <HugeiconsIcon icon={panel === "watchers" ? WorkflowSquare03Icon : Calendar03Icon} size={16} />
              </span>
              <p className="text-[13.5px] font-medium" style={textPrimary}>No {title.toLowerCase()} yet</p>
              <p className="font-mono text-xs" style={textTertiary}>{panel === "watchers" ? "matrix board watchers create" : "matrix board schedule dev \"…\" --in 5m"}</p>
            </div>
          : panel === "watchers"
            ? <ul className="flex flex-col gap-2">{watchers.data!.map((watcher) => <li key={watcher.id}>
                <WatcherRow watcher={watcher} nowMs={nowMs} onToggle={(enabled) => void run((client, board) => client.setWatcherEnabled(board, watcher.id, enabled))} />
              </li>)}</ul>
            : <ul className="flex flex-col gap-2">{schedules.data!.map((schedule) => <li key={schedule.id}>
                <ScheduleRow schedule={schedule} viewerId={viewerId} nowMs={nowMs} onOpenThread={onOpenThread}
                  onCancel={() => void run((client, board) => client.cancelSchedule(board, schedule.id))} />
              </li>)}</ul>}
    </div>
  </section>;
}

function WatcherRow({ watcher, nowMs, onToggle }: { watcher: BoardWatcher; nowMs: number; onToggle(enabled: boolean): void }) {
  const filter = [channelScopeLabel(watcher.tail.channel), watcher.tail.label, watcher.tail.by].filter(Boolean).join(" · ");
  return <div className="rounded-[14px] border px-3 py-2.5" style={subtleBorder}>
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium" style={textPrimary}>{watcher.name}</span>
      <Switch checked={watcher.enabled} label={`${watcher.enabled ? "Pause" : "Resume"} ${watcher.name}`} onChange={onToggle} />
    </div>
    <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
      <dt style={textTertiary}>Watches</dt><dd className="truncate font-mono" style={textSecondary}>{filter}</dd>
      <dt style={textTertiary}>Does</dt><dd className="truncate" style={textSecondary}>{describeAction(watcher.action)}</dd>
      <dt style={textTertiary}>Runs</dt>
      <dd style={textSecondary}>{watcher.runsThisHour} of {watcher.maxRunsPerHour} this hour · {watcher.totalRuns} total{watcher.lastRunAt ? ` · last ${formatBoardTime(watcher.lastRunAt, nowMs)} ago` : ""}</dd>
    </dl>
    {!watcher.enabled ? <p className="mt-1.5 text-xs font-medium" style={{ color: "var(--warning-text)" }}>Paused</p> : null}
    {watcher.lastError ? <p className="mt-1 text-xs" style={{ color: "var(--danger-text)" }}>{watcher.lastError}</p> : null}
  </div>;
}

function ScheduleRow({ schedule, viewerId, nowMs, onCancel, onOpenThread }: {
  schedule: BoardSchedule; viewerId: string; nowMs: number; onCancel(): void; onOpenThread(id: string): void;
}) {
  const target = schedule.target;
  return <div className="rounded-[14px] border px-3 py-2.5" style={subtleBorder}>
    <p className="text-[13px]" style={textPrimary}>{schedule.text}</p>
    <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
      <dt style={textTertiary}>Posts to</dt>
      <dd className="truncate font-mono" style={textSecondary}>
        {target.kind === "thread"
          ? <button type="button" className="underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--primary,currentColor))]" onClick={() => onOpenThread(target.threadId)}>thread in #{target.channel}</button>
          : `#${target.channel}`}
      </dd>
      <dt style={textTertiary}>Next</dt>
      <dd style={textSecondary}>{formatUntil(schedule.nextRunAt, nowMs)}{schedule.every ? ` · every ${schedule.every}` : " · once"} · {schedule.runCount} posted</dd>
      <dt style={textTertiary}>By</dt><dd style={textSecondary}>{actorLabel(schedule.by, viewerId)}</dd>
    </dl>
    <div className="mt-2 flex justify-end">
      <button type="button" className={chipClass} style={{ color: "var(--danger-text)" }} onClick={onCancel}>Cancel schedule</button>
    </div>
  </div>;
}

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange(checked: boolean): void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
    className="relative h-5 w-9 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--primary,currentColor))] motion-reduce:transition-none"
    style={{ background: checked ? "var(--success)" : "var(--border-strong, var(--border))" }}>
    <span aria-hidden className="absolute top-0.5 size-4 rounded-full transition-[left] motion-reduce:transition-none"
      style={{ left: checked ? 18 : 2, background: "var(--bg-surface, white)" }} />
  </button>;
}
