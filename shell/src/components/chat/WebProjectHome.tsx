"use client";

import { useMemo } from "react";
import { ProjectConversationList, useMinuteClock, ProjectSetupEntry, type ChatAgentClient } from "@matrix-os/ui";
import { FolderOpen } from "@/lib/hugeicons";
import type { RenameableConversation } from "./ChatTitleRename";
import { WebProjectAgentContext } from "./WebProjectAgentContext";
import { useWebProjectHistory, type ChatRunStatusChange } from "./useWebProjectHistory";
import type { WebProject } from "./web-projects";

const NO_CONVERSATIONS: readonly RenameableConversation[] = [];

/** Web Desktop project home, matching Electron Desktop: slim header, agent configuration, one row per Chat. */
export function WebProjectHome({ project, gatewayUrl, identity, isCurrentAuthority, conversations = NO_CONVERSATIONS, historyIncomplete = false, historyRefreshKey, historyRunStatusChange, knownChatIds, botClient, onSelectChat, active = true, onStartSetup, setupPending, setupError }: {
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
  onStartSetup?: () => void;
  setupPending?: boolean;
  setupError?: string | null;
}) {
  const nowMs = useMinuteClock(active);
  const listed = useMemo(() => conversations.flatMap((chat) => chat.canonicalRecord ? [chat.canonicalRecord] : []), [conversations]);
  const history = useWebProjectHistory({ project, gatewayUrl, listed, knownChatIds, refreshKey: historyRefreshKey, runStatusChange: historyRunStatusChange, enabled: historyIncomplete && active, botClient });
  // An error wins so the list keeps its rows but still offers Try again.
  const status = history.error ? "error" : history.records.length > 0 ? "ready" : history.loading ? "loading" : "ready";
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
        {setupError ? <p role="alert" className="my-2 text-xs">{setupError}</p> : null}
        {onStartSetup ? <ProjectSetupEntry onStart={onStartSetup} pending={setupPending} /> : null}
        <WebProjectAgentContext onSetupWithChat={onStartSetup} project={project} gatewayUrl={gatewayUrl} identity={identity} isCurrentAuthority={isCurrentAuthority} />
        {/* No snippet: the navigation projection carries no message excerpt, only the title. */}
        <ProjectConversationList projectName={project.name} records={history.records} status={status} nowMs={nowMs}
          onRetry={history.retry} truncated={history.capped}
          onSelect={onSelectChat ? (record) => onSelectChat(record.chat.id) : undefined} />
      </div>
    </div>
  );
}
