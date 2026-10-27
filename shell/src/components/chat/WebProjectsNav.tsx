"use client";

import { ChatRailSection, OverflowingChatTitle, useMinuteClock } from "@matrix-os/ui";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { RenameableConversation } from "./ChatTitleRename";
import { projectChats, type WebProject, type WebProjectsState } from "./web-projects";

// Same page size as the Electron Desktop project list.
const PROJECT_CHAT_PAGE = 6;

export function WebProjectsNav({ state, chats, activeChatId, renderChat, mobile = false }: {
  state: WebProjectsState;
  chats: readonly RenameableConversation[];
  activeChatId?: string;
  renderChat(chat: RenameableConversation, nowMs: number): ReactNode;
  mobile?: boolean;
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
      {!loading && !error && projects.length === 0 ? <p className="px-2 py-2 text-xs text-muted-foreground">No projects on this computer yet.</p> : null}
      {projects.map(project => <WebProjectGroup key={project.id} project={project} chats={projectChats(chats, project)}
        activeChatId={activeChatId} renderChat={renderChat} mobile={mobile}/>)}
    </ChatRailSection>
  </nav>;
}

function WebProjectGroup({ project, chats, activeChatId, renderChat, mobile }: {
  project: WebProject;
  chats: readonly RenameableConversation[];
  activeChatId?: string;
  renderChat(chat: RenameableConversation, nowMs: number): ReactNode;
  mobile: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState(PROJECT_CHAT_PAGE);
  const nowMs = useMinuteClock(expanded);
  // Never hide the open Chat behind Show more.
  const shownCount = Math.max(limit, chats.findIndex(chat => chat.id === activeChatId) + 1);
  const hiddenCount = chats.length - shownCount;
  return <div>
    <button type="button" aria-label={`Open ${project.name} project`} aria-expanded={expanded}
      className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary ${mobile ? "min-h-11" : "min-h-9"}`}
      onClick={() => setExpanded(value => !value)}>
      {expanded ? <FolderOpen aria-hidden="true" size={15} strokeWidth={1.5} className="shrink-0" /> : <Folder aria-hidden="true" size={15} strokeWidth={1.5} className="shrink-0" />}
      <OverflowingChatTitle title={project.name} />
      <ChevronRight aria-hidden="true" size={12} className={`ml-auto shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`} />
    </button>
    {expanded ? <div className="ml-4 space-y-0.5 border-l border-border pl-2">
      {chats.length > 0 ? chats.slice(0, shownCount).map(chat => renderChat(chat, nowMs))
        : <p className="px-2 py-2 text-xs text-muted-foreground">No chats in this project yet.</p>}
      {hiddenCount > 0 ? <button type="button" aria-label={`Show more ${project.name} chats`}
        className={`w-full rounded-md px-2.5 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary ${mobile ? "min-h-11" : "min-h-7"}`}
        onClick={() => setLimit(shownCount + PROJECT_CHAT_PAGE)}>Show more</button> : null}
    </div> : null}
  </div>;
}
