import { useEffect, useState, type ReactNode } from "react";
import type { CollaborationProjectOverview } from "@matrix-os/contracts";
import type { ChatNavigationRecord } from "@matrix-os/ui";
import { AgentAvatar, filterChatsByImportSource, type BotConversationSummary, type ChatImportSourceFilterValue } from "@matrix-os/ui";
import type { CanonicalChatClient } from "../../../lib/canonical-chat-client";
import { useWorkRailPage } from "./use-work-rail-order";
import type { WorkRailModel, WorkRailProjectGroup } from "../work-rail-model";
import { SharedWorkRailProjectList } from "./SharedWorkRailProjects";
import { Plus, Folder } from "lucide-react";
import { WorkRailSection } from "./WorkRailSection";

export type WorkRailSectionKey = "pinned" | "projects" | "needsYou" | "working" | "done";
type StatusGroup = Exclude<WorkRailSectionKey, "projects">;
const INITIAL_FALLBACK_LIMITS = { pinned: 10, needsYou: 10, working: 10, done: 10 };
export function WorkRailGroups({ model, activeChatId, sections, onToggle, onCreateProject, renderProject, renderChat, bots, onOpenBotChat, organizationDrives, sharedProjects, revealSharedProjectRequest,
  client = null, scopeKey = "", navigationUpdatedAt = 0, sourceFilter = "all", orderRows, registerVisibleChats }: {
  model: WorkRailModel;
  activeChatId?: string;
  sections: Record<WorkRailSectionKey, boolean>;
  onToggle: (key: WorkRailSectionKey) => void;
  onCreateProject: () => void;
  renderProject: (group: WorkRailProjectGroup) => ReactNode;
  renderChat: (record: ChatNavigationRecord, placement: "pinned" | "recent") => ReactNode;
  bots: BotConversationSummary[];
  onOpenBotChat?: (chatId: string) => void;
  organizationDrives: ReactNode;
  sharedProjects: readonly CollaborationProjectOverview[];
  revealSharedProjectRequest?: { scopeId: string; requestId: number };
  client?: CanonicalChatClient | null;
  scopeKey?: string;
  navigationUpdatedAt?: number;
  sourceFilter?: ChatImportSourceFilterValue;
  orderRows?: (rows: readonly ChatNavigationRecord[]) => ChatNavigationRecord[];
  registerVisibleChats?: (ids: readonly string[]) => void;
}) {
  const pendingBots = bots.filter(bot => bot.pendingApprovalCount > 0);
  const [fallback, setFallback] = useState(() => ({ scopeKey, limits: INITIAL_FALLBACK_LIMITS }));
  const fallbackLimit = (group: StatusGroup) => fallback.scopeKey === scopeKey ? fallback.limits[group] : 10;
  const pinnedPage = useWorkRailPage(client, { group: "pinned" }, scopeKey, navigationUpdatedAt, 10);
  const needsPage = useWorkRailPage(client, { group: "needsYou" }, scopeKey, navigationUpdatedAt, 10);
  const workingPage = useWorkRailPage(client, { group: "working" }, scopeKey, navigationUpdatedAt, 10);
  const donePage = useWorkRailPage(client, { group: "done" }, scopeKey, navigationUpdatedAt, 10);
  const usesServer = (page: typeof pinnedPage) => Boolean(client?.navigationPage && (page.rows.length || !page.loading && !page.error));
  const rows = (page: typeof pinnedPage, records: ChatNavigationRecord[], group: StatusGroup) => usesServer(page)
    ? (orderRows?.(filterChatsByImportSource(page.rows, sourceFilter, record => record.importSource)) ?? filterChatsByImportSource(page.rows, sourceFilter, record => record.importSource)) : records.slice(0, fallbackLimit(group));
  const pinned = rows(pinnedPage, model.pinned, "pinned");
  const needsYou = rows(needsPage, model.needsYou, "needsYou");
  const working = rows(workingPage, model.working, "working");
  const done = rows(donePage, model.doneDisplay, "done");
  const visibleIds = [...pinned, ...needsYou, ...working, ...done].map(record => record.chat.id).join("\0");
  useEffect(() => { registerVisibleChats?.(visibleIds.split("\0").filter(Boolean)); }, [registerVisibleChats, visibleIds]);
  const count = (page: typeof pinnedPage, fallback: number) => client?.navigationPage && !page.error && (!page.loading || page.rows.length) ? page.count : fallback;
  const more = (page: typeof pinnedPage, label: string, group: StatusGroup, fallbackCount: number) => (usesServer(page) ? page.cursor : fallbackCount > fallbackLimit(group)) ? <button type="button" aria-label={`Show more ${label} chats`}
    className="rounded-[8px] px-2.5 py-1 text-left text-xs" disabled={page.loading} onClick={() => {
      if (usesServer(page)) { page.loadMore(); return; }
      setFallback(current => {
        const limits = current.scopeKey === scopeKey ? current.limits : INITIAL_FALLBACK_LIMITS;
        return { scopeKey, limits: { ...limits, [group]: Math.min(limits[group] + 20, fallbackCount) } };
      });
    }}>Show more</button> : null;
  return <>

        {pinned.length + model.pinnedProjects.length > 0 || pinnedPage.cursor ? <WorkRailSection
          label="Pinned"
          count={count(pinnedPage, model.pinned.length) + model.pinnedProjects.length}
          expanded={sections.pinned}
          onToggle={() => onToggle("pinned")}
        >
          {model.pinnedProjects.map(renderProject)}
          {pinned.map((record) => renderChat(record, "pinned"))}{more(pinnedPage, "Pinned", "pinned", model.pinned.length)}
        </WorkRailSection> : null}

        <WorkRailSection
          label="Projects" icon={<Folder size={15} aria-hidden/>}
          count={model.projects.length + sharedProjects.length}
          expanded={sections.projects}
          onToggle={() => onToggle("projects")}
          action={<button type="button" aria-label="Create project" title="New project" className="work-rail-group-create outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" onClick={onCreateProject}><Plus size={15} aria-hidden /></button>}
        >
          {model.projects.map(renderProject)}
          <SharedWorkRailProjectList projects={sharedProjects} revealRequest={revealSharedProjectRequest} />
          {organizationDrives}
        </WorkRailSection>

        <WorkRailSection label="Needs you" attention count={count(needsPage, model.needsYou.length) + pendingBots.length} expanded={sections.needsYou} onToggle={() => onToggle("needsYou")}>
          {needsYou.map(record => renderChat(record, "recent"))}{more(needsPage, "Needs you", "needsYou", model.needsYou.length)}
          {pendingBots.map(bot => <button
            key={bot.chatId} type="button" aria-label={`Review ${bot.name} approval`} aria-current={activeChatId === bot.chatId ? "page" : undefined}
            disabled={!onOpenBotChat} className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-left text-sm outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
            onClick={() => { onOpenBotChat?.(bot.chatId); }}>
            <AgentAvatar id={bot.agentId} name={bot.name} size="small" />
            <span className="min-w-0 flex-1"><span className="block truncate">{bot.name}</span><span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>Approval required</span></span>
            <span aria-label={`${bot.pendingApprovalCount} pending approvals`} className="text-xs tabular-nums">{bot.pendingApprovalCount}</span>
          </button>)}
        </WorkRailSection>
        <WorkRailSection label="Working" count={count(workingPage, model.working.length)} expanded={sections.working} onToggle={() => onToggle("working")}>
          {working.map(record => renderChat(record, "recent"))}{more(workingPage, "Working", "working", model.working.length)}
        </WorkRailSection>
        <WorkRailSection label="Done" count={count(donePage, model.doneDisplay.length)} expanded={sections.done} onToggle={() => onToggle("done")}>
          {done.map(record => renderChat(record, "recent"))}{more(donePage, "Done", "done", model.doneDisplay.length)}
        </WorkRailSection>
  </>;
}
