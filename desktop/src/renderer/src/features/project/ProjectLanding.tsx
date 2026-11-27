import { useRef, type ReactNode, type RefObject } from "react";
import { FolderOpen, PencilEditIcon } from "@renderer/lib/hugeicons";
import type { ChatNavigationRecord } from "@matrix-os/ui";
import { ProjectConversationList, useMinuteClock, ProjectSetupEntry, useProjectSetupLaunch } from "@matrix-os/ui";
import type { CanonicalChatClient, CanonicalChatEventSource } from "../../lib/canonical-chat-client";
import { DesktopProjectAgentContext } from "./DesktopProjectAgentContext";
import { useProjectLandingChats } from "./use-project-landing-chats";
import type { Project } from "../../stores/board";
import { ProjectEditDialog } from "../work/work-rail/ProjectActionDialogs";
import { useProjectActions } from "../work/work-rail/use-project-actions";

export const PROJECT_LANDING_CONTENT_CLASS = "mx-auto w-full max-w-3xl px-6";

const chipClass = "flex h-7 min-w-0 shrink items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50";

/**
 * Project home: a slim header (description, files, agent configuration) above
 * one row per conversation; the existing canonical draft stays authoritative.
 */
export function ProjectLanding({ project, children, showMetadata = true, records, onSelectChat, client, eventSource, active = true }: {
  project: Project; children: ReactNode; showMetadata?: boolean; records?: ChatNavigationRecord[];
  onSelectChat?: (record: ChatNavigationRecord) => void;
  client?: CanonicalChatClient | null; eventSource?: Pick<CanonicalChatEventSource, "subscribe">; active?: boolean;
}) {
  const setupLaunch = useProjectSetupLaunch();
  const showOverview = showMetadata && !setupLaunch?.requested;
  const list = conversationListState(records, useProjectLandingChats(project, client, eventSource, active));
  const actions = useProjectActions(project);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const nowMs = useMinuteClock(active && showMetadata);
  return <div className="@container/project-landing flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden">
    {/* The full-width scroller reserves a gutter on both edges, so a growing chat
        list never shifts the layout and its centred column lines up with the
        composer below, which keeps its full width. */}
    {showOverview ? <header className="min-h-0 w-full flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
      <div className={`${PROJECT_LANDING_CONTENT_CLASS} pb-2 pt-[52px]`}>
        <ProjectLandingHeader project={project} disabled={!actions.available || actions.pending} editButtonRef={editButtonRef}
          onEdit={() => actions.setDialog("edit")} onOpenFiles={() => { void actions.showInFiles(); }} />
        {setupLaunch ? <ProjectSetupEntry onStart={setupLaunch.request} /> : null}
        <DesktopProjectAgentContext projectId={project.id}
          projectSlug={project.slug} filesPending={actions.pending} onOpenFiles={() => actions.showInFiles(true)} />
        <ProjectConversationList projectName={project.name} {...list} nowMs={nowMs} onSelect={onSelectChat} />
        {actions.error && actions.dialog !== "edit" ? <p role="alert" className="mt-2 text-xs" style={{ color: "var(--danger-text)" }}>{actions.error}</p> : null}
      </div>
    </header> : null}
    {/* Metadata owns spare height; the draft uses its content height and may
        shrink for scrollable provider guidance in a short window. */}
    <div className={`flex min-h-0 min-w-0 flex-col overflow-hidden ${showOverview ? "shrink" : "flex-1"}`}>{children}</div>
    {actions.dialog === "edit" ? <ProjectEditDialog project={project} returnFocusRef={editButtonRef} pending={actions.pending} error={actions.error} onClose={() => actions.setDialog(null)} onSave={actions.update} /> : null}
  </div>;
}

/** Caller-supplied rows are authoritative; otherwise the project's own loaded Chats drive the list state. */
function conversationListState(records: ChatNavigationRecord[] | undefined, loaded: ReturnType<typeof useProjectLandingChats>) {
  if (records) return { records, status: "ready" as const, truncated: false };
  const status = loaded.loading ? "loading" as const : loaded.error ? "error" as const : "ready" as const;
  return { records: loaded.chats, status, onRetry: loaded.retry, truncated: loaded.truncated };
}

function ProjectLandingHeader({ project, disabled, editButtonRef, onEdit, onOpenFiles }: {
  project: Project; disabled: boolean; editButtonRef: RefObject<HTMLButtonElement | null>; onEdit(): void; onOpenFiles(): void;
}) {
  return <>
    <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px]" style={{ background: "var(--bg-hover)", color: "var(--text-primary)" }}><FolderOpen size={17} aria-hidden /></span>
        <h1 className="min-w-0 truncate text-[20px] font-medium leading-7" style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}>{project.name}</h1>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <button ref={editButtonRef} type="button" aria-label={`Edit ${project.name} description`} disabled={disabled}
            className={chipClass} style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }} onClick={onEdit}>
            <PencilEditIcon size={14} aria-hidden className="shrink-0" /><span className="truncate">Description</span>
          </button>
          <button type="button" aria-label={`Open ${project.name} files`} disabled={disabled}
            className={chipClass} style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }} onClick={onOpenFiles}>
            <FolderOpen size={14} aria-hidden className="shrink-0" /><span className="truncate">Files</span>
          </button>
        </div>
      </div>
      <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-[18px]" style={{ color: "var(--text-tertiary)" }}>{project.description || "No description yet."}</p>
  </>;
}
