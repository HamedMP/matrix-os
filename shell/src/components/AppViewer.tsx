"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useFileWatcher } from "@/hooks/useFileWatcher";
import { useSocket } from "@/hooks/useSocket";
import {
  handleBridgeMessage,
  buildBridgeScript,
  type BridgeHandler,
} from "@/lib/os-bridge";

const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000";

interface AppViewerProps {
  path: string;
  sessionId?: string;
}

function appNameFromPath(path: string): string {
  if (path.startsWith("modules/")) {
    return path.split("/")[1];
  }
  return path.replace("apps/", "").replace(".html", "");
}

export function AppViewer({ path, sessionId }: AppViewerProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { send } = useSocket();
  const appName = appNameFromPath(path);

  useFileWatcher(
    useCallback(
      (changedPath: string, event: string) => {
        if (changedPath === path && event === "change") {
          setRefreshKey((k) => k + 1);
        }
      },
      [path],
    ),
  );

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const onLoad = () => {
      try {
        const script = buildBridgeScript(appName);
        iframe.contentWindow?.postMessage(
          { type: "os:inject", script },
          "*",
        );
      } catch {
        // cross-origin restriction, bridge won't be available
      }
    };

    iframe.addEventListener("load", onLoad);
    return () => iframe.removeEventListener("load", onLoad);
  }, [appName, refreshKey]);

  useEffect(() => {
    const handler: BridgeHandler = {
      sendToKernel(text) {
        send({ type: "message", text, sessionId });
      },
      fetchData(action, app, key, value) {
        fetch(`${GATEWAY_URL}/api/bridge/data`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, app, key, value }),
        });
      },
    };

    const onMessage = (event: MessageEvent) => {
      handleBridgeMessage(event, handler);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [send, sessionId]);

  return (
    <iframe
      ref={iframeRef}
      key={refreshKey}
      src={`${GATEWAY_URL}/files/${path}`}
      className="h-full w-full border-0"
      sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
      title={path}
    />
  );
}
