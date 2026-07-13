import {
  buildCreateAgentThreadRequestFromComposer,
  type AgentThreadEvent,
  type AgentThreadSummary,
  type ApprovalDecisionRequest,
  type AgentThreadSnapshot,
  type AgentThreadComposerDraft,
  type CodingAgentNotificationPreferences,
  type CodingAgentNotificationPreferencesUpdate,
  type FileReadRequest,
  type FileReadResponse,
  type FileWriteRequest,
  type ReviewSnapshot,
  type ReviewSummary,
  type RuntimeSummary,
  type SourceControlCreatePullRequestRequest,
  type SourceControlCreatePullRequestResponse,
  type SourceControlPrepareCommitRequest,
  type SourceControlPrepareCommitResponse,
  type UserInputAnswerRequest,
} from "@matrix-os/contracts";
import { create } from "zustand";
import { invoke, onEvent } from "../lib/operator";

type WorkspaceStatus = "idle" | "loading" | "ready" | "error";
type ReviewStatus = "idle" | "loading" | "ready" | "error";
type FileReadStatus = "idle" | "loading" | "ready" | "error";
type FileWriteStatus = "idle" | "saving" | "saved" | "error";
type SourceCommitStatus = "idle" | "preparing" | "prepared" | "error";
type SourcePullRequestStatus = "idle" | "creating" | "ready" | "error";
type NotificationPreferencesStatus = "idle" | "loading" | "ready" | "saving" | "error";
type CreateStatus = "idle" | "submitting";
type ActionStatus = "idle" | "submitting";
type AgentThreadSnapshotEvent = AgentThreadSnapshot["events"]["items"][number];
type FileReference = Pick<FileReadRequest, "projectId" | "worktreeId" | "path">;
type AttentionPushPreferences = CodingAgentNotificationPreferences["attentionPush"];
type ReviewSummaryList = {
  items: ReviewSummary[];
  hasMore: boolean;
  nextCursor?: string;
  limit: number;
};

const MAX_LOCAL_CREATED_THREAD_HANDLES = 10;

interface CodingAgentWorkspaceState {
  status: WorkspaceStatus;
  summary: RuntimeSummary | null;
  error: string | null;
  notificationPreferencesStatus: NotificationPreferencesStatus;
  notificationPreferences: CodingAgentNotificationPreferences | null;
  notificationPreferencesError: string | null;
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
  sourceCommitStatus: SourceCommitStatus;
  sourceCommit: SourceControlPrepareCommitResponse | null;
  sourceCommitError: string | null;
  sourcePullRequestStatus: SourcePullRequestStatus;
  sourcePullRequest: SourceControlCreatePullRequestResponse | null;
  sourcePullRequestError: string | null;
  selectedFilePath: string | null;
  selectedFileReference: FileReference | null;
  threadSnapshotStatus: ReviewStatus;
  threadSnapshot: AgentThreadSnapshot | null;
  threadSnapshotError: string | null;
  createStatus: CreateStatus;
  createError: string | null;
  composerFocusRequestId: number;
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
  createdThreadHandles: AgentThreadSummary[];
  refresh: () => Promise<void>;
  loadNotificationPreferences: () => Promise<void>;
  updateNotificationPreferences: (request: { attentionPush: Partial<AttentionPushPreferences> }) => Promise<void>;
  selectReview: (reviewId: string) => Promise<void>;
  loadFileContent: (request: FileReadRequest) => Promise<void>;
  saveFileContent: (request: Omit<FileWriteRequest, "encoding" | "clientRequestId">) => Promise<void>;
  prepareSourceCommit: (request: Omit<SourceControlPrepareCommitRequest, "clientRequestId">) => Promise<void>;
  createSourcePullRequest: (request: Omit<SourceControlCreatePullRequestRequest, "clientRequestId">) => Promise<void>;
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
  requestComposerFocus: () => void;
  createThread: (draft: AgentThreadComposerDraft) => Promise<string | null>;
}

let refreshSeq = 0;
let reviewsSeq = 0;
let reviewSnapshotSeq = 0;
let fileReadSeq = 0;
let threadSnapshotSeq = 0;
let notificationPreferencesSeq = 0;
let notificationPreferencesSaveActive = false;
let pendingNotificationPreferencePatch: Partial<AttentionPushPreferences> = {};
let createRequestSeq = 0;
let actionRequestSeq = 0;
let activeThreadEventSubscription: (() => void) | null = null;
let activeThreadEventSubscriptionId: string | null = null;

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
    sourceCommitStatus: "idle" as const,
    sourceCommit: null,
    sourceCommitError: null,
    sourcePullRequestStatus: "idle" as const,
    sourcePullRequest: null,
    sourcePullRequestError: null,
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

function attentionForThreadStatus(status: AgentThreadSummary["status"]): AgentThreadSummary["attention"] {
  switch (status) {
    case "waiting_for_approval":
      return "approval_required";
    case "waiting_for_input":
      return "input_required";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
    default:
      return "none";
  }
}

function reduceThreadSummaryEvent(
  thread: AgentThreadSummary,
  event: AgentThreadEvent,
): AgentThreadSummary {
  if (event.threadId !== thread.id) return thread;
  const updatedAt = latestIsoTimestamp(thread.updatedAt, event.occurredAt);
  switch (event.type) {
    case "thread.status":
      return { ...thread, status: event.status, attention: attentionForThreadStatus(event.status), updatedAt };
    case "approval.requested":
      return { ...thread, status: "waiting_for_approval", attention: "approval_required", updatedAt };
    case "approval.resolved":
      return { ...thread, status: "running", attention: "none", updatedAt };
    case "user_input.requested":
      return { ...thread, status: "waiting_for_input", attention: "input_required", updatedAt };
    case "user_input.answered":
      return { ...thread, status: "running", attention: "none", updatedAt };
    case "thread.error":
      return { ...thread, status: "failed", attention: "failed", updatedAt };
    case "thread.completed":
      return {
        ...thread,
        status: event.outcome,
        attention: event.outcome === "completed" ? "completed" : event.outcome === "failed" ? "failed" : "none",
        updatedAt,
      };
    default:
      return { ...thread, updatedAt };
  }
}

function latestIsoTimestamp(a: string, b: string): string {
  return a.localeCompare(b) >= 0 ? a : b;
}

function mergeLiveThreadEvent(
  current: AgentThreadSnapshot,
  event: AgentThreadEvent,
): AgentThreadSnapshot {
  if (event.threadId !== current.thread.id) return current;
  const existing = new Map(current.events.items.map((item) => [item.eventId, item]));
  existing.set(event.eventId, event);
  const limit = current.events.limit;
  const items = Array.from(existing.values())
    .sort(compareThreadEvents)
    .slice(-limit);
  return {
    ...current,
    thread: event.occurredAt.localeCompare(current.thread.updatedAt) >= 0
      ? reduceThreadSummaryEvent(current.thread, event)
      : current.thread,
    events: {
      ...current.events,
      items,
    },
  };
}

function detachActiveThreadEventStream(): void {
  const threadId = activeThreadEventSubscriptionId;
  activeThreadEventSubscription?.();
  activeThreadEventSubscription = null;
  activeThreadEventSubscriptionId = null;
  if (!threadId) return;
  void invoke("runtime:unsubscribe-thread-events", { threadId }).catch(() => {
    console.warn("[coding-agents] thread stream detach failed");
  });
}

function attachActiveThreadEventStream(snapshot: AgentThreadSnapshot): void {
  const threadId = snapshot.thread.id;
  if (activeThreadEventSubscriptionId === threadId) return;
  detachActiveThreadEventStream();
  activeThreadEventSubscriptionId = threadId;
  const detachEventListener = onEvent("runtime:thread-event", (payload) => {
    if (payload.threadId !== activeThreadEventSubscriptionId) return;
    useCodingAgentWorkspace.setState((state) => {
      if (state.activeThreadId !== payload.threadId || state.threadSnapshot?.thread.id !== payload.threadId) return {};
      const threadSnapshot = mergeLiveThreadEvent(state.threadSnapshot, payload.event);
      return {
        threadSnapshot,
        threadSnapshotError: null,
        summary: state.summary ? reconcileSummaryThread(state.summary, threadSnapshot.thread) : state.summary,
      };
    });
  });
  const detachErrorListener = onEvent("runtime:thread-stream-error", (payload) => {
    if (payload.threadId !== activeThreadEventSubscriptionId) return;
    void useCodingAgentWorkspace.getState().loadThreadSnapshot(payload.threadId);
  });
  activeThreadEventSubscription = () => {
    detachEventListener();
    detachErrorListener();
  };
  const cursor = snapshot.events.nextCursor ?? snapshot.events.items.at(-1)?.eventId;
  void invoke("runtime:subscribe-thread-events", {
    threadId,
    ...(cursor ? { cursor } : {}),
  }).catch(() => {
    console.warn("[coding-agents] thread stream unavailable");
    if (activeThreadEventSubscriptionId === threadId) {
      activeThreadEventSubscription?.();
      activeThreadEventSubscription = null;
      activeThreadEventSubscriptionId = null;
    }
  });
}

export function codingAgentApprovalActionKey(threadId: string, approvalId: string): string {
  return `${threadId}:${approvalId}`;
}

export function codingAgentInputActionKey(threadId: string, inputRequestId: string): string {
  return `${threadId}:${inputRequestId}`;
}

async function flushNotificationPreferenceUpdates(): Promise<void> {
  if (notificationPreferencesSaveActive) return;
  notificationPreferencesSaveActive = true;
  try {
    while (Object.keys(pendingNotificationPreferencePatch).length > 0) {
      const patch = pendingNotificationPreferencePatch;
      pendingNotificationPreferencePatch = {};
      const previous = useCodingAgentWorkspace.getState().notificationPreferences;
      useCodingAgentWorkspace.setState({
        notificationPreferencesStatus: "saving",
        notificationPreferencesError: null,
      });
      try {
        const latest = await invoke("runtime:get-notification-preferences", {});
        const preferences = await invoke("runtime:update-notification-preferences", {
          attentionPush: {
            ...latest.attentionPush,
            ...patch,
          },
        } satisfies CodingAgentNotificationPreferencesUpdate);
        useCodingAgentWorkspace.setState({
          notificationPreferencesStatus: "ready",
          notificationPreferences: preferences,
          notificationPreferencesError: null,
        });
      } catch {
        console.warn("[coding-agents] notification preferences update failed");
        pendingNotificationPreferencePatch = {};
        useCodingAgentWorkspace.setState({
          notificationPreferencesStatus: "error",
          notificationPreferences: previous,
          notificationPreferencesError: "Notification settings could not be saved. Try again.",
        });
        return;
      }
    }
  } finally {
    notificationPreferencesSaveActive = false;
  }
  if (Object.keys(pendingNotificationPreferencePatch).length > 0) {
    await flushNotificationPreferenceUpdates();
  }
}

export const useCodingAgentWorkspace = create<CodingAgentWorkspaceState>()((set) => ({
  status: "idle",
  summary: null,
  error: null,
  notificationPreferencesStatus: "idle",
  notificationPreferences: null,
  notificationPreferencesError: null,
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
  sourceCommitStatus: "idle",
  sourceCommit: null,
  sourceCommitError: null,
  sourcePullRequestStatus: "idle",
  sourcePullRequest: null,
  sourcePullRequestError: null,
  selectedFilePath: null,
  selectedFileReference: null,
  threadSnapshotStatus: "idle",
  threadSnapshot: null,
  threadSnapshotError: null,
  createStatus: "idle",
  createError: null,
  composerFocusRequestId: 0,
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
  createdThreadHandles: [],

  refresh: async () => {
    const seq = ++refreshSeq;
    set((state) => ({
      status: state.summary ? "ready" : "loading",
      error: null,
    }));
    try {
      const summary = await invoke("runtime:get-summary", {});
      if (seq !== refreshSeq) return;
      const workspaceState = useCodingAgentWorkspace.getState();
      const activeThreadId = workspaceState.activeThreadId;
      const localCreatedThreadStillSelected = activeThreadId
        ? workspaceState.createdThreadHandles.some((thread) => thread.id === activeThreadId)
          && workspaceState.threadSnapshot?.thread.id === activeThreadId
        : false;
      const activeThreadStillPresent = activeThreadId
        ? summaryIncludesThread(summary, activeThreadId) || localCreatedThreadStillSelected
        : true;
      if (!activeThreadStillPresent) {
        detachActiveThreadEventStream();
      }
      set((state) => {
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

  loadNotificationPreferences: async () => {
    const seq = ++notificationPreferencesSeq;
    set((state) => ({
      notificationPreferencesStatus: state.notificationPreferences ? "ready" : "loading",
      notificationPreferencesError: null,
    }));
    try {
      const preferences = await invoke("runtime:get-notification-preferences", {});
      if (seq !== notificationPreferencesSeq) return;
      set({
        notificationPreferencesStatus: "ready",
        notificationPreferences: preferences,
        notificationPreferencesError: null,
      });
    } catch {
      console.warn("[coding-agents] notification preferences refresh failed");
      if (seq !== notificationPreferencesSeq) return;
      set({
        notificationPreferencesStatus: "error",
        notificationPreferencesError: "Notification settings unavailable",
      });
    }
  },

  updateNotificationPreferences: async (request) => {
    pendingNotificationPreferencePatch = {
      ...pendingNotificationPreferencePatch,
      ...request.attentionPush,
    };
    set((state) => ({
      notificationPreferencesStatus: "saving",
      notificationPreferences: state.notificationPreferences
        ? {
            ...state.notificationPreferences,
            attentionPush: {
              ...state.notificationPreferences.attentionPush,
              ...request.attentionPush,
            },
          }
        : state.notificationPreferences,
      notificationPreferencesError: null,
    }));
    await flushNotificationPreferenceUpdates();
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
        if (!stillSelected) return state;
        return {
          fileReadStatus: "ready",
          fileRead: {
            metadata: response.metadata,
            content: request.content,
            encoding: "utf8" as const,
            truncated: false,
            limitBytes: state.fileRead?.limitBytes ?? response.metadata.sizeBytes,
          },
          fileReadError: null,
          fileWriteStatus: "saved",
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

  prepareSourceCommit: async (request) => {
    const { sourceCommitStatus, reviewSnapshot } = useCodingAgentWorkspace.getState();
    if (sourceCommitStatus === "preparing") return;
    const initiatingReviewId = reviewSnapshot?.review.id ?? null;
    if (!initiatingReviewId) return;

    set({
      sourceCommitStatus: "preparing",
      sourceCommit: null,
      sourceCommitError: null,
    });
    try {
      const response = await invoke("runtime:prepare-source-commit", {
        ...request,
        clientRequestId: nextActionRequestId(),
      });
      set((state) => {
        const selectedReview = state.reviewSnapshot?.review;
        if (
          !selectedReview
          || selectedReview.id !== initiatingReviewId
          || selectedReview.projectId !== request.projectId
          || selectedReview.worktreeId !== request.worktreeId
        ) {
          return state;
        }
        return {
          sourceCommitStatus: "prepared",
          sourceCommit: response,
          sourceCommitError: null,
        };
      });
    } catch {
      console.warn("[coding-agents] source commit prepare failed");
      set((state) => {
        const selectedReview = state.reviewSnapshot?.review;
        if (
          !selectedReview
          || selectedReview.id !== initiatingReviewId
          || selectedReview.projectId !== request.projectId
          || selectedReview.worktreeId !== request.worktreeId
        ) {
          return state;
        }
        return {
          sourceCommitStatus: "error",
          sourceCommit: null,
          sourceCommitError: "Source commit could not be prepared. Refresh and try again.",
        };
      });
    }
  },

  createSourcePullRequest: async (request) => {
    const { sourcePullRequestStatus, reviewSnapshot } = useCodingAgentWorkspace.getState();
    if (sourcePullRequestStatus === "creating") return;
    const initiatingReviewId = reviewSnapshot?.review.id ?? null;
    if (!initiatingReviewId) return;

    set({
      sourcePullRequestStatus: "creating",
      sourcePullRequest: null,
      sourcePullRequestError: null,
    });
    try {
      const response = await invoke("runtime:create-source-pull-request", {
        ...request,
        clientRequestId: nextActionRequestId(),
      });
      set((state) => {
        const selectedReview = state.reviewSnapshot?.review;
        if (
          !selectedReview
          || selectedReview.id !== initiatingReviewId
          || selectedReview.projectId !== request.projectId
          || selectedReview.worktreeId !== request.worktreeId
        ) {
          return state;
        }
        return {
          sourcePullRequestStatus: "ready",
          sourcePullRequest: response,
          sourcePullRequestError: null,
        };
      });
    } catch {
      console.warn("[coding-agents] source pull request create failed");
      set((state) => {
        const selectedReview = state.reviewSnapshot?.review;
        if (
          !selectedReview
          || selectedReview.id !== initiatingReviewId
          || selectedReview.projectId !== request.projectId
          || selectedReview.worktreeId !== request.worktreeId
        ) {
          return state;
        }
        return {
          sourcePullRequestStatus: "error",
          sourcePullRequest: null,
          sourcePullRequestError: "Pull request could not be created. Refresh and try again.",
        };
      });
    }
  },

  loadThreadSnapshot: async (threadId) => {
    const seq = ++threadSnapshotSeq;
    detachActiveThreadEventStream();
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
      attachActiveThreadEventStream(snapshot);
    } catch {
      console.warn("[coding-agents] thread snapshot refresh failed");
      if (seq !== threadSnapshotSeq) return;
      detachActiveThreadEventStream();
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

  requestComposerFocus: () => {
    set((state) => ({ composerFocusRequestId: state.composerFocusRequestId + 1 }));
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
        const createdThreadHandles = [
          thread,
          ...state.createdThreadHandles.filter((candidate) => candidate.id !== thread.id),
        ].slice(0, MAX_LOCAL_CREATED_THREAD_HANDLES);
        const currentSummary = state.summary;
        if (!currentSummary) {
          return {
            createStatus: "idle",
            activeThreadId: thread.id,
            createdThreadHandles,
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
          createdThreadHandles,
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
