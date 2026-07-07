import type { KernelEvent } from "@matrix-os/kernel";
import type { MainWsClientMessage } from "../ws-message-schema.js";
import type { ServerMessage } from "./types.js";

type WebSocketSender = {
  send(data: string): void;
};

export function kernelEventToServerMessage(event: KernelEvent, requestId?: string): ServerMessage {
  switch (event.type) {
    case "init":
      return { type: "kernel:init", sessionId: event.sessionId, requestId };
    case "text":
      return { type: "kernel:text", text: event.text, requestId };
    case "tool_start":
      return { type: "kernel:tool_start", tool: event.tool, requestId };
    case "tool_end":
      return { type: "kernel:tool_end", input: event.input, requestId };
    case "result":
      return { type: "kernel:result", data: event.data, requestId };
    case "aborted":
      return { type: "kernel:aborted", requestId };
  }
}

export function send(ws: WebSocketSender, msg: ServerMessage): boolean {
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch (err: unknown) {
    console.warn("[gateway] Main WebSocket send failed:", err instanceof Error ? err.name : typeof err);
    return false;
  }
}

export function actionIdForClientMessage(message: MainWsClientMessage): string | null {
  if ("requestId" in message && typeof message.requestId === "string" && message.requestId.length > 0) {
    return message.requestId;
  }
  if (message.type === "approval_response") return message.id;
  if (message.type === "switch_session") return `switch_session:${message.sessionId}`;
  return null;
}

export function sendClientAck(
  ws: WebSocketSender,
  message: MainWsClientMessage,
  status: "accepted" | "rejected",
  retryable = status !== "accepted",
): void {
  const actionId = actionIdForClientMessage(message);
  if (!actionId) return;
  send(ws, {
    type: "client:ack",
    actionId,
    actionType: message.type,
    status,
    retryable,
  });
}
