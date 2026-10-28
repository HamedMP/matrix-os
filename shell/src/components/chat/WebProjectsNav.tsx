"use client";

import { ChatRailOrderItem, ChatRailSection, OverflowingChatTitle, filterChatsByImportSource, useMinuteClock,
  type ChatImportSourceFilterValue } from "@matrix-os/ui";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { RenameableConversation } from "./ChatTitleRename";
import { MAX_PROJECT_CHAT_ROWS, usePagedProjectChats, type FetchedProjectChat } from "./usePagedProjectChats";
import { projectChats, type WebProject, type WebProjectsState } from "./web-projects";

// Same page size as the Electron Desktop project list.
const PROJECT_CHAT_PAGE = 6;
export type ProjectRow = { kind: "known"; chat: RenameableConversation } | { kind: "fetched"; chat: FetchedProjectChat };

export function WebProjectsNav({ state, gatewayUrl, chats, listedChatIds, activeChatId, activeChatTitle, onSelectChat, onFocusProject, renderChat,
  mobile = false, unreadOnly = false, sourceFilter = "all", searchQuery = "" }: {
  state: WebProjectsState;
  gatewayUrl: string;
  chats: readonly RenameableConversation[];
  /** Chats already in navigation, or deleted here; their paged copies are never shown as extra rows. */
  listedChatIds: ReadonlySet<string>;
  activeChatId?: string;
  activeChatTitle?: string;
  onSelectChat(chatId: string): void;
  /** Narrows the sidebar to one project, as on Electron Desktop. */
  onFocusProject(project: WebProject): void;
  renderChat(chat: RenameableConversation, nowMs: number): ReactNode;
  mobile?: boolean;
  unreadOnly?: boolean;
  sourceFilter?: ChatImportSourceFilterValue;
  searchQuery?: string;
}) {
  const { projects, loading, error, retry } = state;
  const [groupExpanded, setGroupExpanded] = useState(true);
  // Same rail geometry as Electron Desktop: no inset of its own, so the heading lines up with the lifecycle sections.
  return <nav aria-label="Projects">
    <ChatRailSection label="Projects" count={projects.length} countLabel={`${projects.length} hidden ${projects.length === 1 ? "project" : "projects"}`}
      expanded={groupExpanded} onExpandedChange={setGroupExpanded}>
      {loading ? <p role="status" className="matrix-web-project-note">Loading projects…</p> : null}
      {error ? <div className="matrix-web-project-note">
        <p role="alert">Projects could not be loaded.</p>
        <button type="button" className="matrix-web-project-more" data-mobile={mobile || undefined} onClick={retry}>Retry projects</button>
      </div> : null}
      {!loading && !error && projects.length === 0 ? <div className="matrix-web-project-note">
        <p className="matrix-web-project-note-title">No projects on this computer yet.</p>
        <p>Create a project in Matrix Desktop to get started.</p>
      </div> : null}
      {projects.map(project => <WebProjectGroup key={`${state.identity}/${project.id}/${unreadOnly}/${sourceFilter}`} project={project} gatewayUrl={gatewayUrl}
        chats={projectChats(chats, project).filter(chat => !chat.canonicalRecord?.chat.userState?.pinned)} listedChatIds={listedChatIds}
        activeChatId={activeChatId} activeChatTitle={activeChatTitle} onSelectChat={onSelectChat} onFocusProject={onFocusProject}
        renderChat={renderChat} mobile={mobile} unreadOnly={unreadOnly} sourceFilter={sourceFilter} searchQuery={searchQuery}/>)}
    </ChatRailSection>
  </nav>;
}

function WebProjectGroup({ project, gatewayUrl, chats, listedChatIds, activeChatId, activeChatTitle, onSelectChat, onFocusProject, renderChat,
  mobile, unreadOnly, sourceFilter, searchQuery }: {
  project: WebProject;
  gatewayUrl: string;
  chats: readonly RenameableConversation[];
  listedChatIds: ReadonlySet<string>;
  activeChatId?: string;
  activeChatTitle?: string;
  onSelectChat(chatId: string): void;
  onFocusProject(project: WebProject): void;
  renderChat(chat: RenameableConversation, nowMs: number): ReactNode;
  mobile: boolean;
  unreadOnly: boolean;
  sourceFilter: ChatImportSourceFilterValue;
  searchQuery: string;
}) {
  const { expanded, toggleExpanded, fetched, loading, error, retry, loadMore, hasMore, capped } = usePagedProjectChats(project, gatewayUrl, unreadOnly);
  const [limit, setLimit] = useState(PROJECT_CHAT_PAGE);
  const nowMs = useMinuteClock(expanded);
  const search = searchQuery.trim().toLowerCase();
  // Paged rows only fill in older Chats; a listed (or pinned, filtered, deleted) Chat keeps its normal placement.
  const unknownChats = filterChatsByImportSource(fetched.filter(chat => !listedChatIds.has(chat.id)
    && (!search || chat.title.toLowerCase().includes(search))), sourceFilter, chat => chat.importSource);
  const allRows: ProjectRow[] = [...chats.map(chat => ({ kind: "known", chat } as const)),
    ...unknownChats.map(chat => ({ kind: "fetched", chat } as const))];
  // Never hide the open Chat behind Show more.
  const shownCount = Math.max(limit, allRows.findIndex(row => row.chat.id === activeChatId) + 1);
  const hiddenCount = allRows.length - shownCount;
  return <div>
    <div className="matrix-web-project" data-mobile={mobile || undefined}>
      <button type="button" aria-label={project.name} title={project.name} className="matrix-web-project-select"
        onClick={() => onFocusProject(project)}>
        {expanded ? <FolderOpen aria-hidden="true" size={15} strokeWidth={1.5} /> : <Folder aria-hidden="true" size={15} strokeWidth={1.5} />}
        <OverflowingChatTitle title={project.name} />
      </button>
      <button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name} chats`} aria-expanded={expanded}
        className="matrix-web-project-disclosure" onClick={toggleExpanded}>
        <ChevronRight aria-hidden="true" size={12} className={`transition-transform duration-200 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`} />
      </button>
    </div>
    {expanded ? <div className="matrix-web-project-chats">
      <ProjectChatRows rows={allRows.slice(0, shownCount)} projectId={project.id} nowMs={nowMs}
        activeChatId={activeChatId} activeChatTitle={activeChatTitle} onSelectChat={onSelectChat}
        renderChat={renderChat} mobile={mobile} />
      <ProjectChatStatus rowCount={allRows.length} loading={loading} error={error} hasMore={hasMore}
        mobile={mobile} retry={retry} filtered={unreadOnly || sourceFilter !== "all" || Boolean(search)} />
      <ProjectChatPaging projectName={project.name} hiddenCount={hiddenCount} loading={loading} error={error}
        hasMore={hasMore} capped={capped} mobile={mobile} showMore={() => setLimit(shownCount + PROJECT_CHAT_PAGE)} loadMore={loadMore} />
    </div> : null}
  </div>;
}

export function ProjectChatRows({ rows, projectId, nowMs, activeChatId, activeChatTitle, onSelectChat, renderChat, mobile }: {
  rows: readonly ProjectRow[]; projectId: string; nowMs: number; activeChatId?: string; activeChatTitle?: string;
  onSelectChat(chatId: string): void; renderChat(chat: RenameableConversation, nowMs: number): ReactNode; mobile: boolean;
}) {
  return <>{rows.map(row => row.kind === "known"
    ? <ChatRailOrderItem key={row.chat.id} id={row.chat.id} kind="chat" group={`project:${projectId}`}>
        {renderChat(row.chat, nowMs)}
      </ChatRailOrderItem>
    // Older Chats from paging look like every other Chat row; they only lack the row actions.
    : <div key={row.chat.id} className="matrix-web-chat-row-item" data-current={activeChatId === row.chat.id}>
        <button type="button" aria-current={activeChatId === row.chat.id ? "page" : undefined}
          className={`matrix-web-chat-row flex w-full items-center rounded-lg text-left focus-visible:outline-2 focus-visible:outline-primary ${mobile ? "py-3" : "py-2"}`}
          onClick={() => onSelectChat(row.chat.id)}>
          <span className="matrix-web-chat-title flex min-w-0 flex-1"><OverflowingChatTitle title={activeChatId === row.chat.id && activeChatTitle || row.chat.title} /></span>
        </button>
      </div>)}</>;
}

export function ProjectChatStatus({ rowCount, loading, error, hasMore, mobile, filtered, retry }: {
  rowCount: number; loading: boolean; error: boolean; hasMore: boolean; mobile: boolean; filtered: boolean; retry(): void;
}) {
  return <>
    {loading && rowCount === 0 ? <p role="status" className="matrix-web-project-note">Loading chats…</p> : null}
    {error ? <div className="matrix-web-project-note">
      <p role="alert">Project chats could not be loaded.</p>
      <button type="button" className="matrix-web-project-more" data-mobile={mobile || undefined} onClick={retry}>Retry chats</button>
    </div> : null}
    {/* One quiet line, as on Electron Desktop. */}
    {!loading && !error && !hasMore && rowCount === 0 ? <p className="matrix-web-project-note">
      {filtered ? "No matching chats in this project." : "No chats in this project yet."}
    </p> : null}
  </>;
}

export function ProjectChatPaging({ projectName, hiddenCount, loading, error, hasMore, capped, mobile, showMore, loadMore }: {
  projectName: string; hiddenCount: number; loading: boolean; error: boolean; hasMore: boolean; capped: boolean; mobile: boolean;
  showMore(): void; loadMore(): void;
}) {
  return <>
    {hiddenCount > 0 ? <button type="button" aria-label={`Show more ${projectName} chats`} className="matrix-web-project-more"
      data-mobile={mobile || undefined} onClick={showMore}>Show more</button> : null}
    {!loading && !error && hiddenCount <= 0 && hasMore ? <button type="button" className="matrix-web-project-more"
      data-mobile={mobile || undefined} onClick={loadMore}>Load more chats</button> : null}
    {hiddenCount <= 0 && capped ? <p className="matrix-web-project-note">Showing the newest {MAX_PROJECT_CHAT_ROWS.toLocaleString("en-US")} chats in this project.</p> : null}
  </>;
}
