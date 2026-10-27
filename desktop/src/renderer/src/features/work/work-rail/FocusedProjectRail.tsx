import type { ReactNode } from "react";
import type { ChatNavigationRecord } from "@matrix-os/ui";
import { ChevronLeft, SquarePen as PencilEditIcon } from "lucide-react";
import type { Project } from "../../../stores/board";
import { buildWorkRailModel, type WorkRailProjectGroup } from "../work-rail-model";
import type { WorkRailSectionKey } from "./WorkRailGroups";
import { WorkRailSection } from "./WorkRailSection";

/** The focused Project's Chats, including pinned ones, as one lifecycle model. */
export function focusedProjectRecords(records: readonly ChatNavigationRecord[], group: WorkRailProjectGroup): ChatNavigationRecord[] {
  return records.filter((record) => record.projectId === group.id || record.projectId === group.slug);
}

/** Sidebar "zoomed" into one Project: its Chats grouped by lifecycle, with a way back. */
export function FocusedProjectRail({ group, records, sections, onToggle, renderChat, onBack, onNewChat }: {
  group: WorkRailProjectGroup;
  records: readonly ChatNavigationRecord[];
  sections: Record<WorkRailSectionKey, boolean>;
  onToggle: (key: WorkRailSectionKey) => void;
  renderChat: (record: ChatNavigationRecord, placement: "pinned" | "recent") => ReactNode;
  onBack: () => void;
  onNewChat: (project: Project) => void;
}) {
  // Without a Project reference the model places each Chat in its lifecycle group;
  // rows still receive the original record so Move, Delete and selection keep the Project.
  const grouped = buildWorkRailModel(records.map(({ projectId: _projectId, ...record }) => record), []);
  const originals = new Map(records.map((record) => [record.chat.id, record]));
  const restore = (list: readonly ChatNavigationRecord[]) => list.flatMap((record) => originals.get(record.chat.id) ?? []);
  const model = { pinned: restore(grouped.pinned), needsYou: restore(grouped.needsYou), working: restore(grouped.working), doneDisplay: restore(grouped.doneDisplay) };
  const empty = records.length === 0;
  return <>
    <div className="work-rail-project flex min-w-0 items-center gap-1 px-1 pb-1">
      <button type="button" aria-label="Back to all chats" title="Back to all chats"
        className="grid size-6 shrink-0 place-items-center rounded-[8px] outline-none hover:bg-[var(--bg-selected)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        onClick={onBack}>
        <ChevronLeft size={15} aria-hidden />
      </button>
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={group.name}
        style={{ color: "var(--matrix-chat-rail-text, var(--text-primary))" }}>{group.name}</h2>
      <button type="button" aria-label={`New chat in ${group.name}`} title={`New chat in ${group.name}`}
        className="grid size-6 shrink-0 place-items-center rounded-[8px] outline-none hover:bg-[var(--bg-selected)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        onClick={() => onNewChat(group.project)}>
        <PencilEditIcon size={15} aria-hidden />
      </button>
    </div>
    {empty ? <p className="px-3 py-2 text-xs" style={{ color: "var(--text-tertiary)" }}>No chats in this project yet.</p> : null}
    {model.pinned.length > 0 ? <WorkRailSection label="Pinned" count={model.pinned.length} expanded={sections.pinned} onToggle={() => onToggle("pinned")}>
      {model.pinned.map((record) => renderChat(record, "pinned"))}
    </WorkRailSection> : null}
    {empty ? null : <>
      <WorkRailSection label="Needs you" attention count={model.needsYou.length} expanded={sections.needsYou} onToggle={() => onToggle("needsYou")}>
        {model.needsYou.map((record) => renderChat(record, "recent"))}
      </WorkRailSection>
      <WorkRailSection label="Working" count={model.working.length} expanded={sections.working} onToggle={() => onToggle("working")}>
        {model.working.map((record) => renderChat(record, "recent"))}
      </WorkRailSection>
      <WorkRailSection label="Done" count={model.doneDisplay.length} expanded={sections.done} onToggle={() => onToggle("done")}>
        {model.doneDisplay.map((record) => renderChat(record, "recent"))}
      </WorkRailSection>
    </>}
  </>;
}
