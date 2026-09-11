import type {
  AgentThreadSummary,
  ReviewSummary,
  RuntimeSummary,
} from "@matrix-os/contracts";
import type { AgentConversationInspectorTab } from "../coding-agents/AgentConversationInspector";
import { capabilityEnabled } from "../coding-agents/capabilities";

export type ProjectInspectorTerminalState = "linked" | "unavailable" | "unbound";

export interface ProjectInspectorContext {
  summary: RuntimeSummary;
  reviews: ReviewSummary[];
  tabs: AgentConversationInspectorTab[];
  defaultTab: AgentConversationInspectorTab;
  terminalState: ProjectInspectorTerminalState;
  counts: {
    changes: number;
    files: undefined;
    terminal: number;
    preview: number;
    activity: number;
  };
}

interface BuildProjectInspectorContextInput {
  projectId: string;
  summary: RuntimeSummary;
  selectedThread: AgentThreadSummary | null;
  reviews: readonly ReviewSummary[];
}

function projectThreads(
  items: readonly AgentThreadSummary[],
  projectId: string,
): AgentThreadSummary[] {
  return items.filter((thread) => thread.projectId === projectId);
}

/**
 * Produces the only data Project Chat tools may render. Runtime-wide records
 * without a validated project/thread relation are deliberately excluded.
 * This stays pure so capability and empty-state behavior can be verified
 * without mounting the large Project Chats composition.
 */
export function buildProjectInspectorContext({
  projectId,
  summary,
  selectedThread,
  reviews,
}: BuildProjectInspectorContextInput): ProjectInspectorContext {
  const reviewEnabled = capabilityEnabled(summary, "codingAgentsReview");
  const previewEnabled = capabilityEnabled(summary, "codingAgentsPreview");
  const filesEnabled = capabilityEnabled(summary, "codingAgentsFiles");

  const scopedReviews = reviewEnabled
    ? reviews.filter((review) => review.projectId === projectId)
    : [];
  const scopedPreviews = previewEnabled
    ? summary.previewSessions.items.filter((preview) => preview.projectId === projectId)
    : [];
  const scopedActiveThreads = projectThreads(summary.activeThreads.items, projectId);
  const scopedAttentionThreads = projectThreads(summary.attentionThreads.items, projectId);

  const terminalRef = selectedThread?.projectId === projectId
    ? selectedThread.terminalRef
    : undefined;
  const linkedWorkspace = terminalRef
    ? summary.terminalWorkspaces.items.find((workspace) => (
        workspace.id === terminalRef.workspaceId
        && workspace.scope === "project"
        && workspace.projectId === projectId
      )) ?? null
    : null;
  const linkedTerminal = linkedWorkspace
    ? linkedWorkspace.tabs.find((tab) => tab.id === terminalRef?.tabId) ?? null
    : null;
  const terminalState: ProjectInspectorTerminalState = linkedTerminal
    ? "linked"
    : terminalRef
      ? "unavailable"
      : "unbound";

  const activityIds = new Set([
    ...scopedActiveThreads.map((thread) => thread.id),
    ...scopedAttentionThreads.map((thread) => thread.id),
  ]);
  const tabs: AgentConversationInspectorTab[] = [
    ...(reviewEnabled ? ["changes" as const] : []),
    ...(filesEnabled ? ["files" as const] : []),
    "terminal",
    ...(previewEnabled ? ["preview" as const] : []),
    "activity",
  ];
  const defaultTab = scopedReviews.length > 0
    ? "changes"
    : linkedTerminal
      ? "terminal"
      : scopedPreviews.length > 0
        ? "preview"
        : filesEnabled
          ? "files"
          : "activity";

  return {
    reviews: scopedReviews,
    tabs,
    defaultTab,
    terminalState,
    counts: {
      changes: scopedReviews.length,
      files: undefined,
      terminal: linkedTerminal ? 1 : 0,
      preview: scopedPreviews.length,
      activity: activityIds.size,
    },
    summary: {
      ...summary,
      activeThreads: { ...summary.activeThreads, items: scopedActiveThreads, hasMore: false },
      attentionThreads: { ...summary.attentionThreads, items: scopedAttentionThreads, hasMore: false },
      terminalWorkspaces: {
        ...summary.terminalWorkspaces,
        items: linkedWorkspace && linkedTerminal
          ? [{ ...linkedWorkspace, tabs: [linkedTerminal] }]
          : [],
        hasMore: false,
      },
      previewSessions: { ...summary.previewSessions, items: scopedPreviews, hasMore: false },
      // Activity records currently carry no project relation. Rendering them
      // here would falsely present runtime-global events as project context.
      recentActivity: { ...summary.recentActivity, items: [], hasMore: false },
    },
  };
}
