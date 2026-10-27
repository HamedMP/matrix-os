"use client";

import { ChatRailOrderItem, ChatRailSection, OverflowingChatTitle, filterChatsByImportSource, useMinuteClock,
  type ChatImportSourceFilterValue } from "@matrix-os/ui";
import { ChevronRight, Folder, FolderOpen, MessageSquare } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { RenameableConversation } from "./ChatTitleRename";
import { usePagedProjectChats, type FetchedProjectChat } from "./usePagedProjectChats";
import { projectChats, type WebProject, type WebProjectsState } from "./web-projects";

// Same page size as the Electron Desktop project list.
const PROJECT_CHAT_PAGE = 6;
type ProjectRow = { kind: "known"; chat: RenameableConversation } | { kind: "fetched"; chat: FetchedProjectChat };

export function WebProjectsNav({ state, gatewayUrl, chats, activeChatId, activeChatTitle, onSelectChat, renderChat,
  mobile = false, unreadOnly = false, sourceFilter = "all", searchQuery = "" }: {
  state: WebProjectsState;
  gatewayUrl: string;
  chats: readonly RenameableConversation[];
  activeChatId?: string;
  activeChatTitle?: string;
  onSelectChat(chatId: string): void;
  renderChat(chat: RenameableConversation, nowMs: number): ReactNode;
  mobile?: boolean;
  unreadOnly?: boolean;
  sourceFilter?: ChatImportSourceFilterValue;
  searchQuery?: string;
}) {
  const { projects, loading, error, retry } = state;
  const [groupExpanded, setGroupExpanded] = useState(true);
  return <nav aria-label="Projects" className="mx-2 space-y-1 text-sm">
    <ChatRailSection label="Projects" count={projects.length} countLabel={`${projects.length} hidden ${projects.length === 1 ? "project" : "projects"}`}
      expanded={groupExpanded} onExpandedChange={setGroupExpanded}>
      {loading ? <p role="status" className="px-2 py-2 text-xs text-muted-foreground">Loading projects…</p> : null}
      {error ? <div className="px-2 py-2 text-xs text-muted-foreground">
        <p role="alert">Projects could not be loaded.</p>
        <button type="button" className={`mt-1 rounded px-2 text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary ${mobile ? "min-h-11" : "min-h-9"}`}
          onClick={retry}>Retry projects</button>
      </div> : null}
      {!loading && !error && projects.length === 0 ? <div className="space-y-1 px-2 py-3 text-xs text-muted-foreground">
        <Folder aria-hidden="true" size={16} strokeWidth={1.5} />
        <p className="font-medium text-foreground">No projects on this computer yet.</p>
        <p>Your project chats will appear here when a project is available.</p>
        <p>Create a project in Matrix Desktop to get started.</p>
      </div> : null}
      {projects.map(project => <WebProjectGroup key={`${state.identity}/${project.id}/${unreadOnly}/${sourceFilter}`} project={project} gatewayUrl={gatewayUrl}
        chats={projectChats(chats, project).filter(chat => !chat.canonicalRecord?.chat.userState?.pinned)}
        activeChatId={activeChatId} activeChatTitle={activeChatTitle} onSelectChat={onSelectChat}
        renderChat={renderChat} mobile={mobile} unreadOnly={unreadOnly} sourceFilter={sourceFilter} searchQuery={searchQuery}/>)}
    </ChatRailSection>
  </nav>;
}

function WebProjectGroup({ project, gatewayUrl, chats, activeChatId, activeChatTitle, onSelectChat, renderChat,
  mobile, unreadOnly, sourceFilter, searchQuery }: {
  project: WebProject;
  gatewayUrl: string;
  chats: readonly RenameableConversation[];
  activeChatId?: string;
  activeChatTitle?: string;
  onSelectChat(chatId: string): void;
  renderChat(chat: RenameableConversation, nowMs: number): ReactNode;
  mobile: boolean;
  unreadOnly: boolean;
  sourceFilter: ChatImportSourceFilterValue;
  searchQuery: string;
}) {
  const { expanded, toggleExpanded, fetched, loading, error, retry, loadMore, hasMore } = usePagedProjectChats(project, gatewayUrl, unreadOnly);
  const [limit, setLimit] = useState(PROJECT_CHAT_PAGE);
  const nowMs = useMinuteClock(expanded);
  const knownIds = new Set(chats.map(chat => chat.id));
  const search = searchQuery.trim().toLowerCase();
  const unknownChats = filterChatsByImportSource(fetched.filter(chat => !knownIds.has(chat.id)
    && (!search || chat.title.toLowerCase().includes(search))), sourceFilter, chat => chat.importSource);
  const allRows: ProjectRow[] = [...chats.map(chat => ({ kind: "known", chat } as const)),
    ...unknownChats.map(chat => ({ kind: "fetched", chat } as const))];
  // Never hide the open Chat behind Show more.
  const shownCount = Math.max(limit, allRows.findIndex(row => row.chat.id === activeChatId) + 1);
  const hiddenCount = allRows.length - shownCount;
  return <div>
    <button type="button" aria-label={`Open ${project.name} project`} aria-expanded={expanded}
      className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary ${mobile ? "min-h-11" : "min-h-9"}`}
      onClick={toggleExpanded}>
      {expanded ? <FolderOpen aria-hidden="true" size={15} strokeWidth={1.5} className="shrink-0" /> : <Folder aria-hidden="true" size={15} strokeWidth={1.5} className="shrink-0" />}
      <OverflowingChatTitle title={project.name} />
      <ChevronRight aria-hidden="true" size={12} className={`ml-auto shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`} />
    </button>
    {expanded ? <div className="ml-4 space-y-0.5 border-l border-border pl-2">
      <ProjectChatRows rows={allRows.slice(0, shownCount)} projectId={project.id} nowMs={nowMs}
        activeChatId={activeChatId} activeChatTitle={activeChatTitle} onSelectChat={onSelectChat}
        renderChat={renderChat} mobile={mobile} />
      <ProjectChatStatus rowCount={allRows.length} loading={loading} error={error} hasMore={hasMore}
        mobile={mobile} retry={retry} filtered={unreadOnly || sourceFilter !== "all" || Boolean(search)} />
      <ProjectChatPaging projectName={project.name} hiddenCount={hiddenCount} loading={loading} error={error}
        hasMore={hasMore} mobile={mobile} showMore={() => setLimit(shownCount + PROJECT_CHAT_PAGE)} loadMore={loadMore} />
    </div> : null}
  </div>;
}

function ProjectChatRows({ rows, projectId, nowMs, activeChatId, activeChatTitle, onSelectChat, renderChat, mobile }: {
  rows: readonly ProjectRow[]; projectId: string; nowMs: number; activeChatId?: string; activeChatTitle?: string;
  onSelectChat(chatId: string): void; renderChat(chat: RenameableConversation, nowMs: number): ReactNode; mobile: boolean;
}) {
  return <>{rows.map(row => row.kind === "known"
    ? <ChatRailOrderItem key={row.chat.id} id={row.chat.id} kind="chat" group={`project:${projectId}`}>
        {renderChat(row.chat, nowMs)}
      </ChatRailOrderItem>
    : <button key={row.chat.id} type="button" aria-current={activeChatId === row.chat.id ? "page" : undefined}
        className={`w-full truncate rounded px-2 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary ${mobile ? "min-h-11" : "min-h-9"}`}
        onClick={() => onSelectChat(row.chat.id)}>{activeChatId === row.chat.id && activeChatTitle || row.chat.title}</button>)}</>;
}

function ProjectChatStatus({ rowCount, loading, error, hasMore, mobile, filtered, retry }: {
  rowCount: number; loading: boolean; error: boolean; hasMore: boolean; mobile: boolean; filtered: boolean; retry(): void;
}) {
  return <>
    {loading && rowCount === 0 ? <p role="status" className="px-2 py-2 text-xs text-muted-foreground">Loading chats…</p> : null}
    {error ? <div className="px-2 py-2 text-xs text-muted-foreground">
      <p role="alert">Project chats could not be loaded.</p>
      <button type="button" className={`mt-1 rounded px-2 text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary ${mobile ? "min-h-11" : "min-h-9"}`}
        onClick={retry}>Retry chats</button>
    </div> : null}
    {!loading && !error && !hasMore && rowCount === 0 ? <div className="space-y-1 px-2 py-3 text-xs text-muted-foreground">
      <MessageSquare aria-hidden="true" size={16} strokeWidth={1.5} />
      <p className="font-medium text-foreground">{filtered ? "No matching chats in this project." : "No chats in this project yet."}</p>
      <p>{filtered ? "Try another filter or search." : "Conversations saved to this project will appear here."}</p>
      {!filtered ? <p>Add one from Matrix Desktop.</p> : null}
    </div> : null}
  </>;
}

function ProjectChatPaging({ projectName, hiddenCount, loading, error, hasMore, mobile, showMore, loadMore }: {
  projectName: string; hiddenCount: number; loading: boolean; error: boolean; hasMore: boolean; mobile: boolean;
  showMore(): void; loadMore(): void;
}) {
  return <>
    {hiddenCount > 0 ? <button type="button" aria-label={`Show more ${projectName} chats`}
      className={`w-full rounded-md px-2.5 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary ${mobile ? "min-h-11" : "min-h-7"}`}
      onClick={showMore}>Show more</button> : null}
    {!loading && !error && hiddenCount <= 0 && hasMore ? <button type="button"
      className={`w-full rounded-md px-2.5 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary ${mobile ? "min-h-11" : "min-h-7"}`}
      onClick={loadMore}>Load more chats</button> : null}
  </>;
}
