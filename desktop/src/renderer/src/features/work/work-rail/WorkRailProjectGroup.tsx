import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { Folder, FolderOpen, Plus, Trash2 } from "@renderer/lib/hugeicons";
import { ContextMenu } from "../../../design/primitives";
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
  onRenameChat: (record: CanonicalChatRecord) => void;
  onRenameCommit: (record: CanonicalChatRecord, title: string) => void;
  onRenameCancel: () => void;
  onPinChat: (record: CanonicalChatRecord) => void;
  onDeleteChat: (record: CanonicalChatRecord) => void;
}) {
  return (
    <div>
      <ContextMenu items={[{
        label: "Delete",
        danger: true,
        onSelect: () => onDeleteProject(group.project),
      }]}>
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
          <div className="absolute right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/project:opacity-100 group-focus-within/project:opacity-100">
            <button
              type="button"
              aria-label={`New chat in ${group.name}`}
              title={`New chat in ${group.name}`}
              className="flex size-6 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-selected)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              onClick={() => onNewChat(group.project)}
            >
              <Plus size={12} aria-hidden />
            </button>
            <button
              type="button"
              aria-label={`Delete ${group.name} project`}
              title={`Delete ${group.name} project`}
              className="flex size-6 items-center justify-center rounded-md outline-none hover:bg-[var(--danger-muted)] hover:text-[var(--danger)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              onClick={() => onDeleteProject(group.project)}
            >
              <Trash2 size={12} aria-hidden />
            </button>
          </div>
        </div>
      </ContextMenu>
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
