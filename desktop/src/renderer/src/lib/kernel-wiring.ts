// Wires the singleton kernel socket into the stores: thread routing, board
// task events, native notifications, dock badge.
import { invoke, onEvent } from "./operator";
import { KernelSocket, type KernelServerMessage } from "./kernel-socket";
import type { ChatEvent } from "./chat";
import {
  useBoard,
  type TaskEventCreated,
  type TaskEventUpdated,
} from "../stores/board";
import { useConnection } from "../stores/connection";
import { useHermesChat } from "../stores/hermes-chat";
import { useCodingAgentWorkspace } from "../stores/coding-agent-workspace";
import { AGENTS_WORKSPACE_TAB_SPEC, useTabs } from "../stores/tabs";
import { useThreads } from "../stores/threads";
import { routeThreadNotification, unifiedAttentionCount } from "../stores/unified-threads";

const KERNEL_CHAT_EVENT_TYPES = new Set([
  "kernel:init",
  "kernel:text",
  "kernel:tool_start",
  "kernel:tool_end",
  "kernel:result",
  "kernel:error",
  "kernel:aborted",
]);

let socket: KernelSocket | null = null;
let cleanupKernel: (() => void) | null = null;

type BoardTaskEvent = KernelServerMessage & (TaskEventCreated | TaskEventUpdated);

function isTaskEvent(msg: KernelServerMessage): msg is BoardTaskEvent {
  if (msg.type === "task:created") return "task" in msg;
  return (
    msg.type === "task:updated" &&
    typeof msg.taskId === "string" &&
    typeof msg.status === "string"
  );
}

export function getKernelSocket(): KernelSocket | null {
  return socket;
}

export function resetKernel(): void {
  if (cleanupKernel) {
    cleanupKernel();
    cleanupKernel = null;
  } else if (socket) {
    socket.dispose();
    socket = null;
  }
}

export function sendKernelMessage(msg: {
  text: string;
  sessionId?: string;
  requestId: string;
}): boolean {
  if (!socket) {
    console.warn("[kernel-wiring] cannot send kernel message before socket is connected");
    return false;
  }
  socket.send({ type: "message", text: msg.text, requestId: msg.requestId, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
  return true;
}

export function abortKernelRequest(requestId: string): boolean {
  if (!socket) {
    console.warn("[kernel-wiring] cannot abort kernel request before socket is connected");
    return false;
  }
  socket.send({ type: "abort", requestId });
  return true;
}

export function wireKernel(): () => void {
  const { platformHost, runtimeSlot } = useConnection.getState();
  if (cleanupKernel) {
    cleanupKernel();
    cleanupKernel = null;
  } else if (socket) {
    socket.dispose();
    socket = null;
  }
  socket = new KernelSocket({ baseUrl: platformHost, runtimeSlot });
  const activeSocket = socket;

  const unsubscribeMessages = activeSocket.subscribe((msg) => {
    // A kernel thread is "focused" only when the Chat tab (where ThreadView
    // renders) is active and it's the selected thread; otherwise completions
    // raise a notification.
    const tabsState = useTabs.getState();
    const chatActive = tabsState.tabs.find((t) => t.id === tabsState.activeTabId)?.kind === "chat";
    const focusedThreadId = chatActive ? useThreads.getState().activeThreadId : null;
    const { notification } = useThreads
      .getState()
      .handleKernelMessage(msg, { focusedThreadId });
    if (notification) {
      void invoke("notify", {
        threadId: notification.threadId,
        title: notification.title.slice(0, 80),
        body: notification.body.slice(0, 200),
        kind: notification.kind,
      }).catch((err: unknown) => {
        console.warn(
          "[kernel-wiring] notify failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
    }
    if (isTaskEvent(msg)) {
      useBoard.getState().applyTaskEvent(msg);
    }
    // Feed the OS-agent conversation (it filters to its own request id).
    if (KERNEL_CHAT_EVENT_TYPES.has(msg.type)) {
      useHermesChat.getState().ingest(msg as unknown as ChatEvent);
    }
  });

  let lastBadge = -1;
  const updateBadge = () => {
    const count = unifiedAttentionCount(
      useThreads.getState().threads,
      useCodingAgentWorkspace.getState().summary,
    );
    if (count !== lastBadge) {
      lastBadge = count;
      void invoke("badge:set", { count: Math.min(count, 999) }).catch((err: unknown) => {
        console.warn(
          "[kernel-wiring] badge update failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  };
  const unsubscribeBadge = useThreads.subscribe(updateBadge);
  const unsubscribeCodingAgentBadge = useCodingAgentWorkspace.subscribe(updateBadge);
  updateBadge();

  // Clicking a native notification focuses the thread on its own surface:
  // kernel threads render in the Chat tab, coding-agent threads in the Agents
  // workspace. Never select across store namespaces.
  const offNotificationClick = onEvent("notification:clicked", ({ threadId }) => {
    const route = routeThreadNotification(
      threadId,
      useThreads.getState().threads.map((thread) => thread.id),
    );
    if (route.target === "chat") {
      useThreads.getState().setActiveThread(route.select);
      useTabs.getState().openTab({ kind: "chat", title: "Hermes", closable: false });
      return;
    }
    void useCodingAgentWorkspace.getState().loadThreadSnapshot(route.select);
    useTabs.getState().openTab(AGENTS_WORKSPACE_TAB_SPEC);
  });

  activeSocket.connect();

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unsubscribeMessages();
    unsubscribeBadge();
    unsubscribeCodingAgentBadge();
    offNotificationClick();
    activeSocket.dispose();
    if (socket === activeSocket) socket = null;
    if (cleanupKernel === cleanup) cleanupKernel = null;
  };
  cleanupKernel = cleanup;
  return cleanup;
}
