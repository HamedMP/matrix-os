import { Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { defaultAgentThreadComposerDraft } from "@matrix-os/contracts";
import { codingAgentRuntimeScope } from "../../../../shared/coding-agent-project-workspace";
import { Button, EmptyState } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import {
  clearCodingAgentRuntimeSelection,
  useCodingAgentWorkspace,
} from "../../stores/coding-agent-workspace";
import { useCodingAgentProjectWorkspace } from "../../stores/coding-agent-project-workspace";
import { AgentPreviewList, AgentTerminalList } from "./AgentWorkspaceContext";
import { AgentRuntimeHeader } from "./AgentRuntimeHeader";
import { AgentProjectWorkspaceShell } from "./AgentProjectWorkspaceShell";
import { AgentConversationView } from "./AgentConversationView";
import { AgentWorkspaceViewSwitch } from "./AgentKanbanBoard";
import { AgentKanbanWorkspace } from "./AgentKanbanWorkspace";
import { AgentConversationInspector } from "./AgentConversationInspector";
import { toast } from "sonner";
import { AgentComposer, type ComposerSeed } from "./AgentComposer";
import {
  AttentionThreadList,
  InspectorEmptyState,
  NotificationPreferencesPanel,
  ProviderList,
} from "./AgentWorkspacePanels";
import { capabilityEnabled } from "./capabilities";
import { CreatedThreadHandleList, ThreadList } from "./AgentThreadLists";
import { ReviewList, reviewHunkFollowUpDraft } from "./AgentReviewPanel";

export { mergeAttachments, mergeComposerSeed, clearComposerLaunchContext } from "./AgentComposer";

export default function AgentWorkspace() {
  const runtimeScope = useConnection(codingAgentRuntimeScope);
  const status = useCodingAgentWorkspace((s) => s.status);
  const summary = useCodingAgentWorkspace((s) => s.summary);
  const error = useCodingAgentWorkspace((s) => s.error);
  const refresh = useCodingAgentWorkspace((s) => s.refresh);
  const activeThreadId = useCodingAgentWorkspace((s) => s.activeThreadId);
  const threadSnapshotStatus = useCodingAgentWorkspace((s) => s.threadSnapshotStatus);
  const threadSnapshot = useCodingAgentWorkspace((s) => s.threadSnapshot);
  const threadSnapshotError = useCodingAgentWorkspace((s) => s.threadSnapshotError);
  const reviews = useCodingAgentWorkspace((s) => s.reviews);
  const reviewFocusRequestId = useCodingAgentWorkspace((s) => s.reviewFocusRequestId);
  const loadThreadSnapshot = useCodingAgentWorkspace((s) => s.loadThreadSnapshot);
  const loadNotificationPreferences = useCodingAgentWorkspace((s) => s.loadNotificationPreferences);
  const refreshProjectWorkspace = useCodingAgentProjectWorkspace((s) => s.refresh);
  const resolveNewChatTarget = useCodingAgentProjectWorkspace((s) => s.resolveNewChatTarget);
  const projectWorkspace = useCodingAgentProjectWorkspace((s) => s.workspace);
  const viewMode = useCodingAgentProjectWorkspace((s) => s.viewMode);
  const setViewMode = useCodingAgentProjectWorkspace((s) => s.setViewMode);
  const requestComposerFocus = useCodingAgentWorkspace((s) => s.requestComposerFocus);
  const composerFocusRequestId = useCodingAgentWorkspace((s) => s.composerFocusRequestId);
  const selectedProjectId = useCodingAgentProjectWorkspace((s) => s.selectedProjectId);
  const selectedTaskId = useCodingAgentProjectWorkspace((s) => s.selectedTaskId);
  const [composerSeed, setComposerSeed] = useState<ComposerSeed | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [summaryRuntimeScope, setSummaryRuntimeScope] = useState<string | null>(null);
  const previousRuntimeScope = useRef(runtimeScope);

  useEffect(() => {
    const scopeChanged = previousRuntimeScope.current !== runtimeScope;
    previousRuntimeScope.current = runtimeScope;
    const startingSummaryRevision = useCodingAgentWorkspace.getState().summaryRevision;
    let active = true;
    setSummaryRuntimeScope(null);
    if (scopeChanged) {
      clearCodingAgentRuntimeSelection();
      setComposerSeed(null);
    }
    const unsubscribeSummary = useCodingAgentWorkspace.subscribe((state) => {
      if (
        active
        && state.status === "ready"
        && state.summaryRevision > startingSummaryRevision
      ) {
        setSummaryRuntimeScope(runtimeScope);
      }
    });
    void refresh();
    void loadNotificationPreferences();
    return () => {
      active = false;
      unsubscribeSummary();
    };
  }, [loadNotificationPreferences, refresh, runtimeScope]);

  useEffect(() => {
    if (!activeThreadId) return;
    if (threadSnapshotStatus === "ready" && threadSnapshot?.thread.id === activeThreadId) return;
    void loadThreadSnapshot(activeThreadId);
  }, [activeThreadId, loadThreadSnapshot, runtimeScope, threadSnapshot?.thread.id, threadSnapshotStatus]);

  const summaryScopeReady = summaryRuntimeScope === runtimeScope;
  const kanbanEnabled = summary
    ? capabilityEnabled(summary, "codingAgentsKanbanView")
    : false;

  if (!summaryScopeReady) {
    if (status === "error") {
      return (
        <EmptyState
          icon={<Server size={28} />}
          headline={error ?? "Runtime summary unavailable"}
          description="Refresh the workspace or check your selected runtime."
          action={<Button onClick={() => void refresh()}>Retry</Button>}
        />
      );
    }
    return (
      <EmptyState
        icon={<Server size={28} />}
        headline="Loading workspace..."
        description="Fetching runtime state from your Matrix computer."
      />
    );
  }

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

  if (!summary) return null;

  const canCreateFollowUp = capabilityEnabled(summary, "codingAgentsThreadCreate");
  const projectWorkspaceEnabled = capabilityEnabled(summary, "codingAgentsProjectWorkspace");

  async function openNewChat(projectId: string, taskId?: string) {
    const relation = await resolveNewChatTarget(projectId, taskId);
    if (!relation) {
      toast.error("Couldn't start a new chat here. Refresh the workspace and try again.");
      return;
    }
    setComposerSeed({
      seedId: Date.now(),
      draft: {
        ...defaultAgentThreadComposerDraft(summary!),
        ...relation,
      },
    });
    setComposerOpen(true);
    requestComposerFocus();
  }

  const showKanban = kanbanEnabled && viewMode === "kanban" && projectWorkspace;
  const reviewEnabled = capabilityEnabled(summary, "codingAgentsReview");
  const previewEnabled = capabilityEnabled(summary, "codingAgentsPreview");
  const inspectorCounts = {
    changes: reviewEnabled ? (reviews?.items.length ?? 0) : 0,
    terminal: summary.terminalSessions.items.length,
    preview: previewEnabled ? (summary.previewSessions?.items.length ?? 0) : 0,
    activity: summary.attentionThreads.items.length + summary.activeThreads.items.length,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AgentRuntimeHeader
        summary={summary}
        onRefresh={() => {
          void (async () => {
            await refresh();
            await refreshProjectWorkspace();
          })();
        }}
      />
      <AgentProjectWorkspaceShell
        summary={summary}
        onNewChat={openNewChat}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {projectWorkspace ? (
            <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{projectWorkspace.project.label}</p>
                <p className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>{showKanban ? "Project tasks" : "Project conversations"}</p>
              </div>
              {kanbanEnabled ? <AgentWorkspaceViewSwitch viewMode={viewMode} onChange={setViewMode} /> : null}
            </header>
          ) : null}
          {showKanban ? (
            <AgentKanbanWorkspace providers={summary.providers} />
          ) : (
            <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(360px,1fr)_minmax(340px,clamp(340px,34vw,520px))] lg:overflow-hidden">
              <div className="flex min-h-[460px] min-w-0 flex-col overflow-hidden border-b lg:min-h-0 lg:border-b-0 lg:border-r" style={{ borderColor: "var(--border-subtle)" }}>
                <AgentConversationView
                  status={threadSnapshotStatus}
                  snapshot={threadSnapshot}
                  error={threadSnapshotError}
                  canSendTurns={capabilityEnabled(summary, "codingAgentsSameThreadTurns")}
                />
              </div>
              <aside
                aria-label="Conversation tools"
                className="flex min-h-[520px] min-w-0 flex-col overflow-hidden lg:min-h-0"
                style={{ background: "var(--bg-secondary)" }}
              >
                <AgentConversationInspector
                  defaultTab={reviewEnabled ? "changes" : "terminal"}
                  changesFocusRequestId={reviewFocusRequestId}
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
                          disabled={!selectedProjectId}
                          aria-label={composerOpen ? "Close new chat composer" : "New chat in selected project"}
                          onClick={() => {
                            if (composerOpen) {
                              setComposerOpen(false);
                              setComposerSeed(null);
                              return;
                            }
                            if (selectedProjectId) void openNewChat(selectedProjectId, selectedTaskId ?? undefined);
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
                        if (!projectWorkspaceEnabled) return;
                        setComposerOpen(false);
                        setComposerSeed(null);
                      }}
                    />
                  ) : undefined}
                  changes={reviewEnabled ? (
                    <ReviewList
                      canReadFiles={capabilityEnabled(summary, "codingAgentsFiles")}
                      canPrepareCommit={capabilityEnabled(summary, "codingAgentsSourceControl")}
                      canCreateFollowUp={canCreateFollowUp}
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
                  terminal={<AgentTerminalList summary={summary} />}
                  preview={previewEnabled ? (
                    <AgentPreviewList summary={summary} />
                  ) : (
                    <InspectorEmptyState message="No preview capability is available for this project." />
                  )}
                  activity={(
                    <div className="space-y-4">
                      <AttentionThreadList summary={summary} />
                      <ThreadList summary={summary} />
                      <CreatedThreadHandleList summary={summary} />
                      <ProviderList summary={summary} />
                      <NotificationPreferencesPanel />
                    </div>
                  )}
                />
              </aside>
            </div>
          )}
        </div>
      </AgentProjectWorkspaceShell>
    </div>
  );
}
