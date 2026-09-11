import type { KernelEvent } from "@matrix-os/kernel";
import { isKernelResultFailureText } from "@matrix-os/contracts";
import type { MainWsClientMessage } from "../ws-message-schema.js";
import type { ServerMessage } from "./types.js";

type WebSocketSender = {
  send(data: string): void;
};

export function kernelResultFallbackText(
  event: KernelEvent,
  receivedIncrementalText: boolean,
): string | null {
  if (
    receivedIncrementalText
    || event.type !== "result"
    || (event.data.errors?.length ?? 0) > 0
    || typeof event.data.result !== "string"
    || isKernelResultFailureText(event.data.result)
  ) {
    return null;
  }
  const result = event.data.result.trim();
  return result || null;
}

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
      if (
        (event.data.errors?.length ?? 0) > 0
        || isKernelResultFailureText(event.data.result)
      ) {
        return { type: "kernel:error", message: "Request failed", requestId };
      }
      return { type: "kernel:result", data: event.data, requestId };
    case "aborted":
      return { type: "kernel:aborted", requestId };
    case "refusal":
      return {
        type: "kernel:error",
        message: "The selected model could not complete this request",
        requestId,
      };
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
