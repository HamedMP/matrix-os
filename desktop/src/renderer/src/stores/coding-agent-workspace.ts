import {
  buildCreateAgentThreadRequestFromComposer,
  type AgentThreadComposerDraft,
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
  createStatus: CreateStatus;
  createError: string | null;
  activeThreadId: string | null;
  refresh: () => Promise<void>;
  createThread: (draft: AgentThreadComposerDraft) => Promise<string | null>;
}

let refreshSeq = 0;
let reviewsSeq = 0;
let createRequestSeq = 0;

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
        set({ reviewsStatus: "idle", reviews: null, reviewsError: null });
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
        set({ reviewsStatus: "ready", reviews, reviewsError: null });
      } catch {
        console.warn("[coding-agents] review summary refresh failed");
        if (reviewSeq !== reviewsSeq) return;
        set({ reviewsStatus: "error", reviewsError: "Review state unavailable" });
      }
    } catch {
      console.warn("[coding-agents] summary refresh failed");
      if (seq !== refreshSeq) return;
      set({ status: "error", error: "Runtime summary unavailable" });
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
