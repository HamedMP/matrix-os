"use client";

import { useCallback, useMemo } from "react";
import { ProjectConversationList, useMinuteClock, type ChatNavigationRecord } from "@matrix-os/ui";
import { FolderOpen } from "@/lib/hugeicons";
import type { RenameableConversation } from "./ChatTitleRename";
import { WebProjectAgentContext } from "./WebProjectAgentContext";
import type { WebProject } from "./web-projects";

/** Web Desktop project home, matching Electron Desktop: slim header, agent configuration, one row per Chat. */
export function WebProjectHome({ project, gatewayUrl, identity, isCurrentAuthority, conversations = [], onSelectChat, active = true }: {
  project: WebProject;
  gatewayUrl: string;
  identity: string;
  isCurrentAuthority?: () => boolean;
  /** This project's Chats from the shared navigation projection. */
  conversations?: readonly RenameableConversation[];
  onSelectChat?: (chatId: string) => void;
  active?: boolean;
}) {
  const nowMs = useMinuteClock(active);
  const records = useMemo(() => conversations.flatMap((chat) => chat.canonicalRecord ? [chat.canonicalRecord] : []), [conversations]);
  const previews = useMemo(() => new Map(conversations.map((chat) => [chat.id, chat.preview])), [conversations]);
  const snippetFor = useCallback((record: ChatNavigationRecord) => previews.get(record.chat.id), [previews]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]" data-slot="chat-project-home">
      <div className="mx-auto w-full max-w-[808px] px-6 pb-4 pt-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-hover)] text-foreground">
            <FolderOpen size={17} aria-hidden />
          </span>
          <h1 className="min-w-0 truncate text-[20px] font-medium leading-7 text-foreground" style={{ fontFamily: "var(--font-heading)" }}>
            {project.name}
          </h1>
        </div>
        <WebProjectAgentContext project={project} gatewayUrl={gatewayUrl} identity={identity} isCurrentAuthority={isCurrentAuthority} />
        <ProjectConversationList projectName={project.name} records={records} status="ready" nowMs={nowMs}
          snippetFor={snippetFor} onSelect={onSelectChat ? (record) => onSelectChat(record.chat.id) : undefined} />
      </div>
    </div>
  );
}
