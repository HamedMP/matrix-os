"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { useTerminalControls } from "@matrix-os/ui";
import type { Terminal } from "@xterm/xterm";
import { getGatewayUrl } from "@/lib/gateway";
import { createWebTerminalControlsTransport } from "./terminal-controls-transport";
import { listenTerminalPaneActions } from "./terminal-pane-actions";
import { isAppleCommandPlatform } from "./terminal-xterm-runtime";

export function useWebTerminalControls(options: {
  paneId: string;
  sessionName: string | null;
  enabled: boolean;
  wsRef: RefObject<WebSocket | null>;
  termRef: RefObject<Terminal | null>;
}) {
  const { wsRef, termRef } = options;
  const gatewayUrl = getGatewayUrl();
  const transport = useMemo(() => createWebTerminalControlsTransport(gatewayUrl), [gatewayUrl]);
  const sendInput = useCallback((data: string) => {
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
  }, [wsRef]);
  const focus = useCallback(() => termRef.current?.focus(), [termRef]);
  const controls = useTerminalControls({
    sessionName: options.sessionName,
    enabled: options.enabled,
    isMac: typeof navigator !== "undefined" && isAppleCommandPlatform(navigator.platform),
    transport, sendInput, focus,
  });
  const latestControls = useRef(controls);
  useLayoutEffect(() => { latestControls.current = controls; }, [controls]);
  const handleKeyEvent = useCallback((event: KeyboardEvent) => latestControls.current.handleKeyEvent(event), []);
  useEffect(() => listenTerminalPaneActions(options.paneId, (action) => {
    void latestControls.current.runAction(action);
  }), [options.paneId]);
  return { controls, handleKeyEvent };
}
