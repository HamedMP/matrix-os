import { useRef } from "react";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { Folder, FolderOpen, SquarePen, PinIcon, PinOffIcon, Settings, Trash2 } from "@renderer/lib/hugeicons";
import { ProjectActionsMenu, ProjectActionsButton, type ProjectMenuAction } from "./ProjectActionsMenu";
import { ProjectEditDialog } from "./ProjectActionDialogs";
import { useProjectActions } from "./use-project-actions";
import type { Project } from "../../../stores/board";
import type { WorkRailProjectGroup as WorkRailProjectGroupModel } from "../work-rail-model";
import { WorkRailChatRow } from "./WorkRailChatRow";

export function WorkRailProjectGroup({
  group,
  expanded,
  activeProjectSlug,
  activeChatId,
  pinning,
  onToggle,
  onNewChat,
  onDeleteProject,
  onSelectChat,
  renamingChatId,
  renamePending,
  onToggleRead,
  readPending,
  onRenameChat,
  onRenameCommit,
  onRenameCancel,
  onPinChat,
  onDeleteChat,
}: {
  group: WorkRailProjectGroupModel;
  expanded: boolean;
  activeProjectSlug?: string;
  activeChatId?: string;
  pinning: Record<string, boolean>;
  onToggle: () => void;
  onNewChat: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  onSelectChat: (record: CanonicalChatRecord, project: Project) => void;
  renamingChatId: string | null;
  renamePending: boolean;
  onToggleRead?: (record: CanonicalChatRecord) => void;
  readPending?: boolean;
  onRenameChat: (record: CanonicalChatRecord) => void;
  onRenameCommit: (record: CanonicalChatRecord, title: string) => void;
  onRenameCancel: () => void;
  onPinChat: (record: CanonicalChatRecord) => void;
  onDeleteChat: (record: CanonicalChatRecord) => void;
}) {
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const actions = useProjectActions(group.project);
  const items: ProjectMenuAction[] = [
    { label: group.project.pinned ? "Unpin" : "Pin", icon: group.project.pinned ? <PinOffIcon size={16} aria-hidden /> : <PinIcon size={16} aria-hidden />, disabled: !actions.available || actions.pending, onSelect: () => { void actions.update({ pinned: !group.project.pinned }); } },
    { label: "Edit", icon: <Settings size={16} aria-hidden />, disabled: !actions.available || actions.pending, onSelect: () => actions.setDialog("edit") },
    { label: "Show in Files", icon: <FolderOpen size={16} aria-hidden />, disabled: !actions.available || actions.pending, onSelect: () => { void actions.showInFiles(); } },
    { label: "Delete project", icon: <Trash2 size={16} aria-hidden />, danger: true, disabled: actions.pending, onSelect: () => onDeleteProject(group.project) },
  ];
  return (
    <div>
      <ProjectActionsMenu items={items}>
        <div className="group/project relative flex min-w-0 items-center rounded-md hover:bg-[var(--bg-hover)]">
          <button
            type="button"
            aria-label={group.name}
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
            style={{ color: activeProjectSlug === group.slug ? "var(--text-primary)" : "var(--text-secondary)" }}
            onClick={onToggle}
          >
            {expanded
              ? <FolderOpen size={15} aria-hidden className="shrink-0" style={{ color: activeProjectSlug === group.slug ? "var(--accent)" : "var(--text-tertiary)" }} />
              : <Folder size={15} aria-hidden className="shrink-0" style={{ color: "var(--text-tertiary)" }} />}
            <span className="truncate">{group.name}</span>
          </button>
          <div className="mr-1 flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity [@media(hover:hover)]:opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100">
            <ProjectActionsButton buttonRef={actionButtonRef} name={group.name} items={items} />
            <button
              type="button"
              aria-label={`New chat in ${group.name}`}
              title={`New chat in ${group.name}`}
              className="flex size-6 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-selected)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              onClick={() => onNewChat(group.project)}
            >
              <SquarePen size={15} aria-hidden />
            </button>
          </div>
        </div>
      </ProjectActionsMenu>
      {actions.error && actions.dialog !== "edit" ? <p role="alert" className="px-2 text-xs" style={{ color: "var(--danger)" }}>{actions.error}</p> : null}
      {actions.dialog === "edit" ? <ProjectEditDialog returnFocusRef={actionButtonRef} project={group.project} pending={actions.pending} error={actions.error} onClose={() => actions.setDialog(null)} onSave={actions.update} /> : null}
      {expanded ? (
        <div className="flex flex-col gap-0.5 pl-5">
          {group.chats.map((record) => (
            <WorkRailChatRow
              key={record.chat.id}
              record={record}
              placement="project"
              active={record.chat.id === activeChatId}
              pinning={Boolean(pinning[record.chat.id])}
              renaming={renamingChatId === record.chat.id}
              renamePending={renamePending && renamingChatId === record.chat.id}
              renameDisabled={renamePending}
              onToggleRead={onToggleRead ? () => onToggleRead(record) : undefined}
              readPending={readPending}
              onRenameStart={() => onRenameChat(record)}
              onRenameCommit={(title) => onRenameCommit(record, title)}
              onRenameCancel={onRenameCancel}
              onSelect={() => onSelectChat(record, group.project)}
              onPin={() => onPinChat(record)}
              onDelete={() => onDeleteChat(record)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
