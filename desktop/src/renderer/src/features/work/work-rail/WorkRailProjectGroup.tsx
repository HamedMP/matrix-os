import { RailCollapse } from "./RailCollapse";
import { WorkRailOrderItem } from "./WorkRailOrderItem";
import { useRef, useState } from "react";
import { OverflowingChatTitle, useMinuteClock } from "@matrix-os/ui";
import type { ChatNavigationRecord } from "@matrix-os/ui";
import { ChevronRight, Folder, FolderOpen, SquarePen as PencilEditIcon, PinIcon, PinOffIcon, Settings, Trash2, UsersIcon } from "lucide-react";
import { ProjectActionsMenu, ProjectActionsButton, type ProjectMenuAction } from "./ProjectActionsMenu";
import { ProjectEditDialog } from "./ProjectActionDialogs";
import { useProjectActions } from "./use-project-actions";
import type { Project } from "../../../stores/board";
import type { WorkRailProjectGroup as WorkRailProjectGroupModel } from "../work-rail-model";
import { WorkRailChatRow } from "./WorkRailChatRow";
import type { DesktopProjectSharingContext } from "../../project/DesktopProjectSharing";
import { projectShareMenuItems } from "./project-share-action";

const PROJECT_CHAT_PAGE = 6;

export function WorkRailProjectGroup({
  group,
  fresh = true,
  shared = false,
  expanded,
  activeProjectSlug,
  activeChatId,
  pinning,
  onToggle,
  onSelect,
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
  sharing = null,
  onShareProject,
  moveItems,
  movingChatId,
}: {
  group: WorkRailProjectGroupModel;
  fresh?:boolean;
  shared?: boolean;
  expanded: boolean;
  activeProjectSlug?: string;
  activeChatId?: string;
  pinning: Record<string, boolean>;
  onToggle: () => void;
  onSelect?: (project: Project) => void;
  onNewChat: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  onSelectChat: (record: ChatNavigationRecord, project: Project) => void;
  renamingChatId: string | null;
  renamePending: boolean;
  onToggleRead?: (record: ChatNavigationRecord) => void;
  readPending?: boolean;
  onRenameChat: (record: ChatNavigationRecord) => void;
  onRenameCommit: (record: ChatNavigationRecord, title: string) => void;
  onRenameCancel: () => void;
  onPinChat: (record: ChatNavigationRecord) => void;
  onDeleteChat: (record: ChatNavigationRecord) => void;
  sharing?: DesktopProjectSharingContext | null;
  onShareProject?: (project: Project) => void;
  moveItems?: (record: ChatNavigationRecord) => {label: string; disabled?: boolean; onSelect: () => void}[];
  movingChatId?: string | null;
}) {
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const [limit, setLimit] = useState(PROJECT_CHAT_PAGE);
  const nowMs = useMinuteClock(expanded);
  // Never hide the open Chat behind Show more.
  const shownCount = Math.max(limit, group.chats.findIndex((record) => record.chat.id === activeChatId) + 1);
  const hiddenCount = group.chats.length - shownCount;
  const actions = useProjectActions(group.project);
  const items: ProjectMenuAction[] = [
    { label: group.project.pinned ? "Unpin" : "Pin", icon: group.project.pinned ? <PinOffIcon size={16} aria-hidden /> : <PinIcon size={16} aria-hidden />, disabled: !actions.available || actions.pending, onSelect: () => { void actions.update({ pinned: !group.project.pinned }); } },
    { label: "Edit", icon: <Settings size={16} aria-hidden />, disabled: !actions.available || actions.pending, onSelect: () => actions.setDialog("edit") },
    { label: "Show in Files", icon: <FolderOpen size={16} aria-hidden />, disabled: !actions.available || actions.pending, onSelect: () => { void actions.showInFiles(); } },
    ...projectShareMenuItems(group, sharing, onShareProject),
    { label: "Delete project", icon: <Trash2 size={16} aria-hidden />, danger: true, disabled: actions.pending, onSelect: () => onDeleteProject(group.project) },
  ];
  return (
    <div>
      <ProjectActionsMenu items={items}>
        <div data-chat-title-row data-current={activeProjectSlug === group.slug && !activeChatId || undefined} className="work-rail-project group/project relative flex min-w-0 items-center">
          <div className="work-rail-project-main">
            <button
              type="button"
              aria-label={group.name}
              title={group.name}
              aria-current={activeProjectSlug === group.slug && !activeChatId ? "page" : undefined}
              className="work-rail-project-select flex min-w-0 flex-1 items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 text-left text-sm font-normal transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
              style={{ color: "var(--matrix-chat-rail-text, var(--text-primary))" }}
              onClick={() => onSelect?.(group.project)}
            >
              {expanded
                ? <FolderOpen size={15} aria-hidden className="shrink-0" style={{ color: "var(--matrix-chat-rail-text, var(--text-primary))" }} />
                : <Folder size={15} aria-hidden className="shrink-0" style={{ color: "var(--matrix-chat-rail-text, var(--text-primary))" }} />}
              <OverflowingChatTitle title={group.name} />
              {shared ? <span role="img" aria-label="Shared project" title="Shared with others" className="ml-auto flex shrink-0" style={{ color: "var(--matrix-chat-rail-muted, var(--text-secondary))" }}>
                <UsersIcon size={13} aria-hidden />
              </span> : null}
            </button>
            <button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${group.name} chats`} aria-expanded={expanded}
              className="work-rail-project-disclosure grid size-6 shrink-0 place-items-center rounded-[8px] outline-none hover:bg-[var(--bg-selected)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              onClick={onToggle}>
              <ChevronRight size={12} aria-hidden className={`transition-transform duration-200 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`} />
            </button>
          </div>
          <div className="work-rail-project-actions flex shrink-0 items-center gap-0.5">
            <ProjectActionsButton buttonRef={actionButtonRef} name={group.name} items={items} />
            <button
              type="button"
              aria-label={`New chat in ${group.name}`}
              title={`New chat in ${group.name}`}
              className="flex size-6 items-center justify-center rounded-[8px] outline-none hover:bg-[var(--bg-selected)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              onClick={() => onNewChat(group.project)}
            >
              <PencilEditIcon size={15} aria-hidden />
            </button>
          </div>

        </div>
      </ProjectActionsMenu>
      {actions.error && actions.dialog !== "edit" ? <p role="alert" className="px-2 text-xs" style={{ color: "var(--danger)" }}>{actions.error}</p> : null}
      {actions.dialog === "edit" ? <ProjectEditDialog returnFocusRef={actionButtonRef} project={group.project} pending={actions.pending} error={actions.error} onClose={() => actions.setDialog(null)} onSave={actions.update} /> : null}
      <RailCollapse expanded={expanded} className="flex flex-col gap-0.5">
          {group.chats.slice(0, shownCount).map((record) => (
            <WorkRailOrderItem key={record.chat.id} id={record.chat.id} kind="chat" group={`project:${group.id}`}><WorkRailChatRow fresh={fresh}
              record={record}
              moveItems={moveItems?.(record)}
              moving={movingChatId === record.chat.id}
              placement="project"
              nowMs={nowMs}
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
            /></WorkRailOrderItem>
          ))}
          {hiddenCount > 0 ? <button type="button" aria-label={`Show more ${group.name} chats`}
            className="rounded-[8px] px-2.5 py-1 pl-[24px] text-left text-xs outline-none hover:bg-[var(--matrix-chat-rail-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
            style={{ color: "var(--matrix-chat-rail-muted, var(--text-secondary))" }}
            onClick={() => setLimit(shownCount + PROJECT_CHAT_PAGE)}>Show more</button> : null}
      </RailCollapse>
    </div>
  );
}
