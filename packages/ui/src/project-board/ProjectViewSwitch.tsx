"use client";

import { focusRing, tone } from "./board-style.js";

export type ProjectHomeView = "overview" | "board";

const VIEWS: ReadonlyArray<{ id: ProjectHomeView; label: string }> = [{ id: "overview", label: "Overview" }, { id: "board", label: "Board" }];

/** Overview | Board switch on a project page, shared by every Desktop surface. */
export function ProjectViewSwitch({ view, onChange }: { view: ProjectHomeView; onChange(view: ProjectHomeView): void }) {
  return <div role="group" aria-label="Project view" className="flex items-center gap-0.5" data-slot="project-view-switch">
    {VIEWS.map(({ id, label }) => <button key={id} type="button" aria-pressed={view === id} onClick={() => onChange(id)}
      className={`h-8 rounded-lg px-2.5 text-[13px] hover:bg-[var(--bg-hover)] aria-pressed:bg-[var(--bg-hover)] aria-pressed:font-medium ${focusRing}`}
      style={view === id ? tone.primary : tone.secondary}>
      {label}
    </button>)}
  </div>;
}
