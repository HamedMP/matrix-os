import { useRef, type ReactNode } from "react";
import { FolderOpen, MessageSquare, PencilEditIcon } from "@renderer/lib/hugeicons";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { resolveCanonicalChatAttention } from "@matrix-os/ui";
import type { CanonicalChatClient, CanonicalChatEventSource } from "../../lib/canonical-chat-client";
import { useProjectLandingChats } from "./use-project-landing-chats";
import type { Project } from "../../stores/board";
import { ProjectEditDialog } from "../work/work-rail/ProjectActionDialogs";
import { useProjectActions } from "../work/work-rail/use-project-actions";

export const PROJECT_LANDING_CONTENT_CLASS = "mx-auto w-full max-w-3xl px-6";

/** Project metadata surrounds the existing canonical draft; its provider and draft stay authoritative. */
export function ProjectLanding({ project, children, showMetadata = true, records, onSelectChat, client, eventSource, active = true }: {
  project: Project; children: ReactNode; showMetadata?: boolean; records?: CanonicalChatRecord[];
  onSelectChat?: (record: CanonicalChatRecord) => void;
  client?: CanonicalChatClient | null; eventSource?: Pick<CanonicalChatEventSource, "subscribe">; active?: boolean;
}) {
  const loaded = useProjectLandingChats(project, client, eventSource, active);
  const chats = records ?? loaded.chats;
  const actions = useProjectActions(project);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  return <div className="@container/project-landing flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden">
    {showMetadata ? <header className={`${PROJECT_LANDING_CONTENT_CLASS} min-h-0 max-h-[60%] shrink-0 overflow-y-auto pb-2 pt-8`}>
      <div className="mb-5 flex items-center gap-3">
        <FolderOpen size={22} aria-hidden style={{ color: "var(--text-tertiary)" }} />
        <h1 className="truncate text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>{project.name}</h1>
      </div>
      <div className="grid grid-cols-1 gap-3 @min-[34rem]/project-landing:grid-cols-2">
        <button ref={editButtonRef} type="button" aria-label={`Edit ${project.name} description`} disabled={!actions.available || actions.pending}
          className="rounded-xl border p-4 text-left outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
          style={{ borderColor: "var(--border-subtle)" }} onClick={() => actions.setDialog("edit")}>
          <span className="mb-2 flex items-center gap-2 text-sm font-medium"><PencilEditIcon size={16} aria-hidden />Description</span>
          <span className="line-clamp-2 text-xs" style={{ color: "var(--text-tertiary)" }}>{project.description || "Add a description for this project"}</span>
        </button>
        <button type="button" aria-label={`Open ${project.name} files`} disabled={!actions.available || actions.pending}
          className="rounded-xl border p-4 text-left outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
          style={{ borderColor: "var(--border-subtle)" }} onClick={() => { void actions.showInFiles(); }}>
          <span className="mb-2 flex items-center gap-2 text-sm font-medium"><FolderOpen size={16} aria-hidden />Files</span>
          <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>Browse project files</span>
        </button>
      </div>
      {chats.length ? <div aria-label={`${project.name} chats`} className="mt-3 grid grid-cols-1 gap-3 @min-[34rem]/project-landing:grid-cols-2">
        {chats.map(record => <button key={record.chat.id} type="button" aria-label={`Open ${record.chat.title}`} disabled={!onSelectChat}
          className="rounded-xl border p-4 text-left outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
          style={{ borderColor: "var(--border-subtle)" }} onClick={() => onSelectChat?.(record)}>
          <span className="mb-2 flex min-w-0 items-center gap-2 text-sm font-medium"><MessageSquare size={16} aria-hidden className="shrink-0" /><span className="truncate">{record.chat.title}</span></span>
          <span className="text-xs" style={{color:"var(--text-tertiary)"}}>{resolveCanonicalChatAttention(record) === "running" ? "Working" : record.latestSuccessfulCompletion ? "Completed" : "Chat"}</span>
        </button>)}
      </div> : null}
      {loaded.error ? <p role="alert" className="mt-2 text-xs">Project chats could not be refreshed. Try again.</p> : null}
      {actions.error && actions.dialog !== "edit" ? <p role="alert" className="mt-2 text-xs" style={{ color: "var(--danger)" }}>{actions.error}</p> : null}
    </header> : null}
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
    {actions.dialog === "edit" ? <ProjectEditDialog project={project} returnFocusRef={editButtonRef} pending={actions.pending} error={actions.error} onClose={() => actions.setDialog(null)} onSave={actions.update} /> : null}
  </div>;
}
