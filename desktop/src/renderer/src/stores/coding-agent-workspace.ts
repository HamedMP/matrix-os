import {
  buildCreateAgentThreadRequestFromComposer,
  type ApprovalDecisionRequest,
  type AgentThreadSnapshot,
  type AgentThreadComposerDraft,
  type FileReadRequest,
  type FileReadResponse,
  type FileWriteRequest,
  type ReviewSnapshot,
  type ReviewSummary,
  type RuntimeSummary,
  type UserInputAnswerRequest,
} from "@matrix-os/contracts";
import { create } from "zustand";
import { invoke } from "../lib/operator";

type WorkspaceStatus = "idle" | "loading" | "ready" | "error";
type ReviewStatus = "idle" | "loading" | "ready" | "error";
type FileReadStatus = "idle" | "loading" | "ready" | "error";
type FileWriteStatus = "idle" | "saving" | "saved" | "error";
type CreateStatus = "idle" | "submitting";
type ActionStatus = "idle" | "submitting";
type AgentThreadSnapshotEvent = AgentThreadSnapshot["events"]["items"][number];
type FileReference = Pick<FileReadRequest, "projectId" | "worktreeId" | "path">;
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
  fileReadStatus: FileReadStatus;
  fileRead: FileReadResponse | null;
  fileReadError: string | null;
  fileWriteStatus: FileWriteStatus;
  fileWriteError: string | null;
  selectedFilePath: string | null;
  selectedFileReference: FileReference | null;
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
  inputActionStatus: ActionStatus;
  pendingInputRequestId: string | null;
  inputActionError: string | null;
  pendingInputRequestKeys: string[];
  inputActionErrors: Record<string, string>;
  activeThreadId: string | null;
  refresh: () => Promise<void>;
  selectReview: (reviewId: string) => Promise<void>;
  loadFileContent: (request: FileReadRequest) => Promise<void>;
  saveFileContent: (request: Omit<FileWriteRequest, "encoding" | "clientRequestId">) => Promise<void>;
  loadThreadSnapshot: (threadId: string) => Promise<void>;
  submitApprovalDecision: (input: {
    threadId: string;
    approvalId: string;
    decision: ApprovalDecisionRequest["decision"];
    correlationId: string;
  }) => Promise<void>;
  submitInputAnswer: (input: {
    threadId: string;
    inputRequestId: string;
    answer: UserInputAnswerRequest["answer"];
    correlationId: string;
  }) => Promise<void>;
  createThread: (draft: AgentThreadComposerDraft) => Promise<string | null>;
}

let refreshSeq = 0;
let reviewsSeq = 0;
let reviewSnapshotSeq = 0;
let fileReadSeq = 0;
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
    ...clearFileReadState(),
  };
}

function clearFileReadState() {
  fileReadSeq += 1;
  return {
    fileReadStatus: "idle" as const,
    fileRead: null,
    fileReadError: null,
    fileWriteStatus: "idle" as const,
    fileWriteError: null,
    selectedFilePath: null,
    selectedFileReference: null,
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

function fileReferenceMatches(reference: FileReference | null, request: FileReference): boolean {
  return reference?.projectId === request.projectId
    && reference.worktreeId === request.worktreeId
    && reference.path === request.path;
}

function compareThreadEvents(left: AgentThreadSnapshotEvent, right: AgentThreadSnapshotEvent): number {
  const occurredAt = left.occurredAt.localeCompare(right.occurredAt);
  return occurredAt === 0 ? left.eventId.localeCompare(right.eventId) : occurredAt;
}

function mergeSelectedThreadSnapshot(
  current: AgentThreadSnapshot | null,
  next: AgentThreadSnapshot,
): AgentThreadSnapshot {
  if (!current || current.thread.id !== next.thread.id) return next;
  const eventById = new Map<string, AgentThreadSnapshotEvent>();
  for (const event of current.events.items) eventById.set(event.eventId, event);
  for (const event of next.events.items) eventById.set(event.eventId, event);
  const limit = Math.max(current.events.limit, next.events.limit);
  const items = Array.from(eventById.values())
    .sort(compareThreadEvents)
    .slice(-limit);
  const thread = current.thread.updatedAt > next.thread.updatedAt ? current.thread : next.thread;
  return {
    ...next,
    thread,
    events: {
      ...next.events,
      items,
      hasMore: current.events.hasMore || next.events.hasMore,
      limit,
    },
  };
}

function summaryIncludesThread(summary: RuntimeSummary, threadId: string): boolean {
  return summary.activeThreads.items.some((thread) => thread.id === threadId)
    || summary.attentionThreads.items.some((thread) => thread.id === threadId);
}

function reconcileSummaryThread(
  summary: RuntimeSummary,
  thread: RuntimeSummary["activeThreads"]["items"][number],
): RuntimeSummary {
  const activeItems = summary.activeThreads.items.map((candidate) =>
    candidate.id === thread.id ? thread : candidate,
  );
  const attentionItems = thread.attention === "none"
    ? summary.attentionThreads.items.filter((candidate) => candidate.id !== thread.id)
    : summary.attentionThreads.items.map((candidate) =>
        candidate.id === thread.id ? thread : candidate,
      );
  return {
    ...summary,
    activeThreads: {
      ...summary.activeThreads,
      items: activeItems,
    },
    attentionThreads: {
      ...summary.attentionThreads,
      items: attentionItems,
    },
  };
}

export function codingAgentApprovalActionKey(threadId: string, approvalId: string): string {
  return `${threadId}:${approvalId}`;
}

export function codingAgentInputActionKey(threadId: string, inputRequestId: string): string {
  return `${threadId}:${inputRequestId}`;
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
  fileReadStatus: "idle",
  fileRead: null,
  fileReadError: null,
  fileWriteStatus: "idle",
  fileWriteError: null,
  selectedFilePath: null,
  selectedFileReference: null,
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
  inputActionStatus: "idle",
  pendingInputRequestId: null,
  inputActionError: null,
  pendingInputRequestKeys: [],
  inputActionErrors: {},
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
          ? summaryIncludesThread(summary, state.activeThreadId)
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
      ...clearFileReadState(),
    }));
    try {
      const snapshot = await invoke("runtime:get-review-snapshot", { reviewId });
      if (seq !== reviewSnapshotSeq) return;
      set({
        selectedReviewId: reviewId,
        reviewSnapshotStatus: "ready",
        reviewSnapshot: snapshot,
        reviewSnapshotError: null,
        ...clearFileReadState(),
      });
    } catch {
      console.warn("[coding-agents] review snapshot refresh failed");
      if (seq !== reviewSnapshotSeq) return;
      set({
        selectedReviewId: reviewId,
        reviewSnapshotStatus: "error",
        reviewSnapshot: null,
        reviewSnapshotError: "Review details unavailable",
        ...clearFileReadState(),
      });
    }
  },

  loadFileContent: async (request) => {
    const seq = ++fileReadSeq;
    set((state) => ({
      selectedFilePath: request.path,
      selectedFileReference: request,
      fileReadStatus: fileReferenceMatches(state.selectedFileReference, request) ? "ready" : "loading",
      fileRead: fileReferenceMatches(state.selectedFileReference, request) ? state.fileRead : null,
      fileReadError: null,
      fileWriteStatus: "idle",
      fileWriteError: null,
    }));
    try {
      const response = await invoke("runtime:get-file-content", request);
      if (seq !== fileReadSeq) return;
      set({
        selectedFilePath: request.path,
        selectedFileReference: request,
        fileReadStatus: "ready",
        fileRead: response,
        fileReadError: null,
        fileWriteStatus: "idle",
        fileWriteError: null,
      });
    } catch {
      console.warn("[coding-agents] file content load failed");
      if (seq !== fileReadSeq) return;
      set({
        selectedFilePath: request.path,
        selectedFileReference: request,
        fileReadStatus: "error",
        fileRead: null,
        fileReadError: "File content unavailable",
        fileWriteStatus: "idle",
        fileWriteError: null,
      });
    }
  },

  saveFileContent: async (request) => {
    const { fileWriteStatus } = useCodingAgentWorkspace.getState();
    if (fileWriteStatus === "saving") return;

    set({
      fileWriteStatus: "saving",
      fileWriteError: null,
    });
    try {
      const response = await invoke("runtime:save-file-content", {
        ...request,
        encoding: "utf8",
        clientRequestId: nextActionRequestId(),
      });
      set((state) => {
        const stillSelected = fileReferenceMatches(state.selectedFileReference, request);
        return {
          fileReadStatus: stillSelected ? "ready" : state.fileReadStatus,
          fileRead: stillSelected
            ? {
                metadata: response.metadata,
                content: request.content,
                encoding: "utf8" as const,
                truncated: false,
                limitBytes: state.fileRead?.limitBytes ?? response.metadata.sizeBytes,
              }
            : state.fileRead,
          fileReadError: stillSelected ? null : state.fileReadError,
          fileWriteStatus: stillSelected ? "saved" : "idle",
          fileWriteError: null,
        };
      });
    } catch {
      console.warn("[coding-agents] file content save failed");
      set((state) => {
        if (!fileReferenceMatches(state.selectedFileReference, request)) return state;
        return {
          fileWriteStatus: "error",
          fileWriteError: "File could not be saved. Refresh and try again.",
        };
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
        const summary = currentSummary ? reconcileSummaryThread(currentSummary, snapshot.thread) : currentSummary;
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

  submitInputAnswer: async ({ threadId, inputRequestId, answer, correlationId }) => {
    const inputKey = codingAgentInputActionKey(threadId, inputRequestId);
    const { pendingInputRequestKeys } = useCodingAgentWorkspace.getState();
    if (pendingInputRequestKeys.includes(inputKey)) return;

    set((state) => ({
      inputActionStatus: "submitting",
      pendingInputRequestId: inputRequestId,
      inputActionError: null,
      pendingInputRequestKeys: [...state.pendingInputRequestKeys, inputKey],
      inputActionErrors: withoutRecordKey(state.inputActionErrors, inputKey),
    }));
    try {
      const snapshot = await invoke("runtime:submit-input-answer", {
        threadId,
        inputRequestId,
        answer,
        correlationId,
        clientRequestId: nextActionRequestId(),
      });
      set((state) => {
        const currentSummary = state.summary;
        const nextPendingInputRequestKeys = state.pendingInputRequestKeys.filter((key) => key !== inputKey);
        const visibleThreadStillSelected = state.activeThreadId === snapshot.thread.id;
        const visibleSnapshot = visibleThreadStillSelected
          ? mergeSelectedThreadSnapshot(state.threadSnapshot, snapshot)
          : snapshot;
        const summary = currentSummary ? reconcileSummaryThread(currentSummary, visibleSnapshot.thread) : currentSummary;
        return {
          inputActionStatus: nextPendingInputRequestKeys.length > 0 ? "submitting" : "idle",
          pendingInputRequestId: null,
          inputActionError: null,
          pendingInputRequestKeys: nextPendingInputRequestKeys,
          inputActionErrors: withoutRecordKey(state.inputActionErrors, inputKey),
          summary,
          ...(visibleThreadStillSelected
            ? {
                threadSnapshotStatus: "ready" as const,
                threadSnapshot: visibleSnapshot,
                threadSnapshotError: null,
              }
            : {}),
        };
      });
    } catch {
      console.warn("[coding-agents] input answer failed");
      set((state) => {
        const nextPendingInputRequestKeys = state.pendingInputRequestKeys.filter((key) => key !== inputKey);
        return {
          inputActionStatus: nextPendingInputRequestKeys.length > 0 ? "submitting" : "idle",
          pendingInputRequestId: null,
          inputActionError: "Input could not be sent. Try again.",
          pendingInputRequestKeys: nextPendingInputRequestKeys,
          inputActionErrors: {
            ...state.inputActionErrors,
            [inputKey]: "Input could not be sent. Try again.",
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
