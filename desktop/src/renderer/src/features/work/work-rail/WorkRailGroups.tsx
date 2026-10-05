import type { ReactNode } from "react";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { AgentAvatar, ChatSidebarAddAction, type BotConversationSummary } from "@matrix-os/ui";
import type { WorkRailModel, WorkRailProjectGroup } from "../work-rail-model";
import { SharedWorkRailProjects } from "./SharedWorkRailProjects";
import { WorkRailSection } from "./WorkRailSection";

export type WorkRailSectionKey = "pinned" | "projects" | "needsYou" | "working" | "done";
export function WorkRailGroups({ model, activeChatId, sections, onToggle, onCreateProject, renderProject, renderChat, bots, onOpenBotChat, organizationDrives, revealSharedProjectScopeId }: {
  model: WorkRailModel;
  activeChatId?: string;
  sections: Record<WorkRailSectionKey, boolean>;
  onToggle: (key: WorkRailSectionKey) => void;
  onCreateProject: () => void;
  renderProject: (group: WorkRailProjectGroup) => ReactNode;
  renderChat: (record: CanonicalChatRecord, placement: "pinned" | "recent") => ReactNode;
  bots: BotConversationSummary[];
  onOpenBotChat?: (chatId: string) => void;
  organizationDrives: ReactNode;
  revealSharedProjectScopeId?: string;
}) {
  return <>

        <WorkRailSection
          label="Pinned"
          count={model.pinned.length + model.pinnedProjects.length}
          expanded={sections.pinned}
          onToggle={() => onToggle("pinned")}
        >
          {model.pinnedProjects.map(renderProject)}
          {model.pinned.map((record) => renderChat(record, "pinned"))}
        </WorkRailSection>

        <WorkRailSection
          label="Projects"
          count={model.projects.length}
          expanded={sections.projects}
          onToggle={() => onToggle("projects")}

        >
          {model.projects.map(renderProject)}
          <SharedWorkRailProjects revealScopeId={revealSharedProjectScopeId} />
          <ChatSidebarAddAction label="New project" ariaLabel="Create project" onClick={onCreateProject} />
          {organizationDrives}
        </WorkRailSection>

        <WorkRailSection label="Needs you" count={model.needsYou.length + bots.filter(bot => bot.pendingApprovalCount > 0).length} expanded={sections.needsYou} onToggle={() => onToggle("needsYou")}>
          {model.needsYou.map(record => renderChat(record, "recent"))}
          {bots.filter(bot => bot.pendingApprovalCount > 0).map(bot => <button
            key={bot.chatId} type="button" aria-label={`Review ${bot.name} approval`} aria-current={activeChatId === bot.chatId ? "page" : undefined}
            disabled={!onOpenBotChat} className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-left text-sm outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
            onClick={() => { onOpenBotChat?.(bot.chatId); }}>
            <AgentAvatar id={bot.agentId} name={bot.name} size="small" />
            <span className="min-w-0 flex-1"><span className="block truncate">{bot.name}</span><span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>Approval required</span></span>
            <span aria-label={`${bot.pendingApprovalCount} pending approvals`} className="text-xs tabular-nums">{bot.pendingApprovalCount}</span>
          </button>)}
        </WorkRailSection>
        <WorkRailSection label="Working" count={model.working.length} expanded={sections.working} onToggle={() => onToggle("working")}>
          {model.working.map(record => renderChat(record, "recent"))}
        </WorkRailSection>
        <WorkRailSection label="Done" count={model.doneDisplay.length} expanded={sections.done} onToggle={() => onToggle("done")}>
          {model.doneDisplay.map(record => renderChat(record, "recent"))}
        </WorkRailSection>
  </>;
}
