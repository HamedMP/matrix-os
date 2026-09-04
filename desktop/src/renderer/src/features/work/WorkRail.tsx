import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { Plus } from "@renderer/lib/hugeicons";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CanonicalChatClient,
  CanonicalChatEventSource,
} from "../../lib/canonical-chat-client";
import type { Project } from "../../stores/board";
import { canonicalChatRequestId } from "../chat/canonical-chat-submission";
import { DeleteConversationDialog } from "../chat/DeleteConversationDialog";
import ProjectLifecycleDialog from "../mission-control/ProjectLifecycleDialog";
import {
  buildWorkRailModel,
} from "./work-rail-model";
import { WorkRailChatRow } from "./work-rail/WorkRailChatRow";
import { WorkRailHeader } from "./work-rail/WorkRailHeader";
import { WorkRailProjectGroup } from "./work-rail/WorkRailProjectGroup";
import { WorkRailSection } from "./work-rail/WorkRailSection";
import { WorkRailSearchDialog } from "./WorkRailSearchDialog";

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
  eventSource,
  projects,
  active,
  activeChatId,
  activeProjectSlug,
  onNewGlobalChat,
  onCreateProject,
  onNewProjectChat,
  onSelectChat,
  onChatDeleted,
  onChatRenamed,
  onCollapse,
  showCollapseControl = true,
  className = "w-[240px]",
}: {
  client: CanonicalChatClient | null;
  eventSource?: Pick<CanonicalChatEventSource, "subscribe">;
  projects: Project[];
  active: boolean;
  activeChatId?: string;
  activeProjectSlug?: string;
  onNewGlobalChat: () => void;
  onCreateProject: () => void;
  onNewProjectChat: (project: Project) => void;
  onSelectChat: (record: CanonicalChatRecord, project?: Project) => void;
  onChatDeleted?: (record: CanonicalChatRecord, project?: Project) => void;
  onChatRenamed?: (record: CanonicalChatRecord, project?: Project) => void;
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
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const routeScope = `${active ? "active" : "inactive"}\0${activeChatId ?? ""}\0${activeProjectSlug ?? ""}`;
  const routeScopeRef = useRef({ client, key: routeScope, generation: 0 });
  if (routeScopeRef.current.key !== routeScope || routeScopeRef.current.client !== client) {
    routeScopeRef.current = {
      client,
      key: routeScope,
      generation: routeScopeRef.current.generation + 1,
    };
  }
  const model = useMemo(() => buildWorkRailModel(records, projects), [projects, records]);

  useEffect(() => {
    if (!active || !client) setSearchOpen(false);
  }, [active, client]);

  useEffect(() => {
    let current = true;
    if (!client || !active) return () => { current = false; };
    let refreshInFlight = false;
    let refreshPending = false;
    setPinError(null);
    setPinning({});
    setDeleteChatTarget(null);
    setDeletingChat(false);
    setDeleteChatError(null);
    setRenamingChatId(null);
    setRenamePending(false);
    setRenameError(null);
    setStatus("loading");
    const refresh = async () => {
      if (refreshInFlight) {
        refreshPending = true;
        return;
      }
      refreshInFlight = true;
      do {
        refreshPending = false;
        try {
          const loaded = await loadWorkRailChats(client);
          if (!current) return;
          setRecords(loaded);
          setStatus("ready");
        } catch (error: unknown) {
          if (!current) return;
          console.warn(
            "[work] Chat list load failed:",
            error instanceof Error ? error.name : "UnknownError",
          );
          setStatus("error");
        }
      } while (current && refreshPending);
      refreshInFlight = false;
    };
    const subscription = eventSource?.subscribe(() => void refresh());
    void refresh();
    return () => {
      current = false;
      refreshPending = false;
      subscription?.dispose();
    };
  }, [active, activeChatId, activeProjectSlug, client, eventSource]);

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
      if (routeScopeRef.current.generation !== requestRouteGeneration) return;
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
      if (routeScopeRef.current.generation !== requestRouteGeneration) return;
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
    const requestRouteGeneration = routeScopeRef.current.generation;
    const targetProject = model.projects.find((group) => (
      group.id === target.projectId || group.slug === target.projectId
    ))?.project;
    setDeletingChat(true);
    setDeleteChatError(null);
    try {
      await client.delete(target.chat.id, canonicalChatRequestId());
      if (routeScopeRef.current.generation !== requestRouteGeneration) return;
      setRecords((current) => current.filter((record) => record.chat.id !== target.chat.id));
      setDeleteChatTarget(null);
      onChatDeleted?.(target, targetProject);
    } catch (error: unknown) {
      console.warn(
        "[work] Chat deletion failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      if (routeScopeRef.current.generation === requestRouteGeneration) {
        setDeleteChatError("The Chat could not be deleted. Try again.");
      }
    } finally {
      if (routeScopeRef.current.generation === requestRouteGeneration) {
        setDeletingChat(false);
      }
    }
  };

  const renameChat = async (record: CanonicalChatRecord, title: string) => {
    if (!client || renamePending) return;
    const requestRouteGeneration = routeScopeRef.current.generation;
    const targetProject = model.projects.find((group) => (
      group.id === record.projectId || group.slug === record.projectId
    ))?.project;
    setRenamePending(true);
    setRenameError(null);
    try {
      const updated = await client.updateTitle(record.chat.id, {
        baseRevision: record.chat.revision,
        title,
      });
      if (routeScopeRef.current.generation !== requestRouteGeneration) return;
      setRecords((current) => current.map((candidate) => (
        candidate.chat.id === updated.chat.id ? updated : candidate
      )));
      setRenamingChatId(null);
      onChatRenamed?.(updated, targetProject);
    } catch (error: unknown) {
      console.warn("[work] Chat rename failed:", error instanceof Error ? error.name : "UnknownError");
      if (routeScopeRef.current.generation === requestRouteGeneration) {
        setRenameError("The Chat could not be renamed. Try again.");
        setRenamingChatId(null);
      }
    } finally {
      if (routeScopeRef.current.generation === requestRouteGeneration) setRenamePending(false);
    }
  };

  return (
    <nav
      aria-label="Chat navigation"
      className={`flex min-h-0 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2 ${className}`}
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
    >
      <WorkRailHeader
        onNewChat={onNewGlobalChat}
        onSearch={() => setSearchOpen(true)}
        onCollapse={onCollapse}
        showCollapseControl={showCollapseControl}
      />
      <div className="contents">
        <WorkRailSection
          label="Pinned"
          expanded={sections.pinned}
          onToggle={() => toggleSection("pinned")}
        >
          {model.pinned.map((record) => (
            <WorkRailChatRow
              key={record.chat.id}
              record={record}
              placement="pinned"
              active={record.chat.id === activeChatId}
              pinning={Boolean(pinning[record.chat.id])}
              renaming={renamingChatId === record.chat.id}
              renamePending={renamePending && renamingChatId === record.chat.id}
              renameDisabled={renamePending}
              onRenameStart={() => {
                if (renamePending) return;
                setRenameError(null);
                setRenamingChatId(record.chat.id);
              }}
              onRenameCommit={(title) => { void renameChat(record, title); }}
              onRenameCancel={() => setRenamingChatId(null)}
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
        </WorkRailSection>

        <WorkRailSection
          label="Projects"
          expanded={sections.projects}
          onToggle={() => toggleSection("projects")}
          action={(
            <button
              type="button"
              aria-label="Create project"
              title="Create project"
              className="flex size-5 items-center justify-center rounded-md opacity-0 outline-none transition-opacity hover:bg-[var(--bg-hover)] focus:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)] [section:hover_&]:opacity-100"
              style={{ color: "var(--text-tertiary)" }}
              onClick={onCreateProject}
            >
              <Plus size={12} aria-hidden />
            </button>
          )}
        >
          {model.projects.map((group) => {
            const expanded = Boolean(expandedProjects[group.id]);
            return (
              <WorkRailProjectGroup
                key={group.id}
                group={group}
                expanded={expanded}
                activeProjectSlug={activeProjectSlug}
                activeChatId={activeChatId}
                pinning={pinning}
                renamingChatId={renamingChatId}
                renamePending={renamePending}
                onRenameChat={(record) => {
                  if (renamePending) return;
                  setRenameError(null);
                  setRenamingChatId(record.chat.id);
                }}
                onRenameCommit={(record, title) => { void renameChat(record, title); }}
                onRenameCancel={() => setRenamingChatId(null)}
                onToggle={() => setExpandedProjects((current) => ({
                  ...current,
                  [group.id]: !current[group.id],
                }))}
                onNewChat={onNewProjectChat}
                onDeleteProject={setDeleteProjectTarget}
                onSelectChat={onSelectChat}
                onPinChat={updatePinned}
                onDeleteChat={(record) => {
                  setDeleteChatError(null);
                  setDeleteChatTarget(record);
                }}
              />
            );
          })}
        </WorkRailSection>

        <WorkRailSection
          label="Recents"
          expanded={sections.recents}
          onToggle={() => toggleSection("recents")}
          divider={false}

        >
          {model.recents.map((record) => (
            <WorkRailChatRow
              key={record.chat.id}
              record={record}
              placement="recent"
              active={record.chat.id === activeChatId}
              pinning={Boolean(pinning[record.chat.id])}
              renaming={renamingChatId === record.chat.id}
              renamePending={renamePending && renamingChatId === record.chat.id}
              renameDisabled={renamePending}
              onRenameStart={() => {
                if (renamePending) return;
                setRenameError(null);
                setRenamingChatId(record.chat.id);
              }}
              onRenameCommit={(title) => { void renameChat(record, title); }}
              onRenameCancel={() => setRenamingChatId(null)}
              onSelect={() => onSelectChat(record)}
              onPin={() => updatePinned(record)}
              onDelete={() => {
                setDeleteChatError(null);
                setDeleteChatTarget(record);
              }}
            />
          ))}
        </WorkRailSection>
        {status === "loading" && records.length === 0 ? (
          <p role="status" className="px-2 py-3 text-xs" style={{ color: "var(--text-tertiary)" }}>Loading chats…</p>
        ) : null}
        {status === "error" ? (
          <p role="alert" className="px-2 py-3 text-xs" style={{ color: "var(--text-tertiary)" }}>Chats could not be loaded.</p>
        ) : null}
        {pinError ? (
          <p role="alert" className="px-2 py-3 text-xs" style={{ color: "var(--text-tertiary)" }}>{pinError}</p>
        ) : null}
        {renameError ? (
          <p role="alert" className="px-2 py-3 text-xs" style={{ color: "var(--danger)" }}>{renameError}</p>
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
      <WorkRailSearchDialog
        open={searchOpen}
        records={records}
        projects={projects}
        status={status}
        onClose={() => setSearchOpen(false)}
        onSelect={(record, project) => {
          setSearchOpen(false);
          if (project) onSelectChat(record, project);
          else onSelectChat(record);
        }}
      />
    </nav>
  );
}
