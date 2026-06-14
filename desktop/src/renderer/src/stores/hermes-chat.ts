// The OS-agent (Hermes) conversation — a single continuous chat, distinct from
// task-bound agent runs (which live in the threads store). Sends over the
// kernel WS and reduces streamed events into one transcript. The kernel keeps
// the session alive via sessionId; "New chat" starts a fresh session.
import { create } from "zustand";
import { reduceChat, type ChatEvent, type ChatMessage } from "../lib/chat";
import { abortKernelRequest, sendKernelMessage } from "../lib/kernel-wiring";

const TRANSCRIPT_CAP = 800;

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
    sendKernelMessage({
      text: trimmed,
      requestId,
      ...(get().sessionId ? { sessionId: get().sessionId! } : {}),
    });
  },

  abort: () => {
    const { activeRequestId } = get();
    if (activeRequestId) abortKernelRequest(activeRequestId);
  },

  newChat: () => {
    const { activeRequestId } = get();
    if (activeRequestId) abortKernelRequest(activeRequestId);
    set({ messages: [], sessionId: null, status: "idle", activeRequestId: null });
  },

  ingest: (event) => {
    const { activeRequestId } = get();
    // Bind the session from init/switch even before a request is active.
    if (event.type === "kernel:init" && event.sessionId) {
      set({ sessionId: event.sessionId });
    }
    // Only fold events for the in-flight request into this transcript.
    if (!activeRequestId || event.requestId !== activeRequestId) return;

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
