"use client";

import { useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { BrainButton } from "./brain-controls.js";
import { BRAIN_TONE } from "./brain-tone.js";
import { brainDay } from "./brain-format.js";
import { BrainBadge, BrainCite, BrainEmpty, BrainError, BrainView, type BrainScreenProps } from "./brain-ui.js";
import type { BrainBriefLine, BrainBriefView, BrainBriefWindow } from "./brain-types.js";
import { useBrainAction, useBrainLoad } from "./use-brain-load.js";

/** Today: the deterministic brief of the day or week; every line cites its documents. */
export function BrainToday({ api, projectId, onOpenSources }: BrainScreenProps) {
  const [span, setSpan] = useState<BrainBriefWindow>("day");
  const brief = useBrainLoad(() => api.brief(projectId, { window: span }), span);
  const rebuild = useBrainAction();

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Brief period" className="flex gap-1">
          {(["day", "week"] as const).map((value) => (
            <BrainButton key={value} size="sm" variant={span === value ? "secondary" : "ghost"}
              aria-pressed={span === value} disabled={rebuild.busy !== null} onClick={() => setSpan(value)}>
              {value === "day" ? "Today" : "This week"}
            </BrainButton>
          ))}
        </div>
        <BrainButton size="sm" variant="outline" className="ml-auto" disabled={rebuild.busy !== null}
          onClick={() => rebuild.run("rebuild", () => api.generateBrief(projectId, { window: span }), brief.replace)}>
          <RefreshCw className="size-4" aria-hidden="true" />
          {rebuild.busy === null ? "Rebuild" : "Rebuilding..."}
        </BrainButton>
      </div>
      {rebuild.error && <BrainError error={rebuild.error} onOpenSources={onOpenSources} />}
      <BrainView state={brief.state} label="Building the brief..." onRetry={brief.reload} onOpenSources={onOpenSources}>
        {(view) => <BriefBody view={view} onOpenSources={onOpenSources} />}
      </BrainView>
    </div>
  );
}

function BriefBody({ view, onOpenSources }: { readonly view: BrainBriefView; readonly onOpenSources: () => void }) {
  const { sections } = view;
  // An empty section says how it fills.
  const empty = (title: string) => (
    <BrainEmpty title={title}>
      Sync the sources and find claims in Sources, then rebuild the brief.{" "}
      <BrainButton size="sm" variant="link" onClick={onOpenSources}>Open Sources</BrainButton>
    </BrainEmpty>
  );
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <p className="text-xs text-muted-foreground">
        {view.window === "day" ? `Brief for ${view.date}` : `Week ending ${view.date}`}, built {brainDay(view.generatedAt)}
        {view.truncated ? ". Some sections were cut short." : "."}
      </p>
      {view.summary && <p className={`rounded-md p-3 text-sm ${BRAIN_TONE.panel}`}>{view.summary.text}</p>}
      <BriefLines title="Needs attention" lines={sections.attention} empty={empty("Nothing needs attention.")} />
      <BriefLines title="Decisions" lines={sections.decisions} empty={empty("No new decisions.")} />
      <BriefLines title="Risks" lines={sections.risks} empty={empty("No new risks.")} />
      <section aria-label="Changes" className="grid gap-2">
        <h2 className="text-sm font-semibold">Changes</h2>
        {sections.changes.length === 0 && empty("Nothing changed.")}
        {sections.changes.map((group) => (
          <div key={`${group.sourceId}:${group.label}`} className="grid gap-1">
            <h3 className="text-sm font-medium">
              {group.label} <span className="text-xs text-muted-foreground">{group.created} new, {group.revised} revised</span>
            </h3>
            <LineList lines={group.items} />
          </div>
        ))}
      </section>
      <BriefLines title="Commitments" lines={sections.commitments} empty={empty("No open commitments.")} />
    </div>
  );
}

function BriefLines({ title, lines, empty }: {
  readonly title: string; readonly lines: readonly BrainBriefLine[]; readonly empty: ReactNode;
}) {
  return (
    <section aria-label={title} className="grid gap-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      {lines.length === 0 ? empty : <LineList lines={lines} />}
    </section>
  );
}

function LineList({ lines }: { readonly lines: readonly BrainBriefLine[] }) {
  return (
    <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
      {lines.map((line) => (
        <li key={line.lineId} className={`grid min-w-0 gap-1 rounded-md border p-2 ${BRAIN_TONE.border}`}>
          <p className="break-words text-sm">{line.text}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {line.due && <BrainBadge tone="warn">Due {line.due}</BrainBadge>}
            {line.assignee && <BrainBadge>{line.assignee}</BrainBadge>}
            {line.severity && <BrainBadge tone={line.severity === "high" ? "warn" : "plain"}>{line.severity} risk</BrainBadge>}
            {line.cites.map((cite) => <BrainCite key={cite.documentId} cite={cite} shown={line.text} />)}
          </div>
        </li>
      ))}
    </ul>
  );
}
