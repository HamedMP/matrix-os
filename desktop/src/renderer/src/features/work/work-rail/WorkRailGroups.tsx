import type { ReactNode } from "react";
import type { CollaborationProjectOverview } from "@matrix-os/contracts";
import type { ChatNavigationRecord } from "@matrix-os/ui";
import { AgentAvatar, filterChatsByImportSource, type BotConversationSummary, type ChatImportSourceFilterValue } from "@matrix-os/ui";
import type { CanonicalChatClient } from "../../../lib/canonical-chat-client";
import { useWorkRailPage } from "./useWorkRailPage";
import type { WorkRailModel, WorkRailProjectGroup } from "../work-rail-model";
import { SharedWorkRailProjectList } from "./SharedWorkRailProjects";
import { Plus } from "lucide-react";
import { WorkRailSection } from "./WorkRailSection";

export type WorkRailSectionKey = "pinned" | "projects" | "needsYou" | "working" | "done";
export function WorkRailGroups({ model, activeChatId, sections, onToggle, onCreateProject, renderProject, renderChat, bots, onOpenBotChat, organizationDrives, sharedProjects, revealSharedProjectRequest,
  client = null, scopeKey = "", navigationUpdatedAt = 0, sourceFilter = "all" }: {
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
}) {
  const pendingBots = bots.filter(bot => bot.pendingApprovalCount > 0);
  const pinnedPage = useWorkRailPage(client, { group: "pinned" }, scopeKey, navigationUpdatedAt, 10);
  const needsPage = useWorkRailPage(client, { group: "needsYou" }, scopeKey, navigationUpdatedAt, 10);
  const workingPage = useWorkRailPage(client, { group: "working" }, scopeKey, navigationUpdatedAt, 10);
  const donePage = useWorkRailPage(client, { group: "done" }, scopeKey, navigationUpdatedAt, 10);
  const rows = (page: typeof pinnedPage, fallback: ChatNavigationRecord[]) => client?.navigationPage && (page.rows.length || !page.loading && !page.error)
    ? filterChatsByImportSource(page.rows, sourceFilter, record => record.importSource) : fallback.slice(0, 10);
  const pinned = rows(pinnedPage, model.pinned);
  const needsYou = rows(needsPage, model.needsYou);
  const working = rows(workingPage, model.working);
  const done = rows(donePage, model.doneDisplay);
  const count = (page: typeof pinnedPage, fallback: number) => client?.navigationPage && !page.error && (!page.loading || page.rows.length) ? page.count : fallback;
  const more = (page: typeof pinnedPage, label: string) => page.cursor ? <button type="button" aria-label={`Show more ${label} chats`}
    className="rounded-[8px] px-2.5 py-1 text-left text-xs" disabled={page.loading} onClick={page.loadMore}>Show more</button> : null;
  return <>

        {pinned.length + model.pinnedProjects.length > 0 ? <WorkRailSection
          label="Pinned"
          count={count(pinnedPage, model.pinned.length) + model.pinnedProjects.length}
          expanded={sections.pinned}
          onToggle={() => onToggle("pinned")}
        >
          {model.pinnedProjects.map(renderProject)}
          {pinned.map((record) => renderChat(record, "pinned"))}{more(pinnedPage, "Pinned")}
        </WorkRailSection> : null}

        <WorkRailSection
          label="Projects"
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
          {needsYou.map(record => renderChat(record, "recent"))}{more(needsPage, "Needs you")}
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
          {working.map(record => renderChat(record, "recent"))}{more(workingPage, "Working")}
        </WorkRailSection>
        <WorkRailSection label="Done" count={count(donePage, model.doneDisplay.length)} expanded={sections.done} onToggle={() => onToggle("done")}>
          {done.map(record => renderChat(record, "recent"))}{more(donePage, "Done")}
        </WorkRailSection>
  </>;
}
