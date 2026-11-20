"use client";

import { useMemo } from "react";
import { ProjectConversationList, useMinuteClock, type ChatAgentClient } from "@matrix-os/ui";
import {
  ProjectBoard, ProjectViewSwitch, boardPreferencesKey, createHttpProjectBoardClient, isProjectBoardSlug, taskSessionTarget,
  type ProjectHomeView, type TaskSession,
} from "@matrix-os/ui/project-board";
import { FolderOpen } from "@/lib/hugeicons";
import { openTerminalSession } from "@/lib/terminal-session-open";
import type { RenameableConversation } from "./ChatTitleRename";
import { WebProjectAgentContext } from "./WebProjectAgentContext";
import { projectBoardStorage } from "./project-home-view";
import { useWebProjectHistory, type ChatRunStatusChange } from "./useWebProjectHistory";
import type { WebProject } from "./web-projects";

const NO_CONVERSATIONS: readonly RenameableConversation[] = [];

/**
 * Web Desktop project home, matching Electron Desktop: slim header, agent configuration, one row per Chat.
 * The Board view shows the project's task board from the gateway's task routes.
 */
export function WebProjectHome({ project, gatewayUrl, identity, isCurrentAuthority, conversations = NO_CONVERSATIONS, historyIncomplete = false, historyRefreshKey, historyRunStatusChange, knownChatIds, botClient, onSelectChat, active = true, view = "overview", onViewChange }: {
  project: WebProject;
  gatewayUrl: string;
  identity: string;
  isCurrentAuthority?: () => boolean;
  /** This project's Chats from the shared navigation projection. */
  conversations?: readonly RenameableConversation[];
  /** The shared navigation window was cut off, so this project's own history is read too. */
  historyIncomplete?: boolean;
  /** Changes on every Chat change, so this project's history is read again. */
  historyRefreshKey?: number;
  /** Run status changes; only those for history-only rows read the history again. */
  historyRunStatusChange?: ChatRunStatusChange;
  /** Chats the shared list knows anywhere (or deleted here); their history copies are dropped. */
  knownChatIds?: ReadonlySet<string>;
  /** Classifies history-only Chats so Bot Chats stay out of the project list. */
  botClient?: ChatAgentClient;
  onSelectChat?: (chatId: string) => void;
  active?: boolean;
  view?: ProjectHomeView;
  onViewChange?: (view: ProjectHomeView) => void;
}) {
  if (view === "board") {
    return <div className="flex min-h-0 flex-1 flex-col" data-slot="chat-project-board">
      <ProjectHomeHeader name={project.name} view={view} onViewChange={onViewChange} className="px-5 pb-3 pt-5" />
      <WebProjectBoard key={`${identity}/${project.id}`} gatewayUrl={gatewayUrl} project={project} onSelectChat={onSelectChat} active={active} />
    </div>;
  }
  return <WebProjectOverview project={project} gatewayUrl={gatewayUrl} identity={identity} isCurrentAuthority={isCurrentAuthority}
    conversations={conversations} historyIncomplete={historyIncomplete} historyRefreshKey={historyRefreshKey} historyRunStatusChange={historyRunStatusChange}
    knownChatIds={knownChatIds} botClient={botClient} onSelectChat={onSelectChat} active={active} onViewChange={onViewChange} />;
}

/** The project's board over the owner's gateway. Chats open in this Chats window; terminals in the durable Terminal window. */
function WebProjectBoard({ gatewayUrl, project, onSelectChat, active }: {
  gatewayUrl: string; project: WebProject; onSelectChat?: (chatId: string) => void; active: boolean;
}) {
  const client = useMemo(() => isProjectBoardSlug(project.slug) ? createHttpProjectBoardClient({ gatewayUrl, projectSlug: project.slug }) : null,
    [gatewayUrl, project.slug]);
  const openSession = (session: TaskSession) => {
    const target = taskSessionTarget(session.ref);
    if (target?.kind === "chat") onSelectChat?.(target.chatId);
    else if (target?.kind === "terminal") openTerminalSession(`${target.workspaceId}:${target.tabId}`);
  };
  if (!client) return <p role="alert" className="px-5 py-16 text-center text-[13px] text-muted-foreground">This project's board isn't available.</p>;
  return <ProjectBoard client={client} preferencesKey={boardPreferencesKey("web", project.id)} storage={projectBoardStorage()} active={active}
    onOpenSession={openSession} />;
}

function ProjectHomeHeader({ name, view, onViewChange, className }: { name: string; view: ProjectHomeView; onViewChange?: (view: ProjectHomeView) => void; className?: string }) {
  return <div className={`flex min-w-0 items-center gap-2.5 ${className ?? ""}`}>
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-hover)] text-foreground">
      <FolderOpen size={17} aria-hidden />
    </span>
    <h1 className="min-w-0 truncate text-[20px] font-medium leading-7 text-foreground" style={{ fontFamily: "var(--font-heading)" }}>
      {name}
    </h1>
    {onViewChange ? <div className="ml-auto"><ProjectViewSwitch view={view} onChange={onViewChange} /></div> : null}
  </div>;
}

function WebProjectOverview({ project, gatewayUrl, identity, isCurrentAuthority, conversations, historyIncomplete, historyRefreshKey, historyRunStatusChange, knownChatIds, botClient, onSelectChat, active, onViewChange }: {
  project: WebProject;
  gatewayUrl: string;
  identity: string;
  isCurrentAuthority?: () => boolean;
  conversations: readonly RenameableConversation[];
  historyIncomplete: boolean;
  historyRefreshKey?: number;
  historyRunStatusChange?: ChatRunStatusChange;
  knownChatIds?: ReadonlySet<string>;
  botClient?: ChatAgentClient;
  onSelectChat?: (chatId: string) => void;
  active: boolean;
  onViewChange?: (view: ProjectHomeView) => void;
}) {
  const nowMs = useMinuteClock(active);
  const listed = useMemo(() => conversations.flatMap((chat) => chat.canonicalRecord ? [chat.canonicalRecord] : []), [conversations]);
  const history = useWebProjectHistory({ project, gatewayUrl, listed, knownChatIds, refreshKey: historyRefreshKey, runStatusChange: historyRunStatusChange, enabled: historyIncomplete && active, botClient });
  // An error wins so the list keeps its rows but still offers Try again.
  const status = history.error ? "error" : history.records.length > 0 ? "ready" : history.loading ? "loading" : "ready";
  return (
    <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]" data-slot="chat-project-home">
      <div className="mx-auto w-full max-w-[808px] px-6 pb-4 pt-5">
        <ProjectHomeHeader name={project.name} view="overview" onViewChange={onViewChange} />
        <WebProjectAgentContext project={project} gatewayUrl={gatewayUrl} identity={identity} isCurrentAuthority={isCurrentAuthority} />
        {/* No snippet: the navigation projection carries no message excerpt, only the title. */}
        <ProjectConversationList projectName={project.name} records={history.records} status={status} nowMs={nowMs}
          onRetry={history.retry} truncated={history.capped}
          onSelect={onSelectChat ? (record) => onSelectChat(record.chat.id) : undefined} />
      </div>
    </div>
  );
}
