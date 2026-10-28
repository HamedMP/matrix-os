"use client";

import { ChatRailSection, filterChatsByImportSource, useMinuteClock, type ChatImportSourceFilterValue } from "@matrix-os/ui";
import { ChevronLeft } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { RenameableConversation } from "./ChatTitleRename";
import { usePagedProjectChats } from "./usePagedProjectChats";
import { WebChatLifecycleGroups } from "./WebChatLifecycleGroups";
import { ProjectChatPaging, ProjectChatRows, ProjectChatStatus } from "./WebProjectsNav";
import type { WebProject } from "./web-projects";

/** Sidebar narrowed to one project, as on Electron Desktop: its chats by lifecycle, older chats below, and a way back. */
export function FocusedWebProject({ project, gatewayUrl, chats, listedChatIds, scopeKey, activeChatId, activeChatTitle,
  onSelectChat, renderRow, onBack, mobile, unreadOnly, sourceFilter, searchQuery }: {
  project: WebProject;
  gatewayUrl: string;
  /** The project's chats from navigation, pinned ones included. */
  chats: readonly RenameableConversation[];
  listedChatIds: ReadonlySet<string>;
  scopeKey?: string;
  activeChatId?: string;
  activeChatTitle?: string;
  onSelectChat(chatId: string): void;
  renderRow(chat: RenameableConversation): ReactNode;
  onBack(): void;
  mobile: boolean;
  unreadOnly: boolean;
  sourceFilter: ChatImportSourceFilterValue;
  searchQuery: string;
}) {
  const { fetched, loading, error, retry, loadMore, hasMore, capped } = usePagedProjectChats(project, gatewayUrl, unreadOnly, true);
  const [olderExpanded, setOlderExpanded] = useState(true);
  const nowMs = useMinuteClock(true);
  const search = searchQuery.trim().toLowerCase();
  // Paged rows only fill in Chats outside navigation; listed ones keep their lifecycle section.
  const older = filterChatsByImportSource(fetched.filter(chat => !listedChatIds.has(chat.id)
    && (!search || chat.title.toLowerCase().includes(search))), sourceFilter, chat => chat.importSource);
  const empty = chats.length === 0 && older.length === 0;
  return <>
    <div className="matrix-web-project-header" data-mobile={mobile || undefined}>
      <button type="button" aria-label="Back to all chats" title="Back to all chats" className="matrix-web-project-back" onClick={onBack}>
        <ChevronLeft aria-hidden="true" size={15} />
      </button>
      <h2 title={project.name}>{project.name}</h2>
    </div>
    {empty ? <>
      <ProjectChatStatus rowCount={0} loading={loading} error={error} hasMore={hasMore} mobile={mobile} retry={retry}
        filtered={unreadOnly || sourceFilter !== "all" || Boolean(search)} />
      {/* Later pages may still match the search or filter. */}
      <ProjectChatPaging projectName={project.name} hiddenCount={0} loading={loading} error={error} hasMore={hasMore} capped={capped}
        mobile={mobile} showMore={() => {}} loadMore={loadMore} />
    </> : null}
    {chats.length > 0 ? <WebChatLifecycleGroups conversations={chats} scopeKey={`${scopeKey ?? ""}:project:${project.id}`} renderRow={renderRow} /> : null}
    {older.length > 0 || (!empty && (error || hasMore || capped)) ? <ChatRailSection label="Older chats" count={older.length}
      expanded={olderExpanded} onExpandedChange={setOlderExpanded}>
      <ProjectChatRows rows={older.map(chat => ({ kind: "fetched", chat } as const))} projectId={project.id} nowMs={nowMs}
        activeChatId={activeChatId} activeChatTitle={activeChatTitle} onSelectChat={onSelectChat} renderChat={() => null} mobile={mobile} />
      {error ? <ProjectChatStatus rowCount={older.length} loading={false} error mobile={mobile} retry={retry} hasMore={hasMore} filtered={false} /> : null}
      <ProjectChatPaging projectName={project.name} hiddenCount={0} loading={loading} error={error} hasMore={hasMore} capped={capped}
        mobile={mobile} showMore={() => {}} loadMore={loadMore} />
    </ChatRailSection> : null}
  </>;
}
