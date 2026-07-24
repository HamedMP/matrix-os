import { MessageSquare, PanelRightClose, PanelRightOpen, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, type Layout as SplitLayout } from "react-resizable-panels";
import { defaultAgentThreadComposerDraft } from "@matrix-os/contracts";
import { codingAgentRuntimeScope } from "../../../../shared/coding-agent-project-workspace";
import { Button, EmptyState } from "../../design/primitives";
import { useProjectChatLauncher } from "../../lib/project-chat";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useConnection } from "../../stores/connection";
import { useProjectView } from "../../stores/project-view";
import { useProjectWorkspaces } from "../../stores/project-workspaces";
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
import { AgentComposer, type ComposerSeed } from "../coding-agents/AgentComposer";
import {
  AttentionThreadList,
  InspectorEmptyState,
  NotificationPreferencesPanel,
  ProviderList,
} from "../coding-agents/AgentWorkspacePanels";
import { capabilityEnabled } from "../coding-agents/capabilities";
import { CreatedThreadHandleList, ThreadList } from "../coding-agents/AgentThreadLists";
import { ReviewList, reviewHunkFollowUpDraft } from "../coding-agents/AgentReviewPanel";
import { openCodingAgentThread } from "../../lib/project-chat";
import { ProjectThreadList } from "./ProjectThreadList";

export { mergeAttachments, mergeComposerSeed, clearComposerLaunchContext } from "../coding-agents/AgentComposer";

/**
 * The project's Chats view: thread list on the left, the selected
 * conversation in the middle, and the shared conversation inspector on the
 * right. The single coding-agent snapshot store follows the ACTIVE project
 * tab's selection, so only the visible Chats view binds a conversation —
 * background project tabs keep their selection but never fight over the
 * shared snapshot.
 */
export default function ProjectChatsView({ projectId, active }: { projectId: string; active: boolean }) {
  const status = useCodingAgentWorkspace((s) => s.status);
  const summary = useCodingAgentWorkspace((s) => s.summary);
  const error = useCodingAgentWorkspace((s) => s.error);
  const refresh = useCodingAgentWorkspace((s) => s.refresh);
  const loadNotificationPreferences = useCodingAgentWorkspace((s) => s.loadNotificationPreferences);
  const activeThreadId = useCodingAgentWorkspace((s) => s.activeThreadId);
  const threadSnapshotStatus = useCodingAgentWorkspace((s) => s.threadSnapshotStatus);
  const threadSnapshot = useCodingAgentWorkspace((s) => s.threadSnapshot);
  const threadSnapshotError = useCodingAgentWorkspace((s) => s.threadSnapshotError);
  const reviews = useCodingAgentWorkspace((s) => s.reviews);
  const reviewFocusRequestId = useCodingAgentWorkspace((s) => s.reviewFocusRequestId);
  const reviewFocusConsumedId = useCodingAgentWorkspace((s) => s.reviewFocusConsumedId);
  const consumeReviewFocusRequest = useCodingAgentWorkspace((s) => s.consumeReviewFocusRequest);
  const loadThreadSnapshot = useCodingAgentWorkspace((s) => s.loadThreadSnapshot);
  const requestComposerFocus = useCodingAgentWorkspace((s) => s.requestComposerFocus);
  const composerFocusRequestId = useCodingAgentWorkspace((s) => s.composerFocusRequestId);
  const workspaceEntry = useProjectWorkspaces((s) => s.entries[projectId]);
  const ensureWorkspace = useProjectWorkspaces((s) => s.ensure);
  const refreshWorkspace = useProjectWorkspaces((s) => s.refresh);
  const resolveNewChatTarget = useProjectWorkspaces((s) => s.resolveNewChatTarget);
  const selectedThreadId = useProjectView((s) => s.entries[projectId]?.selectedThreadId ?? null);
  const setSelectedThread = useProjectView((s) => s.setSelectedThread);
  const composerRequest = useProjectChatLauncher((s) => s.composerRequest);
  const runtimeScope = useConnection(codingAgentRuntimeScope);
  const inspectorEntry = useInspectorLayout((s) => s.entries[projectId]);
  const [composerSeed, setComposerSeed] = useState<ComposerSeed | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [inspectorTabOverride, setInspectorTabOverride] = useState<AgentConversationInspectorTab | null>(null);

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

  useEffect(() => {
    if (!projectWorkspaceEnabled) return;
    void ensureWorkspace(projectId);
  }, [ensureWorkspace, projectId, projectWorkspaceEnabled]);

  // The shared snapshot store follows the ACTIVE project tab's selection.
  // Background tabs keep their per-project selection in the view store but
  // never bind the snapshot, so two open project chats cannot fight over it.
  // When the runtime evicts a previously bound conversation (a refresh says
  // the thread is gone) and the project workspace doesn't list it either, the
  // selection is dropped instead of resurrecting a vanished conversation.
  const boundThreadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !selectedThreadId) return;
    const workspace = useCodingAgentWorkspace.getState();
    if (workspace.activeThreadId === selectedThreadId) {
      if (workspace.threadSnapshot?.thread.id === selectedThreadId) {
        boundThreadRef.current = selectedThreadId;
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
  }, [active, selectedThreadId, activeThreadId, threadSnapshot?.thread.id, projectId, setSelectedThread]);

  async function openNewChat(taskId?: string) {
    if (!summary) return;
    const relation = await resolveNewChatTarget(projectId, taskId);
    if (!relation) {
      toast.error("Couldn't start a new chat here. Refresh the workspace and try again.");
      return;
    }
    setComposerSeed({
      seedId: Date.now(),
      draft: {
        ...defaultAgentThreadComposerDraft(summary),
        ...relation,
      },
    });
    setComposerOpen(true);
    requestComposerFocus();
  }

  useEffect(() => {
    if (!active || !composerRequest || composerRequest.projectId !== projectId) return;
    useProjectChatLauncher.getState().consumeComposer(projectId);
    if (!projectWorkspaceEnabled) {
      // Without project pages the composer is always visible; just focus it.
      requestComposerFocus();
      return;
    }
    void openNewChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, composerRequest, projectId, projectWorkspaceEnabled]);

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
        action={<Button onClick={() => void refresh()}>Retry</Button>}
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
  const inspectorCounts = {
    changes: reviewEnabled ? (reviews?.items.length ?? 0) : 0,
    terminal: summary.terminalSessions.items.length,
    preview: previewEnabled ? (summary.previewSessions?.items.length ?? 0) : 0,
    activity: summary.attentionThreads.items.length + summary.activeThreads.items.length,
  };

  // Threads opened from the runtime-wide inspector lists open in their own
  // project context when they belong elsewhere.
  const openListedThread = (threadId: string, threadProjectId?: string) => {
    if (threadProjectId && threadProjectId !== projectId) {
      openCodingAgentThread(threadId);
      return;
    }
    setSelectedThread(projectId, threadId);
    if (useCodingAgentWorkspace.getState().activeThreadId !== threadId) {
      void loadThreadSnapshot(threadId);
    }
  };

  // Slice 2 hero layout: the conversation and the tools inspector sit in a
  // resizable split; collapsing the inspector yields a full-width hero
  // transcript. Width and collapsed state persist per project.
  const inspectorCollapsed = inspectorEntry?.collapsed ?? false;
  const inspectorWidthPct = inspectorEntry?.widthPct ?? DEFAULT_INSPECTOR_WIDTH_PCT;
  const inspectorRegionId = `project-${projectId}-inspector`;

  // The inspector tab is controlled so live surfaces can gate on visibility:
  // the embedded terminal releases the single app-wide socket attachment
  // while another surface (or a background project tab) is showing.
  const inspectorDefaultTab: AgentConversationInspectorTab = reviewEnabled ? "changes" : "terminal";
  const inspectorTab = inspectorTabOverride ?? inspectorDefaultTab;

  const handleSplitLayout = (layout: SplitLayout) => {
    const pct = layout["inspector"];
    if (typeof pct !== "number" || !Number.isFinite(pct)) return;
    const store = useInspectorLayout.getState();
    if (Math.round(pct) === store.layoutFor(projectId).widthPct) return;
    store.setWidthPct(projectId, pct);
  };

  const conversationColumn = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {selectedThreadId ? (
        <AgentConversationView
          status={activeThreadId === selectedThreadId ? threadSnapshotStatus : "loading"}
          snapshot={snapshotMatches ? threadSnapshot : null}
          error={activeThreadId === selectedThreadId ? threadSnapshotError : null}
          canSendTurns={canSendTurns}
        />
      ) : (
        <EmptyState
          icon={<MessageSquare size={28} />}
          headline="Select a chat"
          description="Pick a conversation from the list, or start a new chat for this project."
          action={canCreate && projectWorkspaceEnabled ? (
            <Button variant="primary" onClick={() => void openNewChat()}>New chat</Button>
          ) : undefined}
        />
      )}
    </div>
  );

  const inspectorPanel = (
    <aside
      id={inspectorRegionId}
      aria-label="Conversation tools"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      style={{ background: "var(--bg-secondary)" }}
    >
      <AgentConversationInspector
        defaultTab={inspectorDefaultTab}
        selectedTab={inspectorTab}
        onTabChange={setInspectorTabOverride}
        changesFocusRequestId={reviewFocusRequestId}
        changesFocusConsumedId={reviewFocusConsumedId}
        onChangesFocusConsumed={consumeReviewFocusRequest}
        counts={inspectorCounts}
        toolbar={(
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Conversation tools</h2>
              <p className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>Inspect the current project without leaving the chat</p>
            </div>
            {projectWorkspaceEnabled ? (
              <Button
                variant={composerOpen ? "subtle" : "primary"}
                aria-label={composerOpen ? "Close new chat composer" : "New chat in selected project"}
                onClick={() => {
                  if (composerOpen) {
                    setComposerOpen(false);
                    setComposerSeed(null);
                    return;
                  }
                  void openNewChat();
                }}
              >
                {composerOpen ? "Cancel" : "New chat"}
              </Button>
            ) : null}
          </div>
        )}
        composer={!projectWorkspaceEnabled || composerOpen ? (
          <AgentComposer
            summary={summary}
            seed={composerSeed}
            focusRequestId={composerFocusRequestId}
            onCreated={() => {
              // Surface the new chat in the list and select it, whatever
              // the capability shape — a created conversation must never
              // land on the empty state.
              const createdId = useCodingAgentWorkspace.getState().activeThreadId;
              if (createdId) setSelectedThread(projectId, createdId);
              if (!projectWorkspaceEnabled) return;
              setComposerOpen(false);
              setComposerSeed(null);
              void refreshWorkspace(projectId);
            }}
          />
        ) : undefined}
        changes={reviewEnabled ? (
          <ReviewList
            canReadFiles={capabilityEnabled(summary, "codingAgentsFiles")}
            canPrepareCommit={capabilityEnabled(summary, "codingAgentsSourceControl")}
            canCreateFollowUp={canCreate}
            onAskHunkFollowUp={(snapshot, selected) => {
              setComposerSeed({
                seedId: Date.now(),
                draft: reviewHunkFollowUpDraft(summary, snapshot, selected),
              });
              setComposerOpen(true);
            }}
          />
        ) : (
          <InspectorEmptyState message="Change review is not available on this computer." />
        )}
        files={<InspectorFilesPanel />}
        terminal={(
          <InspectorTerminalPanel
            summary={summary}
            active={inspectorTab === "terminal" && active && !inspectorCollapsed}
          />
        )}
        preview={previewEnabled ? (
          <InspectorPreviewPanel summary={summary} />
        ) : (
          <InspectorEmptyState message="No preview capability is available for this project." />
        )}
        activity={(
          <div className="space-y-4">
            <AttentionThreadList
              summary={summary}
              onOpenThread={(thread) => openListedThread(thread.id, thread.projectId)}
            />
            <ThreadList
              summary={summary}
              onOpenThread={(thread) => openListedThread(thread.id, thread.projectId)}
            />
            <CreatedThreadHandleList
              summary={summary}
              onOpenThread={(thread) => openListedThread(thread.id, thread.projectId)}
            />
            <ProviderList summary={summary} />
            <NotificationPreferencesPanel />
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
        status={projectWorkspaceEnabled ? (workspaceEntry?.status ?? "idle") : "absent"}
        error={workspaceEntry?.error ?? null}
        selectedThreadId={selectedThreadId}
        canCreate={canCreate && projectWorkspaceEnabled}
        onSelectThread={(threadId) => openListedThread(threadId)}
        onNewChat={(taskId) => void openNewChat(taskId)}
        onRetry={() => void refreshWorkspace(projectId)}
      />
      {inspectorCollapsed ? (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {conversationColumn}
          <InspectorToggle
            collapsed
            controls={inspectorRegionId}
            onToggle={() => useInspectorLayout.getState().setCollapsed(projectId, false)}
          />
        </div>
      ) : (
        <Group
          orientation="horizontal"
          className="flex min-h-0 min-w-0 flex-1"
          defaultLayout={{ conversation: 100 - inspectorWidthPct, inspector: inspectorWidthPct }}
          onLayoutChange={handleSplitLayout}
        >
          {/* v4 reads numeric minSize/maxSize as PIXELS — always pass "%"
              strings or the inspector clamps to a tiny pixel sliver. */}
          <Panel id="conversation" minSize={`${100 - MAX_INSPECTOR_WIDTH_PCT}%`} className="flex min-h-0 min-w-0 flex-col">
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              {conversationColumn}
              <InspectorToggle
                collapsed={false}
                controls={inspectorRegionId}
                onToggle={() => useInspectorLayout.getState().setCollapsed(projectId, true)}
              />
            </div>
          </Panel>
          <Separator
            className="group/sep relative w-px shrink-0 cursor-col-resize outline-none"
            style={{ background: "var(--border-subtle)" }}
          >
            <span className="absolute inset-y-0 -left-1 -right-1 transition-colors duration-100 group-hover/sep:bg-[var(--accent-muted)]" />
          </Separator>
          <Panel
            id="inspector"
            minSize={`${MIN_INSPECTOR_WIDTH_PCT}%`}
            maxSize={`${MAX_INSPECTOR_WIDTH_PCT}%`}
            className="flex min-h-0 min-w-0 flex-col"
          >
            {inspectorPanel}
          </Panel>
        </Group>
      )}
    </div>
  );
}

// Collapse toggle for the tools inspector. Lives in the conversation pane's
// top-right corner so the hero transcript keeps one persistent, keyboard-
// reachable control in both states.
function InspectorToggle({
  collapsed,
  controls,
  onToggle,
}: {
  collapsed: boolean;
  controls: string;
  onToggle: () => void;
}) {
  const label = collapsed ? "Show conversation tools" : "Hide conversation tools";
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls={controls}
      title={label}
      onClick={onToggle}
      className="no-drag absolute right-2.5 top-2.5 z-10 flex h-7 w-7 items-center justify-center rounded-md border outline-none transition-colors hover:brightness-105 focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{
        borderColor: "var(--border-subtle)",
        background: "var(--bg-surface)",
        color: "var(--text-tertiary)",
      }}
    >
      {collapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
    </button>
  );
}
