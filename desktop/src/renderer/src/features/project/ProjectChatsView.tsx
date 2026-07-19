import { MessageSquare, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { defaultAgentThreadComposerDraft } from "@matrix-os/contracts";
import { Button, EmptyState } from "../../design/primitives";
import { useProjectChatLauncher } from "../../lib/project-chat";
import {
  clearCodingAgentThreadSelection,
  useCodingAgentWorkspace,
} from "../../stores/coding-agent-workspace";
import { useProjectView } from "../../stores/project-view";
import { useProjectWorkspaces } from "../../stores/project-workspaces";
import { AgentPreviewList, AgentTerminalList } from "../coding-agents/AgentWorkspaceContext";
import { AgentConversationView } from "../coding-agents/AgentConversationView";
import { AgentConversationInspector } from "../coding-agents/AgentConversationInspector";
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
  const [composerSeed, setComposerSeed] = useState<ComposerSeed | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);

  // Self-sufficiency bootstrap (tests, future embeds): when no shell bootstrap
  // has loaded the runtime summary yet, the view loads it itself. ProjectTab
  // and MissionControl run the same guarded check, so only one refresh fires.
  useEffect(() => {
    const workspace = useCodingAgentWorkspace.getState();
    if (workspace.status !== "idle" || workspace.summary) return;
    void workspace.refresh().then(() => {
      const current = useCodingAgentWorkspace.getState();
      if (current.notificationPreferencesStatus === "idle") {
        void current.loadNotificationPreferences();
      }
    });
  }, []);

  const projectWorkspaceEnabled = summary
    ? capabilityEnabled(summary, "codingAgentsProjectWorkspace")
    : false;

  useEffect(() => {
    if (!projectWorkspaceEnabled) return;
    void ensureWorkspace(projectId);
  }, [ensureWorkspace, projectId, projectWorkspaceEnabled]);

  useEffect(() => {
    if (!active) return;
    const workspace = useCodingAgentWorkspace.getState();
    if (!selectedThreadId) {
      // No chat selected here: the shared snapshot must not keep another
      // project's conversation warm while this tab is visible.
      if (workspace.activeThreadId) clearCodingAgentThreadSelection();
      return;
    }
    if (workspace.activeThreadId !== selectedThreadId) {
      void workspace.loadThreadSnapshot(selectedThreadId);
    }
  }, [active, selectedThreadId]);

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
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(360px,1fr)_minmax(340px,clamp(340px,34vw,520px))] lg:overflow-hidden">
        <div className="flex min-h-[460px] min-w-0 flex-col overflow-hidden border-b lg:min-h-0 lg:border-b-0 lg:border-r" style={{ borderColor: "var(--border-subtle)" }}>
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
        <aside
          aria-label="Conversation tools"
          className="flex min-h-[520px] min-w-0 flex-col overflow-hidden lg:min-h-0"
          style={{ background: "var(--bg-secondary)" }}
        >
          <AgentConversationInspector
            defaultTab={reviewEnabled ? "changes" : "terminal"}
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
                  if (!projectWorkspaceEnabled) return;
                  setComposerOpen(false);
                  setComposerSeed(null);
                  // Surface the new chat in the list and select it.
                  const createdId = useCodingAgentWorkspace.getState().activeThreadId;
                  if (createdId) setSelectedThread(projectId, createdId);
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
            terminal={<AgentTerminalList summary={summary} />}
            preview={previewEnabled ? (
              <AgentPreviewList summary={summary} />
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
      </div>
    </div>
  );
}
