import { Maximize2, MessageSquare, Minimize2, PanelRightOpen, Server, X } from "@renderer/lib/hugeicons";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator, type Layout as SplitLayout } from "react-resizable-panels";
import { defaultAgentThreadComposerDraft, type CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { codingAgentRuntimeScope } from "../../../../shared/coding-agent-project-workspace";
import { Button, EmptyState } from "../../design/primitives";
import { useProjectChatLauncher } from "../../lib/project-chat";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useConnection } from "../../stores/connection";
import { useProjectView } from "../../stores/project-view";
import { useProjectWorkspaces } from "../../stores/project-workspaces";
import { useHermesChat } from "../../stores/hermes-chat";
import {
  DEFAULT_INSPECTOR_WIDTH_PCT,
  MAX_INSPECTOR_WIDTH_PCT,
  MIN_INSPECTOR_WIDTH_PCT,
  useInspectorLayout,
} from "../panels/inspector-layout-store";
import { AgentConversationView } from "../coding-agents/AgentConversationView";
import {
  AgentConversationInspector,
  type AgentConversationInspectorTab,
} from "../coding-agents/AgentConversationInspector";
import { InspectorFilesPanel } from "../panels/InspectorFilesPanel";
import { InspectorPreviewPanel } from "../panels/InspectorPreviewPanel";
import { InspectorTerminalPanel } from "../panels/InspectorTerminalPanel";
import { toast } from "sonner";
import { AgentComposer } from "../coding-agents/AgentComposer";
import type { ComposerSeed } from "../coding-agents/composer-seed";
import {
  AttentionThreadList,
  InspectorEmptyState,
} from "../coding-agents/AgentWorkspacePanels";
import { capabilityEnabled } from "../coding-agents/capabilities";
import { isTypeToStartInteractiveTarget } from "../coding-agents/type-to-start";
import { CreatedThreadHandleList, ThreadList } from "../coding-agents/AgentThreadLists";
import { ReviewList, reviewHunkFollowUpDraft } from "../coding-agents/AgentReviewPanel";
import { loadCodingAgentConversation, openCodingAgentThread } from "../../lib/project-chat";
import { ProjectChatDraft } from "./ProjectChatDraft";
import { buildProjectInspectorContext } from "./project-inspector-context";
import { ProjectThreadList } from "./ProjectThreadList";
import { ChatUnavailableState, HermesPane } from "../chat/ChatTab";
import { CanonicalChatRoute } from "../chat/CanonicalChatRoute";
import { useBoard } from "../../stores/board";

export { mergeAttachments, mergeComposerSeed, clearComposerLaunchContext } from "../coding-agents/composer-seed";

const TYPE_TO_START_MAX_PROMPT_BYTES = 24_000;
/**
 * The project's Chats view: thread list on the left, the selected
 * conversation in the middle, and the shared conversation inspector on the
 * right. The single coding-agent snapshot store follows the ACTIVE project
 * tab's selection, so only the visible Chats view binds a conversation —
 * background project tabs keep their selection but never fight over the
 * shared snapshot.
 */
function LegacyProjectChatsView({ projectId, active }: { projectId: string; active: boolean }) {
  const status = useCodingAgentWorkspace((s) => s.status);
  const summary = useCodingAgentWorkspace((s) => s.summary);
  const error = useCodingAgentWorkspace((s) => s.error);
  const refreshRuntimeSummary = useCodingAgentWorkspace((s) => s.refresh);
  const activeThreadId = useCodingAgentWorkspace((s) => s.activeThreadId);
  const threadSnapshotStatus = useCodingAgentWorkspace((s) => s.threadSnapshotStatus);
  const threadSnapshot = useCodingAgentWorkspace((s) => s.threadSnapshot);
  const threadSnapshotError = useCodingAgentWorkspace((s) => s.threadSnapshotError);
  const reviews = useCodingAgentWorkspace((s) => s.reviews);
  const reviewFocusRequestId = useCodingAgentWorkspace((s) => s.reviewFocusRequestId);
  const reviewFocusConsumedId = useCodingAgentWorkspace((s) => s.reviewFocusConsumedId);
  const consumeReviewFocusRequest = useCodingAgentWorkspace((s) => s.consumeReviewFocusRequest);
  const requestComposerFocus = useCodingAgentWorkspace((s) => s.requestComposerFocus);
  const composerFocusRequestId = useCodingAgentWorkspace((s) => s.composerFocusRequestId);
  const createdThreadHandles = useCodingAgentWorkspace((s) => s.createdThreadHandles);
  const workspaceEntry = useProjectWorkspaces((s) => s.entries[projectId]);
  const ensureWorkspace = useProjectWorkspaces((s) => s.ensure);
  const refreshWorkspace = useProjectWorkspaces((s) => s.refresh);
  const loadMoreWorkspace = useProjectWorkspaces((s) => s.loadMore);
  const resolveNewChatTarget = useProjectWorkspaces((s) => s.resolveNewChatTarget);
  const selectedThreadId = useProjectView((s) => s.entries[projectId]?.selectedThreadId ?? null);
  const setSelectedThread = useProjectView((s) => s.setSelectedThread);
  const composerRequest = useProjectChatLauncher((s) => s.composerRequest);
  const runtimeScope = useConnection(codingAgentRuntimeScope);
  const api = useConnection((state) => state.api);
  const hermesConversations = useHermesChat((state) => state.conversations);
  const refreshHermesConversations = useHermesChat((state) => state.refreshConversations);
  const inspectorEntry = useInspectorLayout((s) => s.entries[projectId]);
  const inspectorHydrated = useInspectorLayout((s) => s.hydratedScope === runtimeScope);
  const narrowInspectorLayout = useNarrowInspectorLayout();
  const [composerSeed, setComposerSeed] = useState<ComposerSeed | null>(null);
  const [selectedHermesConversationId, setSelectedHermesConversationId] = useState<string | null>(() => {
    const chat = useHermesChat.getState();
    return chat.sessionId && chat.conversationContext?.projectId === projectId ? chat.sessionId : null;
  });
  const [inspectorTabOverride, setInspectorTabOverride] = useState<AgentConversationInspectorTab | null>(null);
  const newChatRequestIdRef = useRef(0);
  const draftReadinessRefreshedRef = useRef(false);
  const hermesRefreshScopeRef = useRef<string | null>(null);
  const projectHermesConversations = useMemo(() => hermesConversations.filter((conversation) => (
    conversation.context?.projectId === projectId
  )), [hermesConversations, projectId]);

  useEffect(() => {
    if (!active) {
      hermesRefreshScopeRef.current = null;
      return;
    }
    if (!api) return;
    const refreshScope = `${runtimeScope}:${projectId}`;
    if (hermesRefreshScopeRef.current === refreshScope) return;
    hermesRefreshScopeRef.current = refreshScope;
    void refreshHermesConversations(api);
  }, [active, api, projectId, refreshHermesConversations, runtimeScope]);

  // Runtime-scope reconciliation + self-sufficiency bootstrap: the first
  // mounted view claims the scope (clearing the previous account's data),
  // then loads the summary when nothing has. ProjectTab and MissionControl
  // run the same guarded check, so only one refresh fires per scope.
  useEffect(() => {
    const workspace = useCodingAgentWorkspace.getState();
    workspace.ensureRuntimeScope(runtimeScope);
    void useInspectorLayout.getState().hydrate(runtimeScope);
    const current = useCodingAgentWorkspace.getState();
    if (current.status !== "idle" || current.summary) return;
    void current.refresh().then(() => {
      const after = useCodingAgentWorkspace.getState();
      if (after.notificationPreferencesStatus === "idle") {
        void after.loadNotificationPreferences();
      }
    });
  }, [runtimeScope]);

  const projectWorkspaceEnabled = summary
    ? capabilityEnabled(summary, "codingAgentsProjectWorkspace")
    : false;
  const capabilitiesLoaded = summary !== null;

  // Terminal-based provider setup changes readiness outside React. Refresh
  // once whenever the active project enters its New Chat surface so the
  // composer does not wait for unrelated navigation to discover login/logout.
  // This is transition-driven, not a polling loop; leaving the draft resets
  // the guard so the next deliberate New Chat entry checks again.
  useEffect(() => {
    if (!active || selectedThreadId !== null) {
      draftReadinessRefreshedRef.current = false;
      return;
    }
    if (
      !projectWorkspaceEnabled
      || workspaceEntry?.status !== "ready"
      || draftReadinessRefreshedRef.current
    ) return;
    draftReadinessRefreshedRef.current = true;
    void refreshRuntimeSummary();
  }, [active, projectWorkspaceEnabled, refreshRuntimeSummary, selectedThreadId, workspaceEntry?.status]);

  useEffect(() => {
    if (!projectWorkspaceEnabled) return;
    // Claim the scope before loading: on an account or computer change this
    // drops the previous owner's cached projections, which would otherwise
    // survive and render under a colliding project slug.
    useProjectWorkspaces.getState().ensureRuntimeScope(runtimeScope);
    void ensureWorkspace(projectId);
  }, [ensureWorkspace, projectId, projectWorkspaceEnabled, runtimeScope]);

  const inspectorCollapsed = inspectorEntry?.collapsed ?? true;
  const inspectorMaximized = inspectorEntry?.maximized ?? false;
  const inspectorWidthPct = inspectorEntry?.widthPct ?? DEFAULT_INSPECTOR_WIDTH_PCT;

  // Review focus can originate outside the inspector (for example, from a
  // notification). Expand first so the inspector mounts and can select and
  // consume the requested Changes focus.
  useEffect(() => {
    if (
      !active
      || !inspectorHydrated
      || !inspectorCollapsed
      || reviewFocusRequestId <= reviewFocusConsumedId
    ) return;
    useInspectorLayout.getState().setCollapsed(projectId, false);
  }, [
    active,
    inspectorCollapsed,
    inspectorHydrated,
    projectId,
    reviewFocusConsumedId,
    reviewFocusRequestId,
  ]);

  // The shared snapshot store follows the ACTIVE project tab's selection.
  // Background tabs keep their per-project selection in the view store but
  // never bind the snapshot, so two open project chats cannot fight over it.
  // When the runtime evicts a previously bound conversation (a refresh says
  // the thread is gone) and the project workspace doesn't list it either, the
  // selection is dropped instead of resurrecting a vanished conversation.
  const boundThreadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !selectedThreadId || selectedHermesConversationId) return;
    const workspace = useCodingAgentWorkspace.getState();
    if (workspace.activeThreadId === selectedThreadId) {
      if (workspace.threadSnapshot?.thread.id === selectedThreadId) {
        boundThreadRef.current = selectedThreadId;
      } else if (workspace.threadSnapshotStatus !== "loading") {
        // The active id can outlive its snapshot when Chats unmounts during a
        // Board round-trip. Rebind it instead of leaving the conversation on
        // a permanent loading state.
        void workspace.loadThreadSnapshot(selectedThreadId);
      }
      return;
    }
    const listedInWorkspace = (() => {
      const entry = useProjectWorkspaces.getState().entries[projectId]?.workspace;
      if (!entry) return false;
      return [...entry.projectThreads.items, ...entry.taskThreads.items]
        .some((thread) => thread.id === selectedThreadId);
    })();
    if (
      boundThreadRef.current === selectedThreadId
      && workspace.activeThreadId === null
      && !listedInWorkspace
    ) {
      boundThreadRef.current = null;
      setSelectedThread(projectId, null);
      return;
    }
    void workspace.loadThreadSnapshot(selectedThreadId);
  }, [active, selectedThreadId, selectedHermesConversationId, activeThreadId, threadSnapshot?.thread.id, projectId, setSelectedThread]);

  // Starting a new chat DESELECTS the current thread: the draft conversation
  // (hero + the same floating composer threads use) replaces it in place,
  // Codex-style, and sending the draft creates the thread implicitly.
  const openNewChat = useCallback(async (
    taskId?: string,
    initialPrompt?: string | (() => string),
    cancelled: () => boolean = () => false,
    onReady: () => void = () => undefined,
  ): Promise<boolean> => {
    if (!summary) return false;
    setSelectedHermesConversationId(null);
    const requestId = ++newChatRequestIdRef.current;
    const relation = await resolveNewChatTarget(projectId, taskId);
    if (cancelled()) return false;
    // Resolving a project relation can require a workspace refresh. Only the
    // latest intent may continue: a newer New chat action or an explicit rail
    // selection invalidates this delayed result without mistaking the rail's
    // initial auto-selection for user navigation.
    if (newChatRequestIdRef.current !== requestId) return false;
    onReady();
    if (!relation) {
      toast.error("Couldn't start a new chat here. Refresh the workspace and try again.");
      return false;
    }
    const resolvedInitialPrompt = typeof initialPrompt === "function"
      ? initialPrompt()
      : initialPrompt;
    setComposerSeed({
      seedId: Date.now(),
      draft: {
        ...defaultAgentThreadComposerDraft(summary),
        ...relation,
        ...(resolvedInitialPrompt ? { prompt: resolvedInitialPrompt } : {}),
      },
    });
    setSelectedThread(projectId, null);
    requestComposerFocus();
    return true;
  }, [projectId, requestComposerFocus, resolveNewChatTarget, setSelectedThread, summary]);
  const openNewChatForTypeToStart = useEffectEvent(openNewChat);

  // Type-to-start is computed before the early returns so the keydown effect
  // stays hook-order safe; `canCreate` below is derived after them.
  const typeToStartEnabled = summary
    ? capabilityEnabled(summary, "codingAgentsThreadCreate") && projectWorkspaceEnabled
    : false;
  const typeToStartPromptByteLimit = Math.min(
    summary?.limits.maxPromptBytes ?? TYPE_TO_START_MAX_PROMPT_BYTES,
    TYPE_TO_START_MAX_PROMPT_BYTES,
  );
  const typeToStartInFlightRef = useRef(false);
  const typeToStartBufferRef = useRef("");
  // While a thread is selected, typing anywhere outside an editable element
  // opens the draft in its place. Buffer the complete phrase while project
  // resolution is pending; once the draft is showing, ProjectChatDraft owns
  // subsequent keystrokes.
  useEffect(() => {
    if (!active || !selectedThreadId || !typeToStartEnabled) return;
    typeToStartInFlightRef.current = false;
    typeToStartBufferRef.current = "";
    let cancelled = false;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.key.length !== 1) return;
      if (isTypeToStartInteractiveTarget(event.target)) return;
      const nextBuffer = `${typeToStartBufferRef.current}${event.key}`;
      if (new TextEncoder().encode(nextBuffer).byteLength > typeToStartPromptByteLimit) return;
      event.preventDefault();
      typeToStartBufferRef.current = nextBuffer;
      if (typeToStartInFlightRef.current) return;
      typeToStartInFlightRef.current = true;
      void openNewChatForTypeToStart(
        undefined,
        () => typeToStartBufferRef.current,
        () => cancelled,
      ).then((started) => {
        if (cancelled) return;
        typeToStartBufferRef.current = "";
        if (!started) typeToStartInFlightRef.current = false;
      });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelled = true;
      typeToStartBufferRef.current = "";
      typeToStartInFlightRef.current = false;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [active, selectedThreadId, typeToStartEnabled, typeToStartPromptByteLimit]);

  useEffect(() => {
    if (!active || !composerRequest || composerRequest.projectId !== projectId) return;
    // A missing summary means capabilities are unresolved, not disabled. Keep
    // the one-shot request pending until the runtime answers so type-to-start
    // cannot disappear during startup.
    if (!capabilitiesLoaded) return;
    if (!projectWorkspaceEnabled) {
      // Without project pages the composer is always visible; just focus it.
      useProjectChatLauncher.getState().consumeComposer(projectId);
      requestComposerFocus();
      return;
    }
    let cancelled = false;
    void openNewChat(
      undefined,
      undefined,
      () => cancelled,
      () => useProjectChatLauncher.getState().consumeComposer(projectId),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, capabilitiesLoaded, composerRequest, projectId, projectWorkspaceEnabled]);

  if (status === "loading" && !summary) {
    return (
      <EmptyState
        icon={<Server size={28} />}
        headline="Loading workspace..."
        description="Fetching runtime state from your Matrix computer."
      />
    );
  }

  if (status === "error" && !summary) {
    return (
      <EmptyState
        icon={<Server size={28} />}
        headline={error ?? "Runtime summary unavailable"}
        description="Refresh the workspace or check your selected runtime."
        action={<Button onClick={() => void refreshRuntimeSummary()}>Retry</Button>}
      />
    );
  }

  if (!summary) {
    return (
      <EmptyState
        icon={<Server size={28} />}
        headline="Loading workspace..."
        description="Fetching runtime state from your Matrix computer."
      />
    );
  }

  const canCreate = capabilityEnabled(summary, "codingAgentsThreadCreate");
  const project = summary.projects.items.find((candidate) => candidate.id === projectId);
  const projectLabel = project?.label ?? workspaceEntry?.workspace?.project.label ?? projectId;
  const workspace = workspaceEntry?.workspace ?? null;
  const canSendTurns = capabilityEnabled(summary, "codingAgentsSameThreadTurns");
  const reviewEnabled = capabilityEnabled(summary, "codingAgentsReview");
  const previewEnabled = capabilityEnabled(summary, "codingAgentsPreview");
  const snapshotMatches = selectedThreadId !== null
    && threadSnapshot?.thread.id === selectedThreadId
    && activeThreadId === selectedThreadId;
  const selectedThreadContext = snapshotMatches ? threadSnapshot.thread : null;
  const inspectorContext = buildProjectInspectorContext({
    projectId,
    summary,
    selectedThread: selectedThreadContext,
    reviews: reviews?.items ?? [],
  });

  // Selecting a thread is navigation only. Recents is promoted by successful
  // message sends, never by opening or re-opening a conversation.
  const openListedThread = async (
    threadId: string,
    threadProjectId?: string,
  ): Promise<void> => {
    newChatRequestIdRef.current += 1;
    setSelectedHermesConversationId(null);
    setComposerSeed(null);
    if (threadProjectId && threadProjectId !== projectId) {
      await openCodingAgentThread(threadId);
      return;
    }
    setSelectedThread(projectId, threadId);
    await loadCodingAgentConversation(projectId, threadId);
  };

  const openHermesConversation = async (conversationId: string): Promise<void> => {
    if (!api) return;
    newChatRequestIdRef.current += 1;
    setComposerSeed(null);
    setSelectedThread(projectId, null);
    setSelectedHermesConversationId(conversationId);
    const opened = await useHermesChat.getState().openConversation(api, conversationId);
    if (!opened) setSelectedHermesConversationId(null);
  };

  // Slice 2 hero layout: the conversation and the tools inspector sit in a
  // resizable split; collapsing the inspector yields a full-width hero
  // transcript. Width and collapsed state persist per project. While the
  // draft pane is showing (no thread selected on a project-workspace
  // runtime) the inspector is not rendered at all — the hero gets the full
  // width. Legacy runtimes keep the inspector because their new-chat
  // composer lives inside it.
  const inspectorRegionId = `project-${projectId}-inspector`;
  const draftVisible = selectedThreadId === null && projectWorkspaceEnabled;

  // The inspector tab is controlled so live surfaces can gate on visibility:
  // the embedded terminal releases the single app-wide socket attachment
  // while another surface (or a background project tab) is showing.
  const inspectorDefaultTab: AgentConversationInspectorTab = inspectorContext.defaultTab;
  const inspectorTab = inspectorTabOverride && inspectorContext.tabs.includes(inspectorTabOverride)
    ? inspectorTabOverride
    : inspectorDefaultTab;

  const handleSplitLayout = (layout: SplitLayout) => {
    const pct = layout["inspector"];
    if (typeof pct !== "number" || !Number.isFinite(pct)) return;
    const store = useInspectorLayout.getState();
    if (Math.round(pct) === store.layoutFor(projectId).widthPct) return;
    store.setWidthPct(projectId, pct);
  };

  // A created chat must always surface: select it, drop the draft seed, and
  // refresh the rail. Shared by the draft pane (project workspace path) and
  // the legacy inspector composer (no project-workspace capability).
  const handleComposerCreated = (threadId: string) => {
    setSelectedThread(projectId, threadId);
    setComposerSeed(null);
    if (projectWorkspaceEnabled) void refreshWorkspace(projectId);
  };
  const handleLegacyComposerCreated = () => {
    const state = useCodingAgentWorkspace.getState();
    const threadId = state.activeThreadId;
    if (!threadId) return;
    handleComposerCreated(threadId);
  };

  const conversationColumn = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {selectedHermesConversationId ? (
        <HermesPane />
      ) : selectedThreadId ? (
        <AgentConversationView
          status={activeThreadId === selectedThreadId ? threadSnapshotStatus : "loading"}
          snapshot={snapshotMatches ? threadSnapshot : null}
          error={activeThreadId === selectedThreadId ? threadSnapshotError : null}
          canSendTurns={canSendTurns}
          summary={summary}
        />
      ) : projectWorkspaceEnabled ? (
        <ProjectChatDraft
          key={composerSeed?.seedId ?? "empty-draft"}
          summary={summary}
          projectId={projectId}
          projectLabel={projectLabel}
          active={active}
          seed={composerSeed}
          focusRequestId={composerFocusRequestId}
          typeToStartEnabled={typeToStartEnabled}
          onCreated={handleComposerCreated}
        />
      ) : (
        // Without the project-workspace capability the composer lives in the
        // inspector; the pane keeps the plain picker hint.
        <div className="relative flex min-h-0 flex-1 flex-col">
          <EmptyState
            icon={<MessageSquare size={28} />}
            headline="Select a chat"
            description="Pick a conversation from the list, or start a new chat for this project."
          />
        </div>
      )}
    </div>
  );

  const inspectorPanel = (
    <aside
      id={inspectorRegionId}
      aria-label="Conversation tools"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      style={{ background: "var(--bg-sunken)" }}
    >
      <AgentConversationInspector
        defaultTab={inspectorDefaultTab}
        tabs={inspectorContext.tabs}
        selectedTab={inspectorTab}
        onTabChange={setInspectorTabOverride}
        changesFocusRequestId={reviewFocusRequestId}
        changesFocusConsumedId={reviewFocusConsumedId}
        onChangesFocusConsumed={consumeReviewFocusRequest}
        counts={inspectorContext.counts}
        toolbar={(
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Conversation tools</h2>
              <p className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>Inspect the current project without leaving the chat</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {projectWorkspaceEnabled ? (
                <Button
                  variant="primary"
                  className="mr-1 h-7 shrink-0 whitespace-nowrap"
                  aria-label="New chat in selected project"
                  onClick={() => {
                    void openNewChat();
                  }}
                >
                  New chat
                </Button>
              ) : null}
              <InspectorHeaderButton
                label={inspectorMaximized ? "Restore conversation tools" : "Maximize conversation tools"}
                onClick={() => useInspectorLayout.getState().setMaximized(projectId, !inspectorMaximized)}
              >
                {inspectorMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </InspectorHeaderButton>
              <InspectorHeaderButton
                label="Close conversation tools"
                onClick={() => useInspectorLayout.getState().setCollapsed(projectId, true)}
              >
                <X size={14} />
              </InspectorHeaderButton>
            </div>
          </div>
        )}
        composer={
          // Without the project-workspace capability the form composer lives
          // here permanently; with it, the draft pane owns new-chat creation.
          !projectWorkspaceEnabled ? (
            <AgentComposer
              summary={summary}
              seed={composerSeed}
              focusRequestId={composerFocusRequestId}
              onCreated={handleLegacyComposerCreated}
            />
          ) : undefined
        }
        changes={reviewEnabled ? (
          <ReviewList
            projectId={projectId}
            items={inspectorContext.reviews}
            canReadFiles={capabilityEnabled(summary, "codingAgentsFiles")}
            canPrepareCommit={capabilityEnabled(summary, "codingAgentsSourceControl")}
            canCreateFollowUp={canCreate}
            onAskHunkFollowUp={(snapshot, selected) => {
              newChatRequestIdRef.current += 1;
              setComposerSeed({
                seedId: Date.now(),
                draft: reviewHunkFollowUpDraft(summary, snapshot, selected),
              });
              if (projectWorkspaceEnabled) {
                // The seeded follow-up opens in the draft pane, replacing the
                // selected thread; legacy runtimes keep it in the inspector form.
                setSelectedThread(projectId, null);
                requestComposerFocus();
              }
            }}
          />
        ) : (
          <InspectorEmptyState message="Change review is not available on this computer." />
        )}
        files={inspectorContext.tabs.includes("files") ? <InspectorFilesPanel scopeLabel="Matrix Home files" /> : undefined}
        terminal={(
          <InspectorTerminalPanel
            summary={inspectorContext.summary}
            active={inspectorTab === "terminal" && active && !inspectorCollapsed}
            emptyMessage={inspectorContext.terminalState === "unavailable"
              ? "The linked terminal session is no longer available."
              : "This chat has no linked terminal session."}
          />
        )}
        preview={previewEnabled ? (
          <InspectorPreviewPanel summary={inspectorContext.summary} />
        ) : (
          <InspectorEmptyState message="No preview capability is available for this project." />
        )}
        activity={(
          <div className="space-y-4">
            <AttentionThreadList
              summary={inspectorContext.summary}
              onOpenThread={(thread) => openListedThread(thread.id, thread.projectId)}
            />
            <ThreadList
              summary={inspectorContext.summary}
              onOpenThread={(thread) => openListedThread(thread.id, thread.projectId)}
            />
            <CreatedThreadHandleList
              summary={inspectorContext.summary}
              projectId={projectId}
              onOpenThread={(thread) => openListedThread(thread.id, thread.projectId)}
            />
          </div>
        )}
      />
    </aside>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <ProjectThreadList
        projectId={projectId}
        projectLabel={projectLabel}
        summary={summary}
        workspace={workspace}
        createdThreadHandles={createdThreadHandles}
        status={projectWorkspaceEnabled ? (workspaceEntry?.status ?? "idle") : "absent"}
        error={workspaceEntry?.error ?? null}
        selectedThreadId={selectedThreadId}
        hermesConversations={projectHermesConversations}
        selectedHermesConversationId={selectedHermesConversationId}
        canCreate={canCreate && projectWorkspaceEnabled}
        onSelectThread={(threadId) => openListedThread(threadId)}
        onSelectHermesConversation={(conversationId) => void openHermesConversation(conversationId)}
        onNewChat={(taskId) => void openNewChat(taskId)}
        onRetry={() => void refreshWorkspace(projectId)}
        onLoadMore={() => void loadMoreWorkspace(projectId)}
      />
      {draftVisible || selectedHermesConversationId ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {conversationColumn}
        </div>
      ) : !inspectorHydrated ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {conversationColumn}
        </div>
      ) : inspectorMaximized ? (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div data-testid="conversation-underlay" className="invisible flex min-h-0 min-w-0 flex-1 flex-col">
            {conversationColumn}
          </div>
          <div
            data-testid="inspector-maximized"
            className="absolute inset-0 z-20 flex min-h-0 min-w-0 flex-col overflow-hidden"
          >
            {inspectorPanel}
          </div>
        </div>
      ) : inspectorCollapsed ? (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {conversationColumn}
          <InspectorOpenButton
            controls={inspectorRegionId}
            onOpen={() => useInspectorLayout.getState().setCollapsed(projectId, false)}
          />
        </div>
      ) : (
        <Group
          orientation={narrowInspectorLayout ? "vertical" : "horizontal"}
          className="flex min-h-0 min-w-0 flex-1"
          defaultLayout={narrowInspectorLayout
            ? { conversation: 55, inspector: 45 }
            : { conversation: 100 - inspectorWidthPct, inspector: inspectorWidthPct }}
          onLayoutChange={narrowInspectorLayout ? undefined : handleSplitLayout}
        >
          {/* v4 reads numeric minSize/maxSize as PIXELS — always pass "%"
              strings or the inspector clamps to a tiny pixel sliver. */}
          <Panel
            id="conversation"
            minSize={narrowInspectorLayout ? "45%" : `${100 - MAX_INSPECTOR_WIDTH_PCT}%`}
            className="flex min-h-0 min-w-0 flex-col"
          >
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              {conversationColumn}
            </div>
          </Panel>
          <Separator
            className={narrowInspectorLayout
              ? "group/sep relative h-px w-full shrink-0 cursor-row-resize outline-none"
              : "group/sep relative w-px shrink-0 cursor-col-resize outline-none"}
            style={{ background: "var(--border-subtle)" }}
          >
            <span className={narrowInspectorLayout
              ? "absolute -bottom-1 -top-1 inset-x-0 transition-colors duration-100 group-hover/sep:bg-[var(--accent-muted)]"
              : "absolute inset-y-0 -left-1 -right-1 transition-colors duration-100 group-hover/sep:bg-[var(--accent-muted)]"}
            />
          </Separator>
          <Panel
            id="inspector"
            minSize={narrowInspectorLayout ? "30%" : `${MIN_INSPECTOR_WIDTH_PCT}%`}
            maxSize={narrowInspectorLayout ? "55%" : `${MAX_INSPECTOR_WIDTH_PCT}%`}
            className="flex min-h-0 min-w-0 flex-col"
          >
            {inspectorPanel}
          </Panel>
        </Group>
      )}
    </div>
  );
}

export default function ProjectChatsView({
  projectId,
  active,
  initialChatId,
  initialView,
  externalNavigation = false,
  renderInspector,
  inspectorExclusive = false,
  allowLegacyFallback = true,
}: {
  projectId: string;
  active: boolean;
  initialChatId?: string;
  initialView?: "index" | "draft" | "conversation";
  externalNavigation?: boolean;
  renderInspector?: (detail: CanonicalChatDetailResponse) => ReactNode;
  inspectorExclusive?: boolean;
  allowLegacyFallback?: boolean;
}) {
  const api = useConnection((state) => state.api);
  const [routeAttempt, setRouteAttempt] = useState(0);
  const projectLabel = useBoard((state) => (
    state.projects.find((project) => project.slug === projectId)?.name ?? projectId
  ));
  return (
    <CanonicalChatRoute
      key={routeAttempt}
      api={api}
      projectId={projectId}
      initialChatId={initialChatId}
      initialView={initialView}
      projectLabel={projectLabel}
      active={active}
      externalNavigation={externalNavigation}
      renderInspector={renderInspector}
      inspectorExclusive={inspectorExclusive}
      fallback={allowLegacyFallback
        ? <LegacyProjectChatsView projectId={projectId} active={active} />
        : <ChatUnavailableState onRetry={() => setRouteAttempt((attempt) => attempt + 1)} />}
    />
  );
}

function InspectorHeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{ color: "var(--text-tertiary)" }}
    >
      {children}
    </button>
  );
}

const NARROW_INSPECTOR_MEDIA_QUERY = "(max-width: 1099px)";

function useNarrowInspectorLayout(): boolean {
  const [narrow, setNarrow] = useState(() => (
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(NARROW_INSPECTOR_MEDIA_QUERY).matches
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const mediaQuery = window.matchMedia(NARROW_INSPECTOR_MEDIA_QUERY);
    setNarrow(mediaQuery.matches);
    const update = (event: MediaQueryListEvent) => setNarrow(event.matches);
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return narrow;
}

// The closed inspector leaves one persistent, keyboard-reachable control in
// the conversation pane's top-right corner.
function InspectorOpenButton({
  controls,
  onOpen,
}: {
  controls: string;
  onOpen: () => void;
}) {
  const label = "Show conversation tools";
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={false}
      aria-controls={controls}
      title={label}
      onClick={onOpen}
      className="no-drag absolute right-2.5 top-2.5 z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border outline-none transition-colors hover:brightness-105 focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{
        borderColor: "var(--border-subtle)",
        background: "var(--bg-surface)",
        color: "var(--text-tertiary)",
      }}
    >
      <PanelRightOpen size={14} />
    </button>
  );
}
