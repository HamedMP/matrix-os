import type { CanonicalChatRecord } from "@matrix-os/contracts";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  MessageSquare,
  PanelLeftOpenIcon,
  PinIcon,
  PinOffIcon,
  Plus,
  Trash2,
} from "@renderer/lib/hugeicons";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ContextMenu } from "../../design/primitives";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";
import type { Project } from "../../stores/board";
import { canonicalChatRequestId } from "../chat/canonical-chat-submission";
import { DeleteConversationDialog } from "../chat/DeleteConversationDialog";
import ProjectLifecycleDialog from "../mission-control/ProjectLifecycleDialog";
import { buildWorkRailModel } from "./work-rail-model";

type SectionKey = "pinned" | "projects" | "recents";
const MAX_CHAT_PAGES = 10;

async function loadWorkRailChats(client: CanonicalChatClient): Promise<CanonicalChatRecord[]> {
  const records: CanonicalChatRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CHAT_PAGES; page += 1) {
    const response = await client.list({ limit: 100, ...(cursor ? { cursor } : {}) });
    records.push(...response.items);
    if (!response.nextCursor || response.nextCursor === cursor) break;
    cursor = response.nextCursor;
  }
  return records;
}

export function WorkRail({
  client,
  projects,
  active,
  activeChatId,
  activeProjectSlug,
  onNewGlobalChat,
  onCreateProject,
  onNewProjectChat,
  onSelectChat,
  onChatDeleted,
  onCollapse,
  showCollapseControl = true,
  className = "w-[260px]",
}: {
  client: CanonicalChatClient | null;
  projects: Project[];
  active: boolean;
  activeChatId?: string;
  activeProjectSlug?: string;
  onNewGlobalChat: () => void;
  onCreateProject: () => void;
  onNewProjectChat: (project: Project) => void;
  onSelectChat: (record: CanonicalChatRecord, project?: Project) => void;
  onChatDeleted?: (record: CanonicalChatRecord, project?: Project) => void;
  onCollapse: () => void;
  showCollapseControl?: boolean;
  className?: string;
}) {
  const [records, setRecords] = useState<CanonicalChatRecord[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [sections, setSections] = useState<Record<SectionKey, boolean>>({
    pinned: true,
    projects: true,
    recents: true,
  });
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [pinning, setPinning] = useState<Record<string, boolean>>({});
  const [pinError, setPinError] = useState<string | null>(null);
  const [deleteChatTarget, setDeleteChatTarget] = useState<CanonicalChatRecord | null>(null);
  const [deletingChat, setDeletingChat] = useState(false);
  const [deleteChatError, setDeleteChatError] = useState<string | null>(null);
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null);
  const routeScope = `${activeChatId ?? ""}\0${activeProjectSlug ?? ""}`;
  const routeScopeRef = useRef({ key: routeScope, generation: 0 });
  if (routeScopeRef.current.key !== routeScope) {
    routeScopeRef.current = {
      key: routeScope,
      generation: routeScopeRef.current.generation + 1,
    };
  }
  const model = useMemo(() => buildWorkRailModel(records, projects), [projects, records]);

  useEffect(() => {
    let current = true;
    if (!client || !active) return () => { current = false; };
    setStatus("loading");
    void loadWorkRailChats(client).then((loaded) => {
      if (!current) return;
      setPinError(null);
      setRecords(loaded);
      setStatus("ready");
    }).catch((error: unknown) => {
      if (!current) return;
      console.warn(
        "[work] Chat list load failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      setStatus("error");
    });
    return () => { current = false; };
  }, [active, activeChatId, activeProjectSlug, client]);

  const toggleSection = (key: SectionKey) => {
    setSections((current) => ({ ...current, [key]: !current[key] }));
  };

  const updatePinned = (record: CanonicalChatRecord) => {
    if (!client || pinning[record.chat.id]) return;
    const pinned = !record.chat.userState?.pinned;
    const requestRouteGeneration = routeScopeRef.current.generation;
    setPinError(null);
    setPinning((current) => ({ ...current, [record.chat.id]: true }));
    void client.updateUserState(record.chat.id, { pinned }).then((updated) => {
      setRecords((current) => current.map((candidate) => (
        candidate.chat.id === updated.chat.id ? updated : candidate
      )));
    }).catch((error: unknown) => {
      console.warn(
        "[work] Chat pin update failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      if (routeScopeRef.current.generation === requestRouteGeneration) {
        setPinError("Chat pin could not be updated.");
      }
    }).finally(() => {
      setPinning((current) => {
        const next = { ...current };
        delete next[record.chat.id];
        return next;
      });
    });
  };

  const deleteChat = async () => {
    if (!client || !deleteChatTarget || deletingChat) return;
    const target = deleteChatTarget;
    setDeletingChat(true);
    setDeleteChatError(null);
    try {
      await client.delete(target.chat.id, canonicalChatRequestId());
      setRecords((current) => current.filter((record) => record.chat.id !== target.chat.id));
      setDeleteChatTarget(null);
      onChatDeleted?.(
        target,
        model.projects.find((group) => (
          group.id === target.projectId || group.slug === target.projectId
        ))?.project,
      );
    } catch (error: unknown) {
      console.warn(
        "[work] Chat deletion failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      setDeleteChatError("The Chat could not be deleted. Try again.");
    } finally {
      setDeletingChat(false);
    }
  };

  return (
    <nav
      aria-label="Chat navigation"
      className={`flex min-h-0 shrink-0 flex-col border-r ${className}`}
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}
    >
      <div className="mx-3 flex items-center gap-1 border-b py-3" style={{ borderColor: "var(--border-subtle)" }}>
        <button
          type="button"
          className="flex h-9 min-w-0 flex-1 items-center justify-start gap-2 rounded-md px-2 text-left text-[15px] font-medium outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{ color: "var(--text-primary)" }}
          onClick={onNewGlobalChat}
        >
          <Plus size={18} aria-hidden />
          New chat
        </button>
        {showCollapseControl ? <button
          type="button"
          aria-label="Hide Chat navigation"
          title="Hide Chat navigation"
          className="flex size-8 shrink-0 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{ color: "var(--text-tertiary)" }}
          onClick={onCollapse}
        >
          <PanelLeftOpenIcon size={15} aria-hidden />
        </button> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <RailSection
          label="Pinned"
          expanded={sections.pinned}
          onToggle={() => toggleSection("pinned")}
        >
          {model.pinned.map((record) => (
            <ChatRow
              key={record.chat.id}
              record={record}
              active={record.chat.id === activeChatId}
              pinning={Boolean(pinning[record.chat.id])}
              onSelect={() => onSelectChat(
                record,
                model.projects.find((group) => (
                  group.id === record.projectId || group.slug === record.projectId
                ))?.project,
              )}
              onPin={() => updatePinned(record)}
              onDelete={() => {
                setDeleteChatError(null);
                setDeleteChatTarget(record);
              }}
            />
          ))}
        </RailSection>

        <RailSection
          label="Projects"
          expanded={sections.projects}
          onToggle={() => toggleSection("projects")}
          action={(
            <button
              type="button"
              aria-label="Create project"
              title="Create project"
              className="flex size-6 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              onClick={onCreateProject}
            >
              <Plus size={14} aria-hidden />
            </button>
          )}
        >
          {model.projects.map((group) => {
            const expanded = Boolean(expandedProjects[group.id]);
            return (
              <div key={group.id}>
                <ContextMenu items={[{
                  label: "Delete",
                  danger: true,
                  onSelect: () => setDeleteProjectTarget(group.project),
                }]}>
                  <div className="group/project flex min-w-0 items-center gap-1 rounded-md hover:bg-[var(--bg-hover)]">
                    <button
                      type="button"
                      aria-label={group.name}
                      aria-expanded={expanded}
                      className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
                      style={{ color: activeProjectSlug === group.slug ? "var(--text-primary)" : "var(--text-secondary)" }}
                      onClick={() => setExpandedProjects((current) => ({
                        ...current,
                        [group.id]: !current[group.id],
                      }))}
                    >
                      {expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                      <Folder size={14} aria-hidden className="shrink-0" />
                      <span className="truncate">{group.name}</span>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5 pr-1 opacity-0 transition-opacity group-hover/project:opacity-100 group-focus-within/project:opacity-100">
                      <button
                        type="button"
                        aria-label={`New chat in ${group.name}`}
                        title={`New chat in ${group.name}`}
                        className="flex size-6 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-selected)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                        onClick={() => onNewProjectChat(group.project)}
                      >
                        <Plus size={13} aria-hidden />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${group.name} project`}
                        title={`Delete ${group.name} project`}
                        className="flex size-6 items-center justify-center rounded-md outline-none hover:bg-[var(--danger-muted)] hover:text-[var(--danger)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                        onClick={() => setDeleteProjectTarget(group.project)}
                      >
                        <Trash2 size={13} aria-hidden />
                      </button>
                    </div>
                  </div>
                </ContextMenu>
                {expanded ? (
                  <div className="ml-4 border-l pl-1" style={{ borderColor: "var(--border-subtle)" }}>
                    {group.chats.map((record) => (
                      <ChatRow
                        key={record.chat.id}
                        record={record}
                        active={record.chat.id === activeChatId}
                        pinning={Boolean(pinning[record.chat.id])}
                        onSelect={() => onSelectChat(record, group.project)}
                        onPin={() => updatePinned(record)}
                        onDelete={() => {
                          setDeleteChatError(null);
                          setDeleteChatTarget(record);
                        }}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </RailSection>

        <RailSection
          label="Recents"
          expanded={sections.recents}
          onToggle={() => toggleSection("recents")}
        >
          {model.recents.map((record) => (
            <ChatRow
              key={record.chat.id}
              record={record}
              active={record.chat.id === activeChatId}
              pinning={Boolean(pinning[record.chat.id])}
              onSelect={() => onSelectChat(record)}
              onPin={() => updatePinned(record)}
              onDelete={() => {
                setDeleteChatError(null);
                setDeleteChatTarget(record);
              }}
            />
          ))}
        </RailSection>
        {status === "loading" && records.length === 0 ? (
          <p role="status" className="px-2 py-3 text-xs" style={{ color: "var(--text-tertiary)" }}>Loading chats…</p>
        ) : null}
        {status === "error" ? (
          <p role="alert" className="px-2 py-3 text-xs" style={{ color: "var(--text-tertiary)" }}>Chats could not be loaded.</p>
        ) : null}
        {pinError ? (
          <p role="alert" className="px-2 py-3 text-xs" style={{ color: "var(--text-tertiary)" }}>{pinError}</p>
        ) : null}
      </div>
      <DeleteConversationDialog
        conversation={deleteChatTarget ? {
          id: deleteChatTarget.chat.id,
          title: deleteChatTarget.chat.title,
        } : null}
        deleting={deletingChat}
        error={deleteChatError}
        onCancel={() => {
          if (deletingChat) return;
          setDeleteChatTarget(null);
          setDeleteChatError(null);
        }}
        onConfirm={() => { void deleteChat(); }}
      />
      {deleteProjectTarget ? (
        <ProjectLifecycleDialog
          open
          project={deleteProjectTarget}
          onClose={() => setDeleteProjectTarget(null)}
        />
      ) : null}
    </nav>
  );
}

function RailSection({
  label,
  expanded,
  onToggle,
  action,
  children,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-2">
      <div className="flex h-7 items-center gap-1">
        <button
          type="button"
          aria-label={label}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 text-left text-[11px] font-medium uppercase tracking-[0.08em] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
          style={{ color: "var(--text-tertiary)" }}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          {label}
        </button>
        {action}
      </div>
      {expanded ? <div className="space-y-0.5">{children}</div> : null}
    </section>
  );
}

function ChatRow({
  record,
  active,
  pinning,
  onSelect,
  onPin,
  onDelete,
}: {
  record: CanonicalChatRecord;
  active: boolean;
  pinning: boolean;
  onSelect: () => void;
  onPin: () => void;
  onDelete: () => void;
}) {
  const pinned = Boolean(record.chat.userState?.pinned);
  return (
    <ContextMenu items={[
      {
        label: pinned ? "Unpin" : "Pin",
        disabled: pinning,
        onSelect: onPin,
      },
      {
        label: "Delete",
        danger: true,
        onSelect: onDelete,
      },
    ]}>
      <div
        className="group/chat flex min-w-0 items-center rounded-md hover:bg-[var(--bg-hover)]"
        style={{ background: active ? "var(--bg-selected)" : undefined }}
      >
        <button
          type="button"
          aria-label={record.chat.title}
          aria-current={active ? "page" : undefined}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
          style={{ color: active ? "var(--text-primary)" : "var(--text-secondary)" }}
          onClick={onSelect}
        >
          <MessageSquare size={13} aria-hidden className="shrink-0" />
          <span className="truncate">{record.chat.title}</span>
        </button>
        <div className="mr-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/chat:opacity-100 group-focus-within/chat:opacity-100">
          <button
            type="button"
            aria-label={`${pinned ? "Unpin" : "Pin"} ${record.chat.title}`}
            title={`${pinned ? "Unpin" : "Pin"} ${record.chat.title}`}
            disabled={pinning}
            className="flex size-6 shrink-0 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-selected)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            onClick={onPin}
          >
            {pinned ? <PinOffIcon size={13} aria-hidden /> : <PinIcon size={13} aria-hidden />}
          </button>
          <button
            type="button"
            aria-label={`Delete ${record.chat.title}`}
            title={`Delete ${record.chat.title}`}
            className="flex size-6 shrink-0 items-center justify-center rounded-md outline-none hover:bg-[var(--danger-muted)] hover:text-[var(--danger)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            onClick={onDelete}
          >
            <Trash2 size={13} aria-hidden />
          </button>
        </div>
      </div>
    </ContextMenu>
  );
}
