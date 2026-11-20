"use client";

import { ExternalLink, FileText, Link as LinkIcon, MessageSquarePlus, SquareTerminal, TerminalSquare, MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { BoardPicker } from "./BoardPicker.js";
import { agentStatusLabel } from "./board-format.js";
import { AgentStatusDot } from "./board-primitives.js";
import { chipButtonClass, focusRing, secondaryButtonClass, tone } from "./board-style.js";
import type { AttachableSession, ProjectTask, TaskSession } from "./types.js";

export type TaskDetailTab = "details" | string;

/**
 * The task's chats and terminals as tabs next to Details, plus the three ways
 * to add one. Each tab is labelled with its agent status in words, not only colour.
 */
export function TaskSessionTabs({ task, tab, onTabChange, onStart, loadAttachable, onAttach, busy }: {
  task: ProjectTask;
  tab: TaskDetailTab;
  onTabChange(tab: TaskDetailTab): void;
  onStart(kind: "chat" | "terminal"): void;
  loadAttachable(): Promise<readonly AttachableSession[]>;
  onAttach(session: AttachableSession): void;
  busy: boolean;
}) {
  const [attachable, setAttachable] = useState<readonly AttachableSession[]>([]);
  const sessionCount = task.sessions.length;
  useEffect(() => {
    let live = true;
    loadAttachable().then((sessions) => { if (live) setAttachable(sessions); }, (error: unknown) => {
      console.warn("[project-board] attachable sessions could not be loaded", error instanceof Error ? error.name : typeof error);
    });
    return () => { live = false; };
  }, [loadAttachable, sessionCount]);

  const tabClass = `flex h-8 max-w-[14rem] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] hover:bg-[var(--bg-hover)] aria-selected:bg-[var(--bg-hover)] aria-selected:font-medium ${focusRing}`;
  // Labels show when the sheet is wide; narrow sheets keep icon buttons with the same accessible names.
  const label = "hidden @3xl:inline";
  return <div className="@container flex items-center gap-2 border-b px-5 py-1.5" style={tone.border}>
    <div role="tablist" aria-label="Task views" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      <button type="button" role="tab" aria-selected={tab === "details"} onClick={() => onTabChange("details")} className={tabClass} style={tone.primary}>
        <FileText size={13} aria-hidden />Details
      </button>
      {task.sessions.map((session) => <button key={session.ref} type="button" role="tab" aria-selected={tab === session.ref}
        onClick={() => onTabChange(session.ref)} className={tabClass} style={tone.primary} title={session.title}
        aria-label={`${session.title}, ${session.kind}, agent ${agentStatusLabel(session.agentStatus).toLowerCase()}`}>
        {session.kind === "chat" ? <MessageSquare size={13} aria-hidden /> : <SquareTerminal size={13} aria-hidden />}
        <span className="truncate">{session.title}</span>
        <AgentStatusDot status={session.agentStatus} />
      </button>)}
    </div>
    <div className="flex shrink-0 items-center gap-0.5 border-l pl-2" style={tone.border}>
      <button type="button" className={chipButtonClass} style={tone.secondary} disabled={busy} onClick={() => onStart("chat")} aria-label="Start chat" title="Start chat">
        <MessageSquarePlus size={14} aria-hidden /><span className={label}>Start chat</span>
      </button>
      <button type="button" className={chipButtonClass} style={tone.secondary} disabled={busy} onClick={() => onStart("terminal")} aria-label="Start terminal" title="Start terminal">
        <TerminalSquare size={14} aria-hidden /><span className={label}>Start terminal</span>
      </button>
      <BoardPicker label="Attach existing" value="" align="end" emptyText="No unattached chats or terminals"
        options={attachable.map((session) => ({ value: session.ref, label: session.title,
          icon: session.kind === "chat" ? <MessageSquare size={13} aria-hidden /> : <SquareTerminal size={13} aria-hidden /> }))}
        onChange={(ref) => { const session = attachable.find((candidate) => candidate.ref === ref); if (session) onAttach(session); }}
        trigger={<><LinkIcon size={14} aria-hidden /><span className={label}>Attach existing</span></>}
        triggerClassName={chipButtonClass} />
    </div>
  </div>;
}

/**
 * A task's chat or terminal. The live Chat and Terminal render in their own
 * windows; this pane says what the session is and opens it there.
 */
export function TaskSessionPane({ session, onOpen }: { session: TaskSession; onOpen?: (session: TaskSession) => void }) {
  const kindLabel = session.kind === "chat" ? "Chat" : "Terminal";
  const status = agentStatusLabel(session.agentStatus);
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-y-auto px-5 py-10 text-center" data-slot="task-session-pane">
    <span aria-hidden="true" className="mb-1 grid size-10 place-items-center rounded-xl" style={{ background: "var(--bg-sunken, var(--muted))", ...tone.muted }}>
      {session.kind === "chat" ? <MessageSquare size={20} /> : <SquareTerminal size={20} />}
    </span>
    <h3 className="max-w-full truncate text-[15px] font-semibold" style={tone.primary}>{session.title}</h3>
    <p className="flex flex-wrap items-center justify-center gap-1.5 text-[13px]" style={tone.secondary}>
      <span>{session.harness ?? kindLabel}</span>
      <span aria-hidden>·</span>
      <span className="inline-flex items-center gap-1"><AgentStatusDot status={session.agentStatus} />Agent {status.toLowerCase()}</span>
      {session.role === "main" ? <span className="rounded-md px-1.5 text-[11px]" style={{ background: "var(--bg-sunken, var(--muted))" }}>main</span> : null}
    </p>
    <button type="button" className={`${secondaryButtonClass} mt-3`} disabled={!onOpen} onClick={() => onOpen?.(session)}
      title={onOpen ? undefined : `${kindLabel} can't be opened from here yet`}>
      <ExternalLink size={13} aria-hidden />Open in {kindLabel}
    </button>
  </div>;
}
