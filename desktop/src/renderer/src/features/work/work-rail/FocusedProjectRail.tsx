import { useEffect, type ReactNode } from "react";
import { filterChatsByImportSource, type ChatNavigationRecord, type ChatImportSourceFilterValue } from "@matrix-os/ui";
import { ChevronLeft, SquarePen as PencilEditIcon } from "lucide-react";
import type { Project } from "../../../stores/board";
import { buildWorkRailModel, type WorkRailProjectGroup } from "../work-rail-model";
import type { WorkRailSectionKey } from "./WorkRailGroups";
import { WorkRailSection } from "./WorkRailSection";
import { useWorkRailPage } from "./useWorkRailPage";
import type { CanonicalChatClient } from "../../../lib/canonical-chat-client";

/** The focused Project's Chats, including pinned ones, as one lifecycle model. */
export function focusedProjectRecords(records: readonly ChatNavigationRecord[], group: WorkRailProjectGroup): ChatNavigationRecord[] {
  return records.filter((record) => record.projectId === group.id || record.projectId === group.slug);
}

/** Sidebar "zoomed" into one Project: its Chats grouped by lifecycle, with a way back. */
export function FocusedProjectRail({ group, records, sections, onToggle, renderChat, onBack, onNewChat,
  client = null, scopeKey = "", navigationUpdatedAt = 0, sourceFilter = "all", orderRows, registerVisibleChats }: {
  group: WorkRailProjectGroup;
  records: readonly ChatNavigationRecord[];
  sections: Record<WorkRailSectionKey, boolean>;
  onToggle: (key: WorkRailSectionKey) => void;
  renderChat: (record: ChatNavigationRecord, placement: "pinned" | "recent") => ReactNode;
  onBack: () => void;
  onNewChat: (project: Project) => void;
  client?: CanonicalChatClient | null;
  scopeKey?: string;
  navigationUpdatedAt?: number;
  sourceFilter?: ChatImportSourceFilterValue;
  orderRows?: (rows: readonly ChatNavigationRecord[]) => ChatNavigationRecord[];
  registerVisibleChats?: (ids: readonly string[]) => void;
}) {
  const projectPage = useWorkRailPage(client, { group: "project", projectId: group.id }, scopeKey, navigationUpdatedAt, 5);
  const legacyPage = useWorkRailPage(group.id === group.slug ? null : client,
    { group: "project", projectId: group.slug }, scopeKey, navigationUpdatedAt, 5);
  const pageReady = Boolean(client?.navigationPage && (projectPage.rows.length || !projectPage.loading && !projectPage.error));
  const raw = pageReady ? [...projectPage.rows, ...legacyPage.rows] : records;
  const visibleRecords = filterChatsByImportSource(raw.filter((record, index) => raw.findIndex(candidate => candidate.chat.id === record.chat.id) === index),
    sourceFilter, record => record.importSource);
  const visibleIds = visibleRecords.map(record => record.chat.id).join("\0");
  useEffect(() => { registerVisibleChats?.(visibleIds.split("\0").filter(Boolean)); }, [registerVisibleChats, visibleIds]);
  // Without a Project reference the model places each Chat in its lifecycle group;
  // rows still receive the original record so Move, Delete and selection keep the Project.
  const grouped = buildWorkRailModel(visibleRecords.map(({ projectId: _projectId, ...record }) => record), []);
  const originals = new Map(visibleRecords.map((record) => [record.chat.id, record]));
  const restore = (list: readonly ChatNavigationRecord[]) => list.flatMap((record) => originals.get(record.chat.id) ?? []);
  const ordered = (list: readonly ChatNavigationRecord[]) => orderRows?.(restore(list)) ?? restore(list);
  const model = { pinned: ordered(grouped.pinned), needsYou: ordered(grouped.needsYou), working: ordered(grouped.working), doneDisplay: ordered(grouped.doneDisplay) };
  const empty = visibleRecords.length === 0;
  const more = projectPage.cursor || legacyPage.cursor ? <button type="button" aria-label={`Show more ${group.name} chats`}
    className="rounded-[8px] px-2.5 py-1 text-left text-xs" disabled={projectPage.loading || legacyPage.loading}
    onClick={() => { projectPage.loadMore(); legacyPage.loadMore(); }}>Show more</button> : null;
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
    {more}
  </>;
}
