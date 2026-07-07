import {
  buildCreateAgentThreadRequestFromComposer,
  type ApprovalDecisionRequest,
  type AgentThreadSnapshot,
  type AgentThreadComposerDraft,
  type ReviewSnapshot,
  type ReviewSummary,
  type RuntimeSummary,
} from "@matrix-os/contracts";
import { create } from "zustand";
import { invoke } from "../lib/operator";

type WorkspaceStatus = "idle" | "loading" | "ready" | "error";
type ReviewStatus = "idle" | "loading" | "ready" | "error";
type CreateStatus = "idle" | "submitting";
type ActionStatus = "idle" | "submitting";
type ReviewSummaryList = {
  items: ReviewSummary[];
  hasMore: boolean;
  nextCursor?: string;
  limit: number;
};

interface CodingAgentWorkspaceState {
  status: WorkspaceStatus;
  summary: RuntimeSummary | null;
  error: string | null;
  reviewsStatus: ReviewStatus;
  reviews: ReviewSummaryList | null;
  reviewsError: string | null;
  selectedReviewId: string | null;
  reviewSnapshotStatus: ReviewStatus;
  reviewSnapshot: ReviewSnapshot | null;
  reviewSnapshotError: string | null;
  threadSnapshotStatus: ReviewStatus;
  threadSnapshot: AgentThreadSnapshot | null;
  threadSnapshotError: string | null;
  createStatus: CreateStatus;
  createError: string | null;
  approvalActionStatus: ActionStatus;
  pendingApprovalId: string | null;
  approvalActionError: string | null;
  pendingApprovalKeys: string[];
  approvalActionErrors: Record<string, string>;
  activeThreadId: string | null;
  refresh: () => Promise<void>;
  selectReview: (reviewId: string) => Promise<void>;
  loadThreadSnapshot: (threadId: string) => Promise<void>;
  submitApprovalDecision: (input: {
    threadId: string;
    approvalId: string;
    decision: ApprovalDecisionRequest["decision"];
    correlationId: string;
  }) => Promise<void>;
  createThread: (draft: AgentThreadComposerDraft) => Promise<string | null>;
}

let refreshSeq = 0;
let reviewsSeq = 0;
let reviewSnapshotSeq = 0;
let threadSnapshotSeq = 0;
let createRequestSeq = 0;
let actionRequestSeq = 0;

function clearReviewSelectionState() {
  reviewSnapshotSeq += 1;
  return {
    selectedReviewId: null,
    reviewSnapshotStatus: "idle" as const,
    reviewSnapshot: null,
    reviewSnapshotError: null,
  };
}

function clearThreadSnapshotState() {
  threadSnapshotSeq += 1;
  return {
    threadSnapshotStatus: "idle" as const,
    threadSnapshot: null,
    threadSnapshotError: null,
  };
}

function nextCreateRequestId(): string {
  createRequestSeq += 1;
  return `req_desktop_${Date.now().toString(36)}_${createRequestSeq}`;
}

function nextActionRequestId(): string {
  actionRequestSeq += 1;
  return `req_desktop_${Date.now().toString(36)}_${actionRequestSeq}`;
}

function withoutRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export function codingAgentApprovalActionKey(threadId: string, approvalId: string): string {
  return `${threadId}:${approvalId}`;
}

export const useCodingAgentWorkspace = create<CodingAgentWorkspaceState>()((set) => ({
  status: "idle",
  summary: null,
  error: null,
  reviewsStatus: "idle",
  reviews: null,
  reviewsError: null,
  selectedReviewId: null,
  reviewSnapshotStatus: "idle",
  reviewSnapshot: null,
  reviewSnapshotError: null,
  threadSnapshotStatus: "idle",
  threadSnapshot: null,
  threadSnapshotError: null,
  createStatus: "idle",
  createError: null,
  approvalActionStatus: "idle",
  pendingApprovalId: null,
  approvalActionError: null,
  pendingApprovalKeys: [],
  approvalActionErrors: {},
  activeThreadId: null,

  refresh: async () => {
    const seq = ++refreshSeq;
    set((state) => ({
      status: state.summary ? "ready" : "loading",
      error: null,
    }));
    try {
      const summary = await invoke("runtime:get-summary", {});
      if (seq !== refreshSeq) return;
      set((state) => {
        const activeThreadStillPresent = state.activeThreadId
          ? summary.activeThreads.items.some((thread) => thread.id === state.activeThreadId)
          : true;
        return {
          status: "ready",
          summary,
          error: null,
          ...(activeThreadStillPresent
            ? {}
            : {
                activeThreadId: null,
                ...clearThreadSnapshotState(),
              }),
        };
      });
      if (!summary.capabilities.some((capability) => capability.id === "codingAgentsReview" && capability.enabled)) {
        set({
          reviewsStatus: "idle",
          reviews: null,
          reviewsError: null,
          ...clearReviewSelectionState(),
        });
        return;
      }
      const reviewSeq = ++reviewsSeq;
      set((state) => ({
        reviewsStatus: state.reviews ? "ready" : "loading",
        reviewsError: null,
      }));
      try {
        const reviews = await invoke("runtime:get-reviews", {});
        if (reviewSeq !== reviewsSeq) return;
        set((state) => {
          const selectedReviewStillPresent = state.selectedReviewId
            ? reviews.items.some((review) => review.id === state.selectedReviewId)
            : true;
          return {
            reviewsStatus: "ready",
            reviews,
            reviewsError: null,
            ...(selectedReviewStillPresent
              ? {}
              : clearReviewSelectionState()),
          };
        });
      } catch {
        console.warn("[coding-agents] review summary refresh failed");
        if (reviewSeq !== reviewsSeq) return;
        set({
          reviewsStatus: "error",
          reviewsError: "Review state unavailable",
          ...clearReviewSelectionState(),
        });
      }
    } catch {
      console.warn("[coding-agents] summary refresh failed");
      if (seq !== refreshSeq) return;
      set({
        status: "error",
        error: "Runtime summary unavailable",
        reviewsStatus: "idle",
        reviews: null,
        reviewsError: null,
        ...clearReviewSelectionState(),
        ...clearThreadSnapshotState(),
      });
    }
  },

  selectReview: async (reviewId) => {
    const seq = ++reviewSnapshotSeq;
    set((state) => ({
      selectedReviewId: reviewId,
      reviewSnapshotStatus: state.reviewSnapshot?.review.id === reviewId ? "ready" : "loading",
      reviewSnapshotError: null,
      reviewSnapshot: state.reviewSnapshot?.review.id === reviewId ? state.reviewSnapshot : null,
    }));
    try {
      const snapshot = await invoke("runtime:get-review-snapshot", { reviewId });
      if (seq !== reviewSnapshotSeq) return;
      set({
        selectedReviewId: reviewId,
        reviewSnapshotStatus: "ready",
        reviewSnapshot: snapshot,
        reviewSnapshotError: null,
      });
    } catch {
      console.warn("[coding-agents] review snapshot refresh failed");
      if (seq !== reviewSnapshotSeq) return;
      set({
        selectedReviewId: reviewId,
        reviewSnapshotStatus: "error",
        reviewSnapshot: null,
        reviewSnapshotError: "Review details unavailable",
      });
    }
  },

  loadThreadSnapshot: async (threadId) => {
    const seq = ++threadSnapshotSeq;
    set((state) => ({
      activeThreadId: threadId,
      threadSnapshotStatus: state.threadSnapshot?.thread.id === threadId ? "ready" : "loading",
      threadSnapshot: state.threadSnapshot?.thread.id === threadId ? state.threadSnapshot : null,
      threadSnapshotError: null,
    }));
    try {
      const snapshot = await invoke("runtime:get-thread-snapshot", { threadId });
      if (seq !== threadSnapshotSeq) return;
      set({
        activeThreadId: threadId,
        threadSnapshotStatus: "ready",
        threadSnapshot: snapshot,
        threadSnapshotError: null,
      });
    } catch {
      console.warn("[coding-agents] thread snapshot refresh failed");
      if (seq !== threadSnapshotSeq) return;
      set({
        activeThreadId: threadId,
        threadSnapshotStatus: "error",
        threadSnapshot: null,
        threadSnapshotError: "Thread state unavailable",
      });
    }
  },

  submitApprovalDecision: async ({ threadId, approvalId, decision, correlationId }) => {
    const approvalKey = codingAgentApprovalActionKey(threadId, approvalId);
    const { pendingApprovalKeys } = useCodingAgentWorkspace.getState();
    if (pendingApprovalKeys.includes(approvalKey)) return;

    set((state) => ({
      approvalActionStatus: "submitting",
      pendingApprovalId: approvalId,
      approvalActionError: null,
      pendingApprovalKeys: [...state.pendingApprovalKeys, approvalKey],
      approvalActionErrors: withoutRecordKey(state.approvalActionErrors, approvalKey),
    }));
    try {
      const snapshot = await invoke("runtime:submit-approval-decision", {
        threadId,
        approvalId,
        decision,
        correlationId,
        clientRequestId: nextActionRequestId(),
      });
      set((state) => {
        const currentSummary = state.summary;
        const nextPendingApprovalKeys = state.pendingApprovalKeys.filter((key) => key !== approvalKey);
        const visibleThreadStillSelected = state.activeThreadId === snapshot.thread.id;
        const summary = currentSummary
          ? {
              ...currentSummary,
              activeThreads: {
                ...currentSummary.activeThreads,
                items: currentSummary.activeThreads.items.map((thread) =>
                  thread.id === snapshot.thread.id ? snapshot.thread : thread,
                ),
              },
            }
          : currentSummary;
        return {
          approvalActionStatus: nextPendingApprovalKeys.length > 0 ? "submitting" : "idle",
          pendingApprovalId: null,
          approvalActionError: null,
          pendingApprovalKeys: nextPendingApprovalKeys,
          approvalActionErrors: withoutRecordKey(state.approvalActionErrors, approvalKey),
          summary,
          ...(visibleThreadStillSelected
            ? {
                threadSnapshotStatus: "ready" as const,
                threadSnapshot: snapshot,
                threadSnapshotError: null,
              }
            : {}),
        };
      });
    } catch {
      console.warn("[coding-agents] approval decision failed");
      set((state) => {
        const nextPendingApprovalKeys = state.pendingApprovalKeys.filter((key) => key !== approvalKey);
        return {
          approvalActionStatus: nextPendingApprovalKeys.length > 0 ? "submitting" : "idle",
          pendingApprovalId: null,
          approvalActionError: "Approval could not be sent. Try again.",
          pendingApprovalKeys: nextPendingApprovalKeys,
          approvalActionErrors: {
            ...state.approvalActionErrors,
            [approvalKey]: "Approval could not be sent. Try again.",
          },
        };
      });
    }
  },

  createThread: async (draft) => {
    const { summary, createStatus } = useCodingAgentWorkspace.getState();
    if (createStatus === "submitting") {
      return null;
    }
    if (!summary) {
      set({ createStatus: "idle", createError: "Agent run could not be started. Try again." });
      return null;
    }

    const built = buildCreateAgentThreadRequestFromComposer({
      draft,
      summary,
      clientRequestId: nextCreateRequestId(),
    });
    if (!built.ok) {
      set({ createStatus: "idle", createError: built.issues[0]?.safeMessage ?? "Agent run could not be started. Try again." });
      return null;
    }

    set({ createStatus: "submitting", createError: null });
    try {
      const snapshot = await invoke("runtime:create-thread", built.request);
      const thread = snapshot.thread;
      set((state) => {
        const currentSummary = state.summary;
        if (!currentSummary) {
          return {
            createStatus: "idle",
            activeThreadId: thread.id,
            threadSnapshotStatus: "ready",
            threadSnapshot: snapshot,
            threadSnapshotError: null,
            createError: null,
          };
        }
        const limit = currentSummary.activeThreads.limit;
        const items = [
          thread,
          ...currentSummary.activeThreads.items.filter((candidate) => candidate.id !== thread.id),
        ].slice(0, limit);
        return {
          createStatus: "idle",
          activeThreadId: thread.id,
          threadSnapshotStatus: "ready",
          threadSnapshot: snapshot,
          threadSnapshotError: null,
          createError: null,
          summary: {
            ...currentSummary,
            activeThreads: {
              ...currentSummary.activeThreads,
              items,
              hasMore: currentSummary.activeThreads.hasMore || items.length >= limit,
            },
          },
        };
      });
      return thread.id;
    } catch {
      console.warn("[coding-agents] thread create failed");
      set({ createStatus: "idle", createError: "Agent run could not be started. Try again." });
      return null;
    }
  },
}));
