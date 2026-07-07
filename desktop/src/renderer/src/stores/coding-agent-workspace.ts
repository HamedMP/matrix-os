import {
  buildCreateAgentThreadRequestFromComposer,
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
  createStatus: CreateStatus;
  createError: string | null;
  activeThreadId: string | null;
  refresh: () => Promise<void>;
  selectReview: (reviewId: string) => Promise<void>;
  createThread: (draft: AgentThreadComposerDraft) => Promise<string | null>;
}

let refreshSeq = 0;
let reviewsSeq = 0;
let reviewSnapshotSeq = 0;
let createRequestSeq = 0;

function clearReviewSelectionState() {
  reviewSnapshotSeq += 1;
  return {
    selectedReviewId: null,
    reviewSnapshotStatus: "idle" as const,
    reviewSnapshot: null,
    reviewSnapshotError: null,
  };
}

function nextCreateRequestId(): string {
  createRequestSeq += 1;
  return `req_desktop_${Date.now().toString(36)}_${createRequestSeq}`;
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
  createStatus: "idle",
  createError: null,
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
      set({ status: "ready", summary, error: null });
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
          return { createStatus: "idle", activeThreadId: thread.id, createError: null };
        }
        const limit = currentSummary.activeThreads.limit;
        const items = [
          thread,
          ...currentSummary.activeThreads.items.filter((candidate) => candidate.id !== thread.id),
        ].slice(0, limit);
        return {
          createStatus: "idle",
          activeThreadId: thread.id,
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
