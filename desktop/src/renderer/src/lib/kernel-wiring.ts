// Wires the singleton kernel socket into the stores: thread routing, board
// task events, native notifications, dock badge.
import { invoke } from "./operator";
import { KernelSocket, type KernelServerMessage } from "./kernel-socket";
import {
  useBoard,
  type TaskEventCreated,
  type TaskEventUpdated,
} from "../stores/board";
import { useConnection } from "../stores/connection";
import { useThreads } from "../stores/threads";
import { useUi } from "../stores/ui";

let socket: KernelSocket | null = null;

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
    const ui = useUi.getState();
    const focusedThreadId = ui.view.kind === "thread" ? ui.view.threadId : null;
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

  socket.connect();

  return () => {
    unsubscribeMessages();
    unsubscribeBadge();
    socket?.dispose();
    socket = null;
  };
}
