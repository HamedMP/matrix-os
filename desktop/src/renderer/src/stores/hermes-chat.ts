// The OS-agent (Hermes) conversation index and active transcript. Gateway
// conversation history is canonical; this store keeps only bounded renderer
// snapshots and live WebSocket state. Task-bound coding-agent runs remain in
// the threads/workspace stores as a separate typed source.
import {
  KernelConversationContextProjectionSchema,
  KernelConversationContextUpdateSchema,
  KernelConversationDeleteResponseSchema,
  KernelConversationHistoryResponseSchema,
  KernelConversationIdSchema,
  KernelConversationMutationErrorCodeSchema,
  KernelConversationSummarySchema,
  type GlobalChatProviderId,
  type KernelConversationContextProjection,
  isKernelResultFailureText,
} from "@matrix-os/contracts";
import { create } from "zustand";
import { z } from "zod/v4";
import { AppError } from "../../../shared/app-error";
import { reduceChat, type ChatEvent, type ChatMessage } from "../lib/chat";
import type { ApiClient } from "../lib/api";
import {
  abortKernelRequest,
  sendKernelMessage,
  switchKernelSession,
} from "../lib/kernel-wiring";
import {
  captureRuntimeGeneration,
  isCurrentRuntimeGeneration,
} from "./runtime-generation";

const TRANSCRIPT_CAP = 800;
const CONVERSATION_INDEX_CAP = 100;
const CONVERSATION_PREVIEW_CAP = 240;
const CONVERSATION_TITLE_CAP = 80;
const REPLAY_EVENT_CAP = 2_000;
const DISCONNECTED_MESSAGE = "Can't reach Matrix OS. Check your connection.";
const INDEX_ERROR_MESSAGE = "Conversations could not be loaded. Try again.";
const LOAD_ERROR_MESSAGE = "Conversation could not be opened. Try again.";
const DELETE_ERROR_MESSAGE = "Chat could not be deleted. Try again.";
const DELETE_BUSY_MESSAGE = "Stop the active response before deleting this chat.";
const DELETE_NOT_FOUND_MESSAGE = "This chat no longer exists. Chats were refreshed.";
const CONTEXT_ERROR_MESSAGE = "Project context could not be updated. Try again.";
const CONTEXT_BUSY_MESSAGE = "Stop the active response before changing its project.";
const CONTEXT_PROJECT_UNAVAILABLE_MESSAGE = "That project is unavailable. Choose another project.";
const CONTEXT_STALE_MESSAGE = "Project context is unavailable. Choose another project or remove it.";

export type HermesStatus = "idle" | "thinking" | "streaming";
export type HermesConversationView = "index" | "conversation";
export type HermesLoadStatus = "idle" | "loading" | "ready" | "error";

const ConversationCreateResponseSchema = z.strictObject({
  id: KernelConversationIdSchema,
});

const ConversationContextUpdateResponseSchema = z.strictObject({
  context: KernelConversationContextProjectionSchema.nullable(),
});

export interface HermesConversationSummary {
  id: string;
  providerId: GlobalChatProviderId;
  title: string;
  preview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  context?: KernelConversationContextProjection;
}

interface ConversationIndexSnapshot {
  conversations: HermesConversationSummary[];
  complete: boolean;
}

function normalizedPreview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, CONVERSATION_PREVIEW_CAP).trimEnd();
}

function titleFromPreview(preview: string): string {
  return preview.slice(0, CONVERSATION_TITLE_CAP).trimEnd() || "New conversation";
}

function conversationMutationCode(error: unknown) {
  if (!(error instanceof AppError)) return null;
  const parsed = KernelConversationMutationErrorCodeSchema.safeParse(error.detail);
  return parsed.success ? parsed.data : null;
}

function safeConversationDeleteMessage(error: unknown): string {
  switch (conversationMutationCode(error)) {
    case "conversation_busy":
      return DELETE_BUSY_MESSAGE;
    case "conversation_not_found":
      return DELETE_NOT_FOUND_MESSAGE;
    default:
      return DELETE_ERROR_MESSAGE;
  }
}

function safeConversationContextMessage(error: unknown): string {
  switch (conversationMutationCode(error)) {
    case "conversation_busy":
    case "project_context_conflict":
      return CONTEXT_BUSY_MESSAGE;
    case "project_unavailable":
      return CONTEXT_PROJECT_UNAVAILABLE_MESSAGE;
    case "conversation_context_unavailable":
      return CONTEXT_STALE_MESSAGE;
    default:
      return CONTEXT_ERROR_MESSAGE;
  }
}

function normalizeConversationIndexSnapshot(raw: unknown): ConversationIndexSnapshot | null {
  if (!Array.isArray(raw)) return null;
  const summaries: HermesConversationSummary[] = [];
  let complete = raw.length <= CONVERSATION_INDEX_CAP;
  for (const candidate of raw.slice(0, CONVERSATION_INDEX_CAP)) {
    const parsed = KernelConversationSummarySchema.safeParse(candidate);
    if (!parsed.success) {
      complete = false;
      continue;
    }
    const preview = normalizedPreview(parsed.data.preview);
    summaries.push({
      ...parsed.data,
      preview,
      title: titleFromPreview(preview),
    });
  }
  return {
    conversations: summaries.toSorted((left, right) =>
      right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id),
    ),
    complete,
  };
}

export function normalizeConversationIndex(raw: unknown): HermesConversationSummary[] | null {
  return normalizeConversationIndexSnapshot(raw)?.conversations ?? null;
}

function historySnapshot(
  conversationId: string,
  raw: unknown,
): { messages: ChatMessage[]; context: KernelConversationContextProjection | null; providerId: GlobalChatProviderId } | null {
  const parsed = KernelConversationHistoryResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.id !== conversationId) return null;
  return {
    providerId: parsed.data.providerId,
    context: parsed.data.context ?? null,
    messages: parsed.data.messages.map((message) => ({
      id: `${conversationId}:${message.index}`,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      ...(message.tool ? { tool: message.tool } : {}),
      ...(message.toolDisplay ? { toolDisplay: message.toolDisplay } : {}),
    })),
  };
}

interface HermesChatState {
  messages: ChatMessage[];
  sessionId: string | null;
  providerId: GlobalChatProviderId;
  status: HermesStatus;
  activeRequestId: string | null;
  view: HermesConversationView;
  conversations: HermesConversationSummary[];
  isConversationIndexComplete: boolean;
  indexStatus: HermesLoadStatus;
  indexError: string | null;
  loadStatus: HermesLoadStatus;
  loadError: string | null;
  loadingConversationId: string | null;
  deletingConversationId: string | null;
  deleteError: string | null;
  conversationContext: KernelConversationContextProjection | null;
  contextStatus: HermesLoadStatus;
  contextError: string | null;
  indexSequence: number;
  loadSequence: number;
  contextSequence: number;
  transcriptRevision: number;
  seenReplayEventIds: string[];
  send: (text: string) => void;
  abort: () => void;
  newChat: () => void;
  showIndex: () => void;
  refreshConversations: (api: ApiClient) => Promise<void>;
  createConversation: (api: ApiClient, providerId?: GlobalChatProviderId) => Promise<string | null>;
  openConversation: (api: ApiClient, id: string) => Promise<boolean>;
  refreshConversationHistory: (api: ApiClient, id: string) => Promise<boolean>;
  deleteConversation: (api: ApiClient, id: string) => Promise<boolean>;
  updateConversationContext: (
    api: ApiClient,
    id: string,
    projectId: string | null,
  ) => Promise<boolean>;
  clearDeleteError: () => void;
  resetRuntime: () => void;
  // Fed by the single kernel subscription in kernel-wiring.
  ingest: (event: ChatEvent) => boolean;
}

function nextId(): string {
  return crypto.randomUUID();
}

const UNSUCCESSFUL_RESULT_MESSAGE = "The agent could not complete this turn. Try again.";

function resultHasErrors(event: ChatEvent): boolean {
  if (event.type !== "kernel:result" || !event.data || typeof event.data !== "object") {
    return false;
  }
  const errors = Reflect.get(event.data, "errors");
  return (Array.isArray(errors) && errors.length > 0)
    || isKernelResultFailureText(Reflect.get(event.data, "result"));
}

function resultFallbackText(event: ChatEvent): string | null {
  if (event.type !== "kernel:result" || resultHasErrors(event) || !event.data || typeof event.data !== "object") {
    return null;
  }
  const result = Reflect.get(event.data, "result");
  if (typeof result !== "string") return null;
  return result.trim() || null;
}

export const useHermesChat = create<HermesChatState>()((set, get) => ({
  messages: [],
  sessionId: null,
  providerId: "claude",
  status: "idle",
  activeRequestId: null,
  view: "index",
  conversations: [],
  isConversationIndexComplete: false,
  indexStatus: "idle",
  indexError: null,
  loadStatus: "idle",
  loadError: null,
  loadingConversationId: null,
  deletingConversationId: null,
  deleteError: null,
  conversationContext: null,
  contextStatus: "idle",
  contextError: null,
  indexSequence: 0,
  loadSequence: 0,
  contextSequence: 0,
  transcriptRevision: 0,
  seenReplayEventIds: [],

  send: (text) => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || get().status !== "idle") return;
    const requestId = nextId();
    const userMessage: ChatMessage = {
      id: nextId(),
      role: "user",
      content: trimmed,
      requestId,
      timestamp: Date.now(),
    };
    set((state) => ({
      messages: [...state.messages, userMessage].slice(-TRANSCRIPT_CAP),
      status: "thinking",
      activeRequestId: requestId,
      transcriptRevision: state.transcriptRevision + 1,
    }));
    const sent = sendKernelMessage({
      text: trimmed,
      requestId,
      providerId: get().providerId,
      ...(get().sessionId ? { sessionId: get().sessionId! } : {}),
    });
    if (!sent) {
      set((state) => ({
        messages: reduceChat(state.messages, {
          type: "kernel:error",
          message: DISCONNECTED_MESSAGE,
          requestId,
        }).slice(-TRANSCRIPT_CAP),
        status: "idle",
        activeRequestId: null,
      }));
    }
  },

  abort: () => {
    const { activeRequestId } = get();
    if (!activeRequestId) return;
    const sent = abortKernelRequest(activeRequestId);
    if (!sent) {
      set({ status: "idle", activeRequestId: null });
    }
  },

  newChat: () => {
    const { activeRequestId } = get();
    if (activeRequestId) abortKernelRequest(activeRequestId);
    set((state) => ({
      messages: [],
      sessionId: null,
      status: "idle",
      activeRequestId: null,
      view: "conversation",
      loadStatus: "idle",
      loadError: null,
      loadingConversationId: null,
      conversationContext: null,
      contextStatus: "idle",
      contextError: null,
      seenReplayEventIds: [],
      transcriptRevision: state.transcriptRevision + 1,
    }));
  },

  showIndex: () => {
    // Keep sessionId while showing the index so reconnects remain attached to
    // the selected canonical conversation.
    set({ view: "index", loadStatus: "idle", loadError: null, loadingConversationId: null });
  },

  refreshConversations: async (api) => {
    const generation = captureRuntimeGeneration();
    const sequence = get().indexSequence + 1;
    const contextSequenceAtStart = get().contextSequence;
    const contextMutationActiveAtStart = get().contextStatus === "loading";
    set((state) => ({
      indexSequence: sequence,
      indexStatus: state.conversations.length === 0 ? "loading" : state.indexStatus,
      indexError: null,
    }));
    try {
      const snapshot = normalizeConversationIndexSnapshot(
        await api.get<unknown>("/api/conversations"),
      );
      if (!isCurrentRuntimeGeneration(generation) || get().indexSequence !== sequence) return;
      if (!snapshot) {
        set({ indexStatus: "error", indexError: INDEX_ERROR_MESSAGE });
        return;
      }
      set((state) => {
        const selectedSummary = state.sessionId
          ? snapshot.conversations.find(
              (conversation) => conversation.id === state.sessionId,
            )
          : undefined;
        const canApplySelectedContext =
          !contextMutationActiveAtStart
          && state.contextSequence === contextSequenceAtStart
          && state.contextStatus !== "loading";

        return {
          conversations: snapshot.conversations,
          isConversationIndexComplete: snapshot.complete,
          indexStatus: "ready",
          indexError: null,
          ...(canApplySelectedContext && selectedSummary
            ? {
                conversationContext: selectedSummary.context ?? null,
                contextStatus: "ready" as const,
                contextError: null,
              }
            : {}),
        };
      });
    } catch (error: unknown) {
      if (!isCurrentRuntimeGeneration(generation) || get().indexSequence !== sequence) return;
      console.warn("[hermes-chat] conversation index request failed", error instanceof Error ? error.name : typeof error);
      set((state) => ({
        indexStatus: state.conversations.length === 0 ? "error" : "ready",
        indexError: INDEX_ERROR_MESSAGE,
      }));
    }
  },

  createConversation: async (api, providerId = get().providerId) => {
    const generation = captureRuntimeGeneration();
    const sequence = get().loadSequence + 1;
    set({
      loadSequence: sequence,
      loadStatus: "loading",
      loadError: null,
      loadingConversationId: null,
    });
    try {
      const parsed = ConversationCreateResponseSchema.safeParse(
        await api.post<unknown>("/api/conversations", { providerId }),
      );
      if (!isCurrentRuntimeGeneration(generation) || get().loadSequence !== sequence) return null;
      if (!parsed.success) {
        set({ loadStatus: "error", loadError: LOAD_ERROR_MESSAGE });
        return null;
      }
      const activeRequestId = get().activeRequestId;
      if (activeRequestId) abortKernelRequest(activeRequestId);
      set((state) => ({
        view: "conversation",
        sessionId: parsed.data.id,
        providerId,
        messages: [],
        status: "idle",
        activeRequestId: null,
        loadStatus: "idle",
        loadError: null,
        loadingConversationId: null,
        conversationContext: null,
        contextStatus: "ready",
        contextError: null,
        seenReplayEventIds: [],
        transcriptRevision: state.transcriptRevision + 1,
      }));
      switchKernelSession(parsed.data.id);
      await get().refreshConversations(api);
      return isCurrentRuntimeGeneration(generation) ? parsed.data.id : null;
    } catch (error: unknown) {
      if (!isCurrentRuntimeGeneration(generation) || get().loadSequence !== sequence) return null;
      console.warn("[hermes-chat] conversation create failed", error instanceof Error ? error.name : typeof error);
      set({ loadStatus: "error", loadError: LOAD_ERROR_MESSAGE, loadingConversationId: null });
      return null;
    }
  },

  openConversation: async (api, id) => {
    const parsedId = KernelConversationIdSchema.safeParse(id);
    if (!parsedId.success) {
      set({ loadStatus: "error", loadError: LOAD_ERROR_MESSAGE, loadingConversationId: null });
      return false;
    }
    const generation = captureRuntimeGeneration();
    const sequence = get().loadSequence + 1;
    set({
      loadSequence: sequence,
      loadStatus: "loading",
      loadError: null,
      loadingConversationId: parsedId.data,
    });
    try {
      const snapshot = historySnapshot(
        parsedId.data,
        await api.get<unknown>(`/api/conversations/${encodeURIComponent(parsedId.data)}?limit=50`),
      );
      if (!isCurrentRuntimeGeneration(generation) || get().loadSequence !== sequence) return false;
      if (!snapshot) {
        set({ loadStatus: "error", loadError: LOAD_ERROR_MESSAGE, loadingConversationId: null });
        return false;
      }
      const previousRequestId = get().activeRequestId;
      if (previousRequestId) abortKernelRequest(previousRequestId);
      set((state) => ({
        view: "conversation",
        sessionId: parsedId.data,
        providerId: snapshot.providerId,
        messages: snapshot.messages.slice(-TRANSCRIPT_CAP),
        status: "idle",
        activeRequestId: null,
        loadStatus: "idle",
        loadError: null,
        loadingConversationId: null,
        conversationContext: snapshot.context,
        contextStatus: "ready",
        contextError: null,
        contextSequence: state.contextSequence + 1,
        seenReplayEventIds: [],
        transcriptRevision: state.transcriptRevision + 1,
      }));
      // The history endpoint excludes assistant/tool rows from an active run,
      // so its snapshot and the request-scoped active replay are disjoint.
      // Completed replay stays suppressed; if the run settles between this
      // snapshot and attachment, the Gateway ack requests a canonical refresh.
      switchKernelSession(parsedId.data, { replayCompleted: false });
      return true;
    } catch (error: unknown) {
      if (!isCurrentRuntimeGeneration(generation) || get().loadSequence !== sequence) return false;
      console.warn("[hermes-chat] conversation load failed", error instanceof Error ? error.name : typeof error);
      set({ loadStatus: "error", loadError: LOAD_ERROR_MESSAGE, loadingConversationId: null });
      return false;
    }
  },

  refreshConversationHistory: async (api, id) => {
    const parsedId = KernelConversationIdSchema.safeParse(id);
    if (!parsedId.success || get().sessionId !== parsedId.data) return false;
    const generation = captureRuntimeGeneration();
    const revision = get().transcriptRevision;
    try {
      const snapshot = historySnapshot(
        parsedId.data,
        await api.get<unknown>(`/api/conversations/${encodeURIComponent(parsedId.data)}?limit=50`),
      );
      const state = get();
      if (
        !snapshot
        || !isCurrentRuntimeGeneration(generation)
        || state.sessionId !== parsedId.data
        || state.transcriptRevision !== revision
      ) {
        return false;
      }
      set((current) => ({
        messages: snapshot.messages.slice(-TRANSCRIPT_CAP),
        status: "idle",
        activeRequestId: null,
        seenReplayEventIds: [],
        transcriptRevision: current.transcriptRevision + 1,
      }));
      return true;
    } catch (error: unknown) {
      console.warn(
        "[hermes-chat] conversation history refresh failed",
        error instanceof Error ? error.name : typeof error,
      );
      return false;
    }
  },

  deleteConversation: async (api, id) => {
    const parsedId = KernelConversationIdSchema.safeParse(id);
    if (!parsedId.success || get().deletingConversationId) {
      if (!parsedId.success) set({ deleteError: DELETE_ERROR_MESSAGE });
      return false;
    }

    const generation = captureRuntimeGeneration();
    set({ deletingConversationId: parsedId.data, deleteError: null });
    try {
      const response = KernelConversationDeleteResponseSchema.safeParse(
        await api.delete<unknown>(
          `/api/conversations/${encodeURIComponent(parsedId.data)}`,
        ),
      );
      if (!isCurrentRuntimeGeneration(generation)) return false;
      if (!response.success) throw new AppError("server");

      set((state) => {
        const deletedSelectedConversation = state.sessionId === parsedId.data;
        return {
          conversations: state.conversations.filter((item) => item.id !== parsedId.data),
          deletingConversationId: null,
          deleteError: null,
          ...(deletedSelectedConversation
            ? {
                sessionId: null,
                messages: [],
                status: "idle" as const,
                activeRequestId: null,
                view: "index" as const,
                loadStatus: "idle" as const,
                loadError: null,
                loadingConversationId: null,
                conversationContext: null,
                contextStatus: "idle" as const,
                contextError: null,
                seenReplayEventIds: [],
                transcriptRevision: state.transcriptRevision + 1,
              }
            : {}),
        };
      });
      return true;
    } catch (error: unknown) {
      if (!isCurrentRuntimeGeneration(generation)) return false;
      const code = conversationMutationCode(error);
      if (!code) {
        console.warn(
          "[hermes-chat] conversation delete failed",
          error instanceof Error ? error.name : typeof error,
        );
      }
      set({
        deletingConversationId: null,
        deleteError: safeConversationDeleteMessage(error),
      });
      if (code === "conversation_not_found") {
        await get().refreshConversations(api);
      }
      return false;
    }
  },

  updateConversationContext: async (api, id, projectId) => {
    const parsedId = KernelConversationIdSchema.safeParse(id);
    const parsedUpdate = KernelConversationContextUpdateSchema.safeParse({ projectId });
    if (!parsedId.success || !parsedUpdate.success || get().contextStatus === "loading") {
      if (!parsedId.success || !parsedUpdate.success) {
        set({ contextStatus: "error", contextError: CONTEXT_ERROR_MESSAGE });
      }
      return false;
    }

    const generation = captureRuntimeGeneration();
    const selectedSessionId = get().sessionId;
    const sequence = get().contextSequence + 1;
    set({ contextSequence: sequence, contextStatus: "loading", contextError: null });
    try {
      const response = ConversationContextUpdateResponseSchema.safeParse(
        await api.patch<unknown>(
          `/api/conversations/${encodeURIComponent(parsedId.data)}/context`,
          parsedUpdate.data,
        ),
      );
      if (
        !isCurrentRuntimeGeneration(generation)
        || get().contextSequence !== sequence
        || get().sessionId !== selectedSessionId
      ) return false;
      if (!response.success) throw new AppError("server");

      set((state) => ({
        conversationContext: response.data.context,
        contextStatus: "ready",
        contextError: null,
        conversations: state.conversations.map((conversation) =>
          conversation.id === parsedId.data
            ? { ...conversation, context: response.data.context ?? undefined }
            : conversation,
        ),
      }));
      return true;
    } catch (error: unknown) {
      if (
        !isCurrentRuntimeGeneration(generation)
        || get().contextSequence !== sequence
        || get().sessionId !== selectedSessionId
      ) return false;
      if (!conversationMutationCode(error)) {
        console.warn(
          "[hermes-chat] conversation context update failed",
          error instanceof Error ? error.name : typeof error,
        );
      }
      set({ contextStatus: "error", contextError: safeConversationContextMessage(error) });
      return false;
    }
  },

  clearDeleteError: () => {
    set({ deleteError: null });
  },

  resetRuntime: () => {
    set((state) => ({
      messages: [],
      sessionId: null,
      providerId: "claude",
      status: "idle",
      activeRequestId: null,
      view: "index",
      conversations: [],
      isConversationIndexComplete: false,
      indexStatus: "idle",
      indexError: null,
      loadStatus: "idle",
      loadError: null,
      loadingConversationId: null,
      deletingConversationId: null,
      deleteError: null,
      conversationContext: null,
      contextStatus: "idle",
      contextError: null,
      indexSequence: state.indexSequence + 1,
      loadSequence: state.loadSequence + 1,
      contextSequence: state.contextSequence + 1,
      transcriptRevision: state.transcriptRevision + 1,
      seenReplayEventIds: [],
    }));
  },

  ingest: (event) => {
    const state = get();
    const eventId = event.eventId;
    if (eventId && state.seenReplayEventIds.includes(eventId)) return false;

    let activeRequestId = state.activeRequestId;
    if (event.type === "kernel:init" && event.requestId) {
      const belongsToSentRequest = activeRequestId === event.requestId;
      const belongsToSelectedReplay = !activeRequestId && state.sessionId === event.sessionId;
      if (!belongsToSentRequest && !belongsToSelectedReplay) return false;
      activeRequestId = event.requestId;
      set({
        sessionId: event.sessionId,
        ...(event.providerId === "claude" || event.providerId === "codex"
          ? { providerId: event.providerId }
          : {}),
        activeRequestId,
        status: "thinking",
      });
    }
    // Only fold events for the selected conversation's in-flight request.
    if (!activeRequestId || event.requestId !== activeRequestId) return false;

    set((state) => {
      const seenReplayEventIds = eventId
        ? [...state.seenReplayEventIds, eventId].slice(-REPLAY_EVENT_CAP)
        : state.seenReplayEventIds;
      // Agent SDK unsuccessful results arrive as terminal `kernel:result`
      // frames whose data contains provider errors. Keep those details out of
      // renderer state while making the otherwise silent failed turn visible.
      const fallbackText = resultFallbackText(event);
      const alreadyStreamed = event.requestId
        ? state.messages.some((message) => (
            message.requestId === event.requestId
            && message.role === "assistant"
            && !message.tool
          ))
        : false;
      const presentationEvent: ChatEvent = resultHasErrors(event)
        ? {
            type: "kernel:error",
            message: UNSUCCESSFUL_RESULT_MESSAGE,
            ...(event.requestId ? { requestId: event.requestId } : {}),
          }
        : fallbackText && !alreadyStreamed
          ? {
              type: "kernel:text",
              text: fallbackText,
              ...(event.requestId ? { requestId: event.requestId } : {}),
            }
        : event;
      const messages = reduceChat(state.messages, presentationEvent).slice(-TRANSCRIPT_CAP);
      let status = state.status;
      let active: string | null = state.activeRequestId;
      if (event.type === "kernel:text") status = "streaming";
      if (event.type === "kernel:result" || event.type === "kernel:error" || event.type === "kernel:aborted") {
        status = "idle";
        active = null;
      }
      return {
        messages,
        status,
        activeRequestId: active,
        seenReplayEventIds,
        transcriptRevision: state.transcriptRevision + 1,
      };
    });
    return true;
  },
}));
