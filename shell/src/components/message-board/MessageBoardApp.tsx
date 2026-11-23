"use client";

import { useState } from "react";
import { createHttpMessageBoardClient, MessageBoard, type BoardEventsSocket } from "@matrix-os/ui/message-board";
import { getGatewayUrl } from "@/lib/gateway";
import { buildAuthenticatedWebSocketUrl } from "@/lib/websocket-auth";

/** Message Board built-in (spec 2700): the shared viewer over the owner's `/api/board` routes. */
export function MessageBoardApp() {
  const [client] = useState(() => createHttpMessageBoardClient({
    baseUrl: getGatewayUrl(),
    eventsUrl: (query) => buildAuthenticatedWebSocketUrl("/ws/board/events", query),
    // A browser WebSocket has every member the client uses.
    createSocket: (url) => new WebSocket(url) as unknown as BoardEventsSocket,
  }));
  return <div className="h-full overflow-hidden">
    <MessageBoard client={client} />
  </div>;
}
