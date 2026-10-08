import type { ChatNavigationRecord } from "@matrix-os/ui";
import { useWorkNavigation } from "./use-work-navigation";
import {
  markChatNavigation,
  mergeChatNavigationRecord,
  notifyCollaborationDiscoveryChanged,
  chatReadAction,
  mergeChatReadState,
  useBotConversationSummaries,
  useChatSearchShortcut,
} from "@matrix-os/ui";
import type { StartAgentChat } from "@matrix-os/ui";
import { ChatAgentsRailSection, useChatAgentsNavigation } from "@matrix-os/ui";
import { useUi } from "../../stores/ui";
import { useTabs } from "../../stores/tabs";
import { type CanonicalChatRecord } from "@matrix-os/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { applyProjectedChats } from "./work-rail-data";
import { OrganizationDrivesRail } from "./work-rail/OrganizationDrivesRail";
import { useWorkRailMoves } from "./work-rail/use-work-rail-moves";
import { projectMoveAuthorityKey } from "./work-rail/new-project-chat-move";
import { WorkRailScrollArea } from "./work-rail/WorkRailScrollArea";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { useWorkRailDisclosure } from "./work-rail/use-work-rail-disclosure";
import { useWorkRailOrder } from "./work-rail/use-work-rail-order";
import { WorkRailOrderContext, WorkRailOrderItem } from "./work-rail/WorkRailOrderItem";
import { resolveCanonicalChatLifecycleGroup } from "@matrix-os/ui";
import { WorkRailChatRow } from "./work-rail/WorkRailChatRow";
import { WorkRailHeader, WorkRailSearchControls } from "./work-rail/WorkRailHeader";
import { WorkRailProjectGroup } from "./work-rail/WorkRailProjectGroup";
import { SharedWithMeRailRow } from "./work-rail/SharedWithMeRailRow";
import { partitionSharedProjects, useSharedProjects } from "./work-rail/SharedWorkRailProjects";
export { SharedWithMeRailRow } from "./work-rail/SharedWithMeRailRow";
import { WorkRailGroups, type WorkRailSectionKey } from "./work-rail/WorkRailGroups";
import { WorkRailSearchDialog } from "./WorkRailSearchDialog";
import type { CanonicalChatTitleProjection } from "./WorkSurfaceRuntime";
import { DesktopProjectSharingHost, useDesktopProjectSharingContext } from "../project/DesktopProjectSharing";
import { DesktopSharedWithMeDialog } from "../chat/DesktopChatCollaboration";

type SectionKey = WorkRailSectionKey;

export function WorkRail({
  client,
  eventSource,
  projectedChatTitles,
  projects,
  active,
  searchShortcutActive = active,
  newChatShortcutActive = false,
  visible = active,
  activeChatId,
  activeProjectSlug,
  onNewGlobalChat: newGlobalChat,
  onCreateProject: createProject,
  onNewProjectChat: newProjectChat,
  onSelectProject: selectProject,
  onSelectChat: selectChat,
  onOpenAgents,
  onStartAgentChat,
  onOpenBotChat,
  onChatDeleted,
  onChatRenamed,
  onChatMoved,
  onCollapse,
  showCollapseControl = true,
  className = "w-[240px]",
}: {
  client: CanonicalChatClient | null;
  eventSource?: Pick<CanonicalChatEventSource, "subscribe">;
  projectedChatTitles?: CanonicalChatTitleProjection[];
  projects: Project[];
  active: boolean;
  searchShortcutActive?: boolean;
  newChatShortcutActive?: boolean;
  visible?: boolean;
  activeChatId?: string;
  activeProjectSlug?: string;
  onNewGlobalChat: () => void;
  onOpenAgents?: () => void;
  onStartAgentChat?: StartAgentChat;
  onOpenBotChat?: (chatId: string) => void;
  onCreateProject: () => void;
  onNewProjectChat: (project: Project) => void;
  onSelectProject?: (project: Project) => void;
  onSelectChat: (record: CanonicalChatRecord, project?: Project) => void;
  onChatDeleted?: (record: ChatNavigationRecord, project?: Project) => void;
  onChatRenamed?: (record: CanonicalChatRecord, project?: Project) => void;
  onChatMoved?: (record: CanonicalChatRecord, project?: Project) => void;
  onCollapse: () => void;
  showCollapseControl?: boolean;
  className?: string;
}) {
  const agentsNavigation = useChatAgentsNavigation();
  const selectionAttempt = useRef(0);
  const [selectionError,setSelectionError]=useState<string|null>(null);
  const invalidateSelection = () => { selectionAttempt.current++; setSelectionError(null); };
  const onNewGlobalChat = () => { invalidateSelection(); agentsNavigation?.close(); newGlobalChat(); };
  const onCreateProject = () => { invalidateSelection(); agentsNavigation?.close(); createProject(); };
  const onSelectProject = (project: Project) => { invalidateSelection(); agentsNavigation?.close(); selectProject?.(project); };
  const onNewProjectChat = (project: Project) => { invalidateSelection(); agentsNavigation?.close(); newProjectChat(project); };
  useEffect(() => () => { selectionAttempt.current++; }, []);
  const onSelectChat = (record:ChatNavigationRecord,project?:Project) => {
    if(!client || !isCurrentScope(routeScopeRef.current)) return;
    const attempt = ++selectionAttempt.current;
    const scope=routeScopeRef.current;
    setSelectionError(null);
    void Promise.resolve().then(()=>isCurrentScope(scope) ? client.getDetail(record.chat.id,{limit:1}) : null).then(detail=>{
      if(!detail || selectionAttempt.current!==attempt || !isCurrentScope(scope)) return;
      agentsNavigation?.close(); if(project) selectChat(detail.record,project);else selectChat(detail.record);
    }).catch((error:unknown)=>{
      console.warn("[chat-navigation] Open failed:",error instanceof Error?error.name:"UnknownError");
      if(selectionAttempt.current===attempt && isCurrentScope(scope)) setSelectionError("The Chat could not be opened. Try again.");
    });
  };
  const projectChatMoveRefresh = useUi(state => state.projectChatMoveRefreshRequest);
  const projectChatMoveError = useUi(state => state.projectChatMoveError);
  const [readPending, setReadPending] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [botRefreshKey, setBotRefreshKey] = useState(0);
  const navigation=useWorkNavigation(client,eventSource,active);
  const records=navigation.items;
  const authorityEpoch = navigation.store?.getAuthorityEpoch() ?? 0;
  // After revocation, only a successful navigation read may re-enable Agent data.
  // A later transport failure retains that same epoch's verified snapshot.
  const authorityReady = Boolean(navigation.store && (authorityEpoch === 0 || navigation.fresh || navigation.updatedAt > 0));
  const authorityKey = projectMoveAuthorityKey();
  const authorityCurrent = useCallback(() => authorityReady && projectMoveAuthorityKey() === authorityKey
    && navigation.store?.getAuthorityEpoch() === authorityEpoch, [navigation.store, authorityEpoch, authorityReady, authorityKey]);
  const agentAuthority = useMemo(() => ({
    store: navigation.store, epoch: authorityEpoch,
    client: authorityReady && client?.agents ? { ...client.agents } : undefined,
  }), [navigation.store, authorityEpoch, authorityReady, client]);
  const committedCohort = navigation.status === "ready" || records.length > 0;
  const lastRenderedCohort = useRef<{ items: typeof records; fresh: boolean } | null>(null);
  useEffect(() => {
    if (!active || !committedCohort) return;
    if (lastRenderedCohort.current?.items === records && lastRenderedCohort.current.fresh === navigation.fresh) return;
    lastRenderedCohort.current = { items: records, fresh: navigation.fresh };
    markChatNavigation("render-ready", records.length);
  }, [active, committedCohort, records, navigation.fresh]);
  const setRecords=useCallback((action:ChatNavigationRecord[]|((records:ChatNavigationRecord[])=>ChatNavigationRecord[]))=>{
    if (!authorityCurrent()) return;
    navigation.store?.update(current=>{
      if (!authorityCurrent()) return current;
      const updated=typeof action==='function'?action(current):action;
      if(updated===current) return current;
      return updated.flatMap(record=>{
        const known=current.find(item=>item.chat.id===record.chat.id);
        return known?[mergeChatNavigationRecord(known,record)]:[];
      });
    });
  },[navigation.store,authorityCurrent]);
  const status=navigation.status;
  const { sections, setExpanded } = useWorkRailDisclosure();
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [pinning, setPinning] = useState<Record<string, boolean>>({});
  const [pinError, setPinError] = useState<string | null>(null);
  const [deleteChatTarget, setDeleteChatTarget] = useState<ChatNavigationRecord | null>(null);
  const [deletingChat, setDeletingChat] = useState(false);
  const [deleteChatError, setDeleteChatError] = useState<string | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => { if (authorityCurrent()) setSearchOpen(true); }, [authorityCurrent]);
  useChatSearchShortcut(searchShortcutActive && Boolean(client), openSearch);
  const [sharedWithMeOpen, setSharedWithMeOpen] = useState(false);
  const [sharedProjectRevealRequest, setSharedProjectRevealRequest] = useState<{
    scopeId: string;
    requestId: number;
  }>();
  const routeScope = `${active ? "active" : "inactive"}\0${activeChatId ?? ""}\0${activeProjectSlug ?? ""}`;
  const routeScopeRef = useRef({ client, store: navigation.store, key: routeScope, generation: 0, isCurrent: authorityCurrent });
  if (routeScopeRef.current.key !== routeScope || routeScopeRef.current.client !== client
    || routeScopeRef.current.isCurrent !== authorityCurrent) {
    routeScopeRef.current = {
      client,
      store: navigation.store,
      key: routeScope,
      generation: routeScopeRef.current.generation + 1,
      isCurrent: authorityCurrent,
    };
  }
  const isCurrentAuthority = (scope: typeof routeScopeRef.current) => scope.isCurrent()
    && routeScopeRef.current.client === scope.client && routeScopeRef.current.store === scope.store;
  const isCurrentScope = (scope: typeof routeScopeRef.current) => isCurrentAuthority(scope)
    && routeScopeRef.current.generation === scope.generation;
  const [actionAuthority, setActionAuthority] = useState({ store: navigation.store, epoch: authorityEpoch });
  if (actionAuthority.store !== navigation.store || actionAuthority.epoch !== authorityEpoch) {
    setActionAuthority({ store: navigation.store, epoch: authorityEpoch });
    setPinError(null); setPinning({}); setReadPending(false); setReadError(null);
    setDeleteChatTarget(null); setDeletingChat(false); setDeleteChatError(null);
    setRenamingChatId(null); setRenamePending(false); setRenameError(null); setSelectionError(null);
    setSearchOpen(false);
  }
  useEffect(()=>{
    setPinError(null);setPinning({});setReadPending(false);setReadError(null);
    setDeleteChatTarget(null);setDeletingChat(false);setDeleteChatError(null);
    setRenamingChatId(null);setRenamePending(false);setRenameError(null);setSelectionError(null);
  },[routeScope,client]);
  const recordIds = useMemo(() => records.map(record => record.chat.id), [records]);
  const classifications=useMemo(()=>records.map(record=>({chatId:record.chat.id,classification:record.classification})),[records]);
  useEffect(() => {
    if (!navigation.store) return;
    return navigation.store.subscribe(() => {
      if (navigation.store?.getAuthorityEpoch() !== authorityEpoch
        && (agentsNavigation?.opened?.client === client?.agents || agentsNavigation?.detailsRequest?.client === client?.agents)) {
        agentsNavigation?.close();
      }
    });
  }, [navigation.store, authorityEpoch, agentsNavigation, client]);
  const botSummaries = useBotConversationSummaries(agentAuthority.client, recordIds, active, botRefreshKey,classifications);
  const ordinaryRecords = useMemo(() => records.filter(record => record.classification.kind==="ordinary"), [records]);
  const order = useWorkRailOrder(ordinaryRecords, projects);
  const model = useMemo(() => buildWorkRailModel(order.chats, order.projects), [order.chats, order.projects]);
  const projectGroups = useMemo(
    () => [...model.pinnedProjects, ...model.projects],
    [model],
  );
  const discoveredSharedProjects = useSharedProjects();
  const sharedProjects = useMemo(
    () => partitionSharedProjects(
      discoveredSharedProjects,
      new Set(projects.flatMap((project) => project.id ? [project.id] : [])),
    ),
    [discoveredSharedProjects, projects],
  );
  const projectSharing = useDesktopProjectSharingContext(active);
  const [shareProjectTarget, setShareProjectTarget] = useState<{
    project: Project;
    organizationId: string;
    requestId: string;
  } | null>(null);

  useEffect(() => {
    if (!active || !client) setSearchOpen(false);
    if (!active) setSharedWithMeOpen(false);
    if (!active) setShareProjectTarget(null);
  }, [active, client]);

  useEffect(() => {
    if (shareProjectTarget
      && shareProjectTarget.organizationId !== projectSharing?.organizationId) {
      setShareProjectTarget(null);
    }
  }, [projectSharing?.organizationId, shareProjectTarget]);

  useEffect(()=>{
    const subscription=eventSource?.subscribe(event=>{
      if(event.type==="chat.changed" && event.eventType!=="run.message") {
        setBotRefreshKey(key=>key+1);
        if(["chat.created","chat.updated","chat.deleted"].includes(event.eventType)) notifyCollaborationDiscoveryChanged();
      }
    });
    return()=>subscription?.dispose();
  },[eventSource]);
  const moveRefreshRef=useRef(projectChatMoveRefresh);
  useEffect(()=>{
    if(moveRefreshRef.current!==projectChatMoveRefresh){moveRefreshRef.current=projectChatMoveRefresh;void navigation.store?.refresh();}
  },[projectChatMoveRefresh,navigation.store]);

  useEffect(() => {
    if (!projectedChatTitles?.length) return;
    setRecords((current) => applyProjectedChats(current, projectedChatTitles));
  }, [projectedChatTitles, setRecords]);

  const toggleRead = async (record: ChatNavigationRecord) => {
    if (!client || readPending || !isCurrentScope(routeScopeRef.current)) return;
    const scope = routeScopeRef.current;
    setReadPending(true);
    setReadError(null);
    try {
      const updated = await client.updateReadState(record.chat.id, chatReadAction(record));
      if (isCurrentAuthority(scope)) {
        setRecords((current) => current.map((item) => mergeChatReadState(item, updated)));
      }
    } catch (error: unknown) {
      console.warn("[chat] Read state update failed:", error instanceof Error ? error.name : "UnknownError");
      if (isCurrentScope(scope)) setReadError("The Chat could not be updated. Try again.");
    } finally {
      if (isCurrentScope(scope)) setReadPending(false);
    }
  };

  const toggleSection = (key: SectionKey) => {
    setExpanded(key, !sections[key]);
  };
  const revealSharedProject = (scopeId: string) => {
    setExpanded("projects", true);
    setSharedProjectRevealRequest((current) => ({
      scopeId,
      requestId: (current?.requestId ?? 0) + 1,
    }));
  };

  const updatePinned = (record: ChatNavigationRecord) => {
    if (!client || pinning[record.chat.id] || !isCurrentScope(routeScopeRef.current)) return;
    const pinned = !record.chat.userState?.pinned;
    const scope = routeScopeRef.current;
    setPinError(null);
    setPinning((current) => ({ ...current, [record.chat.id]: true }));
    void client.updateUserState(record.chat.id, { pinned }).then((updated) => {
      if (!isCurrentAuthority(scope)) return;
      setRecords((current) => current.map((candidate) => (
        candidate.chat.id === updated.chat.id ? mergeChatNavigationRecord(candidate, updated) : candidate
      )));
    }).catch((error: unknown) => {
      console.warn(
        "[work] Chat pin update failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      if (isCurrentScope(scope)) {
        setPinError("Chat pin could not be updated.");
      }
    }).finally(() => {
      if (!isCurrentScope(scope)) return;
      setPinning((current) => {
        const next = { ...current };
        delete next[record.chat.id];
        return next;
      });
    });
  };

  const deleteChat = async () => {
    if (!client || !deleteChatTarget || deletingChat || !isCurrentScope(routeScopeRef.current)) return;
    const target = deleteChatTarget;
    const scope = routeScopeRef.current;
    const targetProject = projectGroups.find((group) => (
      group.id === target.projectId || group.slug === target.projectId
    ))?.project;
    setDeletingChat(true);
    setDeleteChatError(null);
    try {
      await client.delete(target.chat.id, canonicalChatRequestId());
      if (!isCurrentAuthority(scope)) return;
      setRecords((current) => current.filter((record) => record.chat.id !== target.chat.id));
      if (isCurrentScope(scope)) {
        setDeleteChatTarget(null);
        onChatDeleted?.(target, targetProject);
      }
    } catch (error: unknown) {
      console.warn(
        "[work] Chat deletion failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      if (isCurrentScope(scope)) {
        setDeleteChatError("The Chat could not be deleted. Try again.");
      }
    } finally {
      if (isCurrentScope(scope)) {
        setDeletingChat(false);
      }
    }
  };

  const renameChat = async (record: ChatNavigationRecord, title: string) => {
    if (!client || renamePending || !isCurrentScope(routeScopeRef.current)) return;
    const scope = routeScopeRef.current;
    const targetProject = projectGroups.find((group) => (
      group.id === record.projectId || group.slug === record.projectId
    ))?.project;
    setRenamePending(true);
    setRenameError(null);
    try {
      const updated = await client.updateTitle(record.chat.id, {
        expectedTitleVersion: record.chat.titleVersion ?? 0,
        title,
      });
      if (!isCurrentAuthority(scope)) return;
      setRecords((current) => current.map((candidate) => (
        candidate.chat.id === updated.chat.id ? mergeChatNavigationRecord(candidate, updated) : candidate
      )));
      if (isCurrentScope(scope)) {
        setRenamingChatId(null);
        onChatRenamed?.(updated, targetProject);
      }
    } catch (error: unknown) {
      console.warn("[work] Chat rename failed:", error instanceof Error ? error.name : "UnknownError");
      if (isCurrentScope(scope)) {
        setRenameError("The Chat could not be renamed. Try again.");
        // Refresh the title version for an explicit retry while keeping the draft.
        try {
          const latest = await client.getDetail(record.chat.id, { limit: 1 });
          if (isCurrentAuthority(scope)) {
            setRecords((current) => current.map((candidate) => candidate.chat.id === record.chat.id
              ? mergeChatNavigationRecord(candidate, latest.record) : candidate));
          }
        } catch (refreshError: unknown) {
          console.warn("[work] Rename refresh failed:", refreshError instanceof Error ? refreshError.name : "UnknownError");
        }
      }
    } finally {
      if (isCurrentScope(scope)) setRenamePending(false);
    }
  };

  const { moveItems, movingChatId, error: moveError } = useWorkRailMoves({client,projects,routeScopeRef,setRecords,setExpandedProjects,onChatMoved});

  const renderProjectGroup = (group: (typeof projectGroups)[number]) => {
    const expanded = Boolean(expandedProjects[group.id]);
    return (
      <WorkRailOrderItem key={group.id} id={group.id} kind="project" group={group.project.pinned ? "pinned-projects" : "projects"}><WorkRailProjectGroup
        group={group}
        fresh={navigation.fresh}
        shared={sharedProjects.ownedSharedProjectIds.has(group.id)}
        moveItems={moveItems}
        movingChatId={movingChatId}
        expanded={expanded}
        activeProjectSlug={activeProjectSlug}
        activeChatId={activeChatId}
        pinning={pinning}
        renamingChatId={renamingChatId}
        renamePending={renamePending}
        onToggleRead={(record) => { void toggleRead(record); }}
        readPending={readPending}
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
        onSelect={onSelectProject}
        onNewChat={onNewProjectChat}
        onDeleteProject={setDeleteProjectTarget}
        onSelectChat={onSelectChat}
        onPinChat={updatePinned}
        onDeleteChat={(record) => {
          setDeleteChatError(null);
          setDeleteChatTarget(record);
        }}
        sharing={projectSharing}
        onShareProject={(project) => {
          if (!projectSharing?.organizationId) return;
          setShareProjectTarget({
            project,
            organizationId: projectSharing.organizationId,
            requestId: crypto.randomUUID(),
          });
        }}
      /></WorkRailOrderItem>
    );
  };

  const renderChatRow = (record: ChatNavigationRecord, placement: "pinned" | "recent") => <WorkRailOrderItem key={record.chat.id} id={record.chat.id} kind="chat" group={placement === "pinned" ? "pinned-chats" : resolveCanonicalChatLifecycleGroup(record) === "recent" ? "done" : resolveCanonicalChatLifecycleGroup(record)}><WorkRailChatRow fresh={navigation.fresh} record={record} moveItems={moveItems(record)} moving={movingChatId === record.chat.id} placement={placement} active={record.chat.id === activeChatId}
    pinning={Boolean(pinning[record.chat.id])} renaming={renamingChatId === record.chat.id}
    renamePending={renamePending && renamingChatId === record.chat.id} renameDisabled={renamePending}
    onToggleRead={() => { void toggleRead(record); }} readPending={readPending}
    onRenameStart={() => { if (renamePending) return; setRenameError(null); setRenamingChatId(record.chat.id); }}
    onRenameCommit={(title) => { void renameChat(record, title); }} onRenameCancel={() => setRenamingChatId(null)}
    onSelect={() => { const project = projectGroups.find(group => group.id === record.projectId || group.slug === record.projectId)?.project; if (project) onSelectChat(record, project); else onSelectChat(record); }}
    onPin={() => updatePinned(record)} onDelete={() => { setDeleteChatError(null); setDeleteChatTarget(record); }} /></WorkRailOrderItem>;

  return (
    <WorkRailOrderContext.Provider value={{manual:true,move:order.move,scopeKey:order.scopeKey}}><nav
      aria-label="Chat navigation"
      aria-busy={records.length>0 && !navigation.fresh}
      data-navigation-fresh={navigation.fresh || undefined}
      className={`matrix-chat-work-rail flex min-h-0 shrink-0 flex-col gap-0.5 overflow-hidden border-r pb-2 pt-3 ${className}`}
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
    >
      <WorkRailHeader
        shortcutAvailable={newChatShortcutActive}
        onNewChat={onNewGlobalChat}
        onCollapse={onCollapse}
        showCollapseControl={showCollapseControl}
      />
      <div className="ml-2.5 mr-[9px] flex shrink-0 flex-col"><WorkRailSearchControls onSearch={openSearch} active={searchOpen} /></div>
      <WorkRailScrollArea>
      <SharedWithMeRailRow onOpen={() => setSharedWithMeOpen(true)} />
      <ChatAgentsRailSection menuZIndex={DESKTOP_Z_INDEX.popover} expanded={sections.agents} onExpandedChange={(expanded) => setExpanded("agents", expanded)} activeAgentId={agentsNavigation?.opened ? null : botSummaries.conversations.find(bot => bot.chatId === activeChatId)?.agentId ?? null} visible={visible} activeChatId={activeChatId} client={authorityReady ? client?.agents : undefined} summaryClient={agentAuthority.client} isCurrent={authorityCurrent} onOpen={onOpenAgents} onStartChat={onStartAgentChat} onOpenBotChat={onOpenBotChat} onSetup={() => { useUi.getState().requestSettingsSection("agents-providers"); useTabs.getState().openTab({ kind: "settings", title: "Settings" }); }} />
      <WorkRailGroups model={model} activeChatId={activeChatId} sections={sections} onToggle={toggleSection} onCreateProject={onCreateProject}
        renderProject={renderProjectGroup} renderChat={renderChatRow} bots={botSummaries.conversations}
        sharedProjects={sharedProjects.receivedProjects}
        onOpenBotChat={onOpenBotChat ? (chatId) => { if (!authorityCurrent()) return; agentsNavigation?.close(); onOpenBotChat(chatId); } : undefined}
        revealSharedProjectRequest={sharedProjectRevealRequest}
        organizationDrives={<OrganizationDrivesRail active={active} chats={ordinaryRecords} client={client?.agents} onNewChat={onStartAgentChat} onSelectChat={onSelectChat} activeChatId={activeChatId} />} />
        {status === "loading" && records.length === 0 ? (
          <p role="status" className="px-2 py-3 text-xs" style={{ color: "var(--text-tertiary)" }}>Loading chats…</p>
        ) : null}
        {status === "error" ? (
          <div className="px-2 py-3 text-xs" style={{ color: "var(--text-tertiary)" }}>
            <p role="alert">{navigation.error === "Chats could not be loaded. Try again." ? "Chats could not be loaded." : navigation.error ?? "Chats could not be loaded."}</p>
            {navigation.error === "Chats could not be loaded. Try again." ? <button type="button" aria-label="Retry loading chats" className="mt-1 underline outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" onClick={() => { void navigation.store?.refresh(); }}>Retry</button> : null}
          </div>
        ) : null}
        {botSummaries.error ? <p role="alert" className="px-2 py-3 text-xs">{botSummaries.error}</p> : null}
        {pinError ? (
          <p role="alert" className="px-2 py-3 text-xs" style={{ color: "var(--text-tertiary)" }}>{pinError}</p>
        ) : null}
        {moveError || projectChatMoveError ? <p role="alert" className="px-3 text-xs">{moveError ?? projectChatMoveError}</p> : null}
        {selectionError ? <p role="alert" className="px-3 text-xs">{selectionError}</p> : null}
        {readError ? <p role="alert" className="px-3 text-xs">{readError}</p> : null}
        {renameError ? (
          <p role="alert" className="px-2 py-3 text-xs" style={{ color: "var(--danger)" }}>{renameError}</p>
        ) : null}
      </WorkRailScrollArea>
      <DeleteConversationDialog
        conversation={authorityReady && deleteChatTarget ? {
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
        open={authorityReady && searchOpen}
        records={ordinaryRecords}
        projects={projects}
        status={status}
        onSelectProject={(project) => { setSearchOpen(false); onSelectProject(project); }}
        onClose={() => setSearchOpen(false)}
        onOpenShared={() => setSharedWithMeOpen(true)}
        onSelect={(record, project) => {
          setSearchOpen(false);
          if (project) onSelectChat(record, project);
          else onSelectChat(record);
        }}
      />
      <DesktopSharedWithMeDialog open={sharedWithMeOpen} onClose={() => setSharedWithMeOpen(false)}
        onOpenProject={revealSharedProject} />
      {shareProjectTarget
        && projectSharing?.organizationId === shareProjectTarget.organizationId
        && shareProjectTarget.project.id ? (
        <DesktopProjectSharingHost
          key={shareProjectTarget.requestId}
          sharing={projectSharing}
          projectId={shareProjectTarget.project.id}
          projectName={shareProjectTarget.project.name || shareProjectTarget.project.slug}
          startOnMount
          onClose={() => setShareProjectTarget(null)}
        />
      ) : null}
    </nav></WorkRailOrderContext.Provider>
  );
}
