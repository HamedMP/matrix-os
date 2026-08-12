// The OS-agent (Hermes) conversation — a single continuous chat, distinct from
// task-bound agent runs (which live in the threads store). Sends over the
// kernel WS and reduces streamed events into one transcript. The kernel keeps
// the session alive via sessionId; "New chat" starts a fresh session.
import { create } from "zustand";
import { reduceChat, type ChatEvent, type ChatMessage } from "../lib/chat";
import { abortKernelRequest, sendKernelMessage } from "../lib/kernel-wiring";

const TRANSCRIPT_CAP = 800;
const DISCONNECTED_MESSAGE = "Can't reach Matrix OS. Check your connection.";

export type HermesStatus = "idle" | "thinking" | "streaming";

interface HermesChatState {
  messages: ChatMessage[];
  sessionId: string | null;
  status: HermesStatus;
  activeRequestId: string | null;
  send: (text: string) => void;
  abort: () => void;
  newChat: () => void;
  // Fed by the single kernel subscription in kernel-wiring.
  ingest: (event: ChatEvent) => void;
}

function nextId(): string {
  return crypto.randomUUID();
}

export const useHermesChat = create<HermesChatState>()((set, get) => ({
  messages: [],
  sessionId: null,
  status: "idle",
  activeRequestId: null,

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
    set({ messages: [], sessionId: null, status: "idle", activeRequestId: null });
  },

  ingest: (event) => {
    const { activeRequestId, messages } = get();
    const matchesActiveRequest = Boolean(
      activeRequestId && event.requestId === activeRequestId,
    );
    // Only the current request may bind a resumable session. A late init from
    // an aborted request must not resurrect the conversation after New.
    if (event.type === "kernel:init") {
      if (matchesActiveRequest && event.sessionId) {
        set({ sessionId: event.sessionId });
      }
      return;
    }
    // A provider can emit a terminal-looking result before its process exits
    // unsuccessfully. Preserve a later error when it belongs to a request that
    // is still visible, while ignoring stale errors after New clears the chat.
    const matchesVisibleCompletedRequest = event.type === "kernel:error"
      && typeof event.requestId === "string"
      && messages.some((message) => (
        message.role === "user" && message.requestId === event.requestId
      ))
      && !messages.some((message) => (
        message.role === "system"
        && !message.tool
        && message.requestId === event.requestId
      ));
    if (!matchesActiveRequest && !matchesVisibleCompletedRequest) return;

    set((state) => {
      const messages = reduceChat(state.messages, event).slice(-TRANSCRIPT_CAP);
      let status = state.status;
      let active: string | null = state.activeRequestId;
      if (event.type === "kernel:text") status = "streaming";
      if (event.type === "kernel:result" || event.type === "kernel:error" || event.type === "kernel:aborted") {
        status = "idle";
        active = null;
      }
      return { messages, status, activeRequestId: active };
    });
  },
}));
