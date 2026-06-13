// Wires the singleton kernel socket into the stores: thread routing, board
// task events, native notifications, dock badge.
import { invoke, onEvent } from "./operator";
import { KernelSocket } from "./kernel-socket";
import { useBoard } from "../stores/board";
import { useConnection } from "../stores/connection";
import { useTabs } from "../stores/tabs";
import { useThreads } from "../stores/threads";

let socket: KernelSocket | null = null;

export function getKernelSocket(): KernelSocket | null {
  return socket;
}

export function sendKernelMessage(msg: {
  text: string;
  sessionId?: string;
  requestId: string;
}): void {
  socket?.send({ type: "message", text: msg.text, requestId: msg.requestId, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
}

export function abortKernelRequest(requestId: string): void {
  socket?.send({ type: "abort", requestId });
}

export function wireKernel(): () => void {
  const { platformHost, runtimeSlot } = useConnection.getState();
  if (socket) {
    socket.dispose();
    socket = null;
  }
  socket = new KernelSocket({ baseUrl: platformHost, runtimeSlot });

  const unsubscribeMessages = socket.subscribe((msg) => {
    // A thread is "focused" only when the Agents tab is active and it's the
    // selected thread; otherwise completions raise a notification.
    const tabsState = useTabs.getState();
    const agentsActive = tabsState.tabs.find((t) => t.id === tabsState.activeTabId)?.kind === "agents";
    const focusedThreadId = agentsActive ? useThreads.getState().activeThreadId : null;
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
    if (msg.type === "task:created" || msg.type === "task:updated") {
      useBoard.getState().applyTaskEvent(msg as never);
    }
  });

  let lastBadge = -1;
  const unsubscribeBadge = useThreads.subscribe((state) => {
    const count = state.threads.reduce(
      (sum, t) => sum + (t.unread || t.status === "needs-attention" ? 1 : 0),
      0,
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
  });

  // Clicking a native notification focuses the thread in the Agents tab.
  const offNotificationClick = onEvent("notification:clicked", ({ threadId }) => {
    useThreads.getState().setActiveThread(threadId);
    useTabs.getState().openTab({ kind: "agents", title: "Agents" });
  });

  socket.connect();

  return () => {
    unsubscribeMessages();
    unsubscribeBadge();
    offNotificationClick();
    socket?.dispose();
    socket = null;
  };
}
