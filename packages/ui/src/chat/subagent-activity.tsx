"use client";

import { useId, useState } from "react";
import { chatSubagentPresentation, type ChatSubagent } from "@matrix-os/contracts";

/** Shared Web Canvas, Web Desktop, Web Mobile and Electron Desktop child row. */
export function ConversationSubagentActivity({ agent }: { agent: ChatSubagent }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const view = chatSubagentPresentation(agent);
  return (
    <div className="flex w-full min-w-0 flex-col text-sm">
      <button type="button" aria-label={view.label} aria-expanded={open} aria-controls={detailId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-[var(--bg-hover,var(--muted))] focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
        <span aria-hidden title={view.role} className="flex size-6 shrink-0 items-center justify-center rounded-full border border-[var(--border-subtle,var(--border))] bg-[var(--bg-sunken,var(--muted))] text-xs font-medium">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" data-subagent-icon={view.icon}>
            {view.icon === "search" ? <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></>
              : view.icon === "code" ? <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16" />
              : view.icon === "review" ? <><path d="M9 3h6l5 3v6c0 5-8 9-8 9s-8-4-8-9V6z" /><path d="m8 12 3 3 5-6" /></>
              : <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M6 7v10m0-5h5a7 7 0 0 0 7-5" /></>}
          </svg>
        </span>
        <span className="truncate font-medium">{agent.name}</span>
        <span className="shrink-0 text-xs" style={{ color: "var(--text-secondary, var(--muted-foreground))" }}>{view.status}</span>
        <span aria-hidden className={`shrink-0 text-xs transition-transform ${open ? "rotate-90" : ""}`}>›</span>
      </button>
      {open ? <div id={detailId} className="mt-1 ml-4 space-y-2 border-l py-1 pl-4"
        style={{ borderColor: "var(--border-subtle, var(--border))", color: "var(--text-secondary, var(--muted-foreground))" }}>
        <p className="text-xs">{view.parent}</p>
        {view.sections.map((section) => <div key={section.title}>
          <p className="mb-1 text-xs font-medium">{section.title}</p>
          <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{section.text}</p>
        </div>)}
        {!view.sections.length ? <p className="text-xs">{view.empty}</p> : null}
      </div> : null}
    </div>
  );
}
