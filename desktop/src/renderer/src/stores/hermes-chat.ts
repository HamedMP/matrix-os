// The OS-agent (Hermes) conversation index and active transcript. Gateway
// conversation history is canonical; this store keeps only bounded renderer
// snapshots and live WebSocket state. Task-bound coding-agent runs remain in
// the threads/workspace stores as a separate typed source.
import {
  KernelConversationHistoryResponseSchema,
  KernelConversationIdSchema,
} from "@matrix-os/contracts";
import { create } from "zustand";
import { z } from "zod/v4";
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

export type HermesStatus = "idle" | "thinking" | "streaming";
export type HermesConversationView = "index" | "conversation";
export type HermesLoadStatus = "idle" | "loading" | "ready" | "error";

const ConversationSummaryWireSchema = z.strictObject({
  id: KernelConversationIdSchema,
  preview: z.string(),
  messageCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const ConversationCreateResponseSchema = z.strictObject({
  id: KernelConversationIdSchema,
});

export interface HermesConversationSummary {
  id: string;
  title: string;
  preview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

function normalizedPreview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, CONVERSATION_PREVIEW_CAP).trimEnd();
}

function titleFromPreview(preview: string): string {
  return preview.slice(0, CONVERSATION_TITLE_CAP).trimEnd() || "New conversation";
}

export function normalizeConversationIndex(raw: unknown): HermesConversationSummary[] | null {
  if (!Array.isArray(raw)) return null;
  const summaries: HermesConversationSummary[] = [];
  for (const candidate of raw.slice(0, CONVERSATION_INDEX_CAP)) {
    const parsed = ConversationSummaryWireSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const preview = normalizedPreview(parsed.data.preview);
    summaries.push({
      ...parsed.data,
      preview,
      title: titleFromPreview(preview),
    });
  }
  return summaries.toSorted((left, right) =>
    right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  );
}

function historyMessages(
  conversationId: string,
  raw: unknown,
): ChatMessage[] | null {
  const parsed = KernelConversationHistoryResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.id !== conversationId) return null;
  return parsed.data.messages.map((message) => ({
    id: `${conversationId}:${message.index}`,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    ...(message.tool ? { tool: message.tool } : {}),
  }));
}

interface HermesChatState {
  messages: ChatMessage[];
  sessionId: string | null;
  status: HermesStatus;
  activeRequestId: string | null;
  view: HermesConversationView;
  conversations: HermesConversationSummary[];
  indexStatus: HermesLoadStatus;
  indexError: string | null;
  loadStatus: HermesLoadStatus;
  loadError: string | null;
  loadingConversationId: string | null;
  indexSequence: number;
  loadSequence: number;
  seenReplayEventIds: string[];
  send: (text: string) => void;
  abort: () => void;
  newChat: () => void;
  showIndex: () => void;
  refreshConversations: (api: ApiClient) => Promise<void>;
  createConversation: (api: ApiClient) => Promise<string | null>;
  openConversation: (api: ApiClient, id: string) => Promise<boolean>;
  resetRuntime: () => void;
  // Fed by the single kernel subscription in kernel-wiring.
  ingest: (event: ChatEvent) => boolean;
}

function nextId(): string {
  return crypto.randomUUID();
}

export const useHermesChat = create<HermesChatState>()((set, get) => ({
  messages: [],
  sessionId: null,
  status: "idle",
  activeRequestId: null,
  view: "index",
  conversations: [],
  indexStatus: "idle",
  indexError: null,
  loadStatus: "idle",
  loadError: null,
  loadingConversationId: null,
  indexSequence: 0,
  loadSequence: 0,
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
    }));
    const sent = sendKernelMessage({
      text: trimmed,
      requestId,
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
    set({
      messages: [],
      sessionId: null,
      status: "idle",
      activeRequestId: null,
      view: "conversation",
      loadStatus: "idle",
      loadError: null,
      loadingConversationId: null,
      seenReplayEventIds: [],
    });
  },

  showIndex: () => {
    // Keep sessionId while showing the index so reconnects remain attached to
    // the selected canonical conversation.
    set({ view: "index", loadStatus: "idle", loadError: null, loadingConversationId: null });
  },

  refreshConversations: async (api) => {
    const generation = captureRuntimeGeneration();
    const sequence = get().indexSequence + 1;
    set((state) => ({
      indexSequence: sequence,
      indexStatus: state.conversations.length === 0 ? "loading" : state.indexStatus,
      indexError: null,
    }));
    try {
      const normalized = normalizeConversationIndex(await api.get<unknown>("/api/conversations"));
      if (!isCurrentRuntimeGeneration(generation) || get().indexSequence !== sequence) return;
      if (!normalized) {
        set({ indexStatus: "error", indexError: INDEX_ERROR_MESSAGE });
        return;
      }
      set({ conversations: normalized, indexStatus: "ready", indexError: null });
    } catch (error: unknown) {
      if (!isCurrentRuntimeGeneration(generation) || get().indexSequence !== sequence) return;
      console.warn("[hermes-chat] conversation index request failed", error instanceof Error ? error.name : typeof error);
      set((state) => ({
        indexStatus: state.conversations.length === 0 ? "error" : "ready",
        indexError: INDEX_ERROR_MESSAGE,
      }));
    }
  },

  createConversation: async (api) => {
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
        await api.post<unknown>("/api/conversations", {}),
      );
      if (!isCurrentRuntimeGeneration(generation) || get().loadSequence !== sequence) return null;
      if (!parsed.success) {
        set({ loadStatus: "error", loadError: LOAD_ERROR_MESSAGE });
        return null;
      }
      const activeRequestId = get().activeRequestId;
      if (activeRequestId) abortKernelRequest(activeRequestId);
      set({
        view: "conversation",
        sessionId: parsed.data.id,
        messages: [],
        status: "idle",
        activeRequestId: null,
        loadStatus: "idle",
        loadError: null,
        loadingConversationId: null,
        seenReplayEventIds: [],
      });
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
      const messages = historyMessages(
        parsedId.data,
        await api.get<unknown>(`/api/conversations/${encodeURIComponent(parsedId.data)}?limit=50`),
      );
      if (!isCurrentRuntimeGeneration(generation) || get().loadSequence !== sequence) return false;
      if (!messages) {
        set({ loadStatus: "error", loadError: LOAD_ERROR_MESSAGE, loadingConversationId: null });
        return false;
      }
      const previousRequestId = get().activeRequestId;
      if (previousRequestId) abortKernelRequest(previousRequestId);
      set({
        view: "conversation",
        sessionId: parsedId.data,
        messages: messages.slice(-TRANSCRIPT_CAP),
        status: "idle",
        activeRequestId: null,
        loadStatus: "idle",
        loadError: null,
        loadingConversationId: null,
        seenReplayEventIds: [],
      });
      switchKernelSession(parsedId.data);
      return true;
    } catch (error: unknown) {
      if (!isCurrentRuntimeGeneration(generation) || get().loadSequence !== sequence) return false;
      console.warn("[hermes-chat] conversation load failed", error instanceof Error ? error.name : typeof error);
      set({ loadStatus: "error", loadError: LOAD_ERROR_MESSAGE, loadingConversationId: null });
      return false;
    }
  },

  resetRuntime: () => {
    set((state) => ({
      messages: [],
      sessionId: null,
      status: "idle",
      activeRequestId: null,
      view: "index",
      conversations: [],
      indexStatus: "idle",
      indexError: null,
      loadStatus: "idle",
      loadError: null,
      loadingConversationId: null,
      indexSequence: state.indexSequence + 1,
      loadSequence: state.loadSequence + 1,
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
      const messages = reduceChat(state.messages, event).slice(-TRANSCRIPT_CAP);
      let status = state.status;
      let active: string | null = state.activeRequestId;
      if (event.type === "kernel:text") status = "streaming";
      if (event.type === "kernel:result" || event.type === "kernel:error" || event.type === "kernel:aborted") {
        status = "idle";
        active = null;
      }
      return { messages, status, activeRequestId: active, seenReplayEventIds };
    });
    return true;
  },
}));
