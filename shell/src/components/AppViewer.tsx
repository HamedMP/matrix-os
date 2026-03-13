"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useFileWatcher } from "@/hooks/useFileWatcher";
import { useSocket } from "@/hooks/useSocket";
import {
  handleBridgeMessage,
  buildBridgeScript,
  getThemeVariables,
  type BridgeHandler,
  type ThemeVars,
} from "@/lib/os-bridge";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();

interface AppViewerProps {
  path: string;
  sessionId?: string;
  onOpenApp?: (name: string, path: string) => void;
}

function appNameFromPath(path: string): string {
  if (path.startsWith("modules/")) {
    return path.split("/")[1];
  }
  return path.replace("apps/", "").replace(".html", "");
}

function readCurrentTheme(): ThemeVars {
  if (typeof document === "undefined") return {};
  const style = getComputedStyle(document.documentElement);
  return getThemeVariables(style);
}

export function AppViewer({ path, sessionId, onOpenApp }: AppViewerProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { send, subscribe } = useSocket();
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

  // Inject bridge script with theme variables on iframe load
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const onLoad = () => {
      try {
        const themeVars = readCurrentTheme();
        const script = buildBridgeScript(appName, themeVars);
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

  // Observe theme changes and broadcast to iframe (T2071)
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const observer = new MutationObserver(() => {
      try {
        const themeVars = readCurrentTheme();
        iframe.contentWindow?.postMessage(
          { type: "os:theme-update", payload: themeVars },
          "*",
        );
      } catch {
        // cross-origin restriction
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });

    return () => observer.disconnect();
  }, [refreshKey]);

  // Handle bridge messages from iframe
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
      openApp: onOpenApp,
    };

    const onMessage = (event: MessageEvent) => {
      handleBridgeMessage(event, handler);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [send, sessionId, onOpenApp]);

  // Forward data:change events to iframe for auto-update
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === "data:change") {
        const iframe = iframeRef.current;
        if (!iframe) return;
        const msgApp = (msg as { app: string }).app;
        const msgKey = (msg as { key: string }).key;
        if (msgApp === appName || appName.endsWith(`/${msgApp}`)) {
          try {
            iframe.contentWindow?.postMessage(
              { type: "os:data-change", payload: { app: msgApp, key: msgKey } },
              "*",
            );
          } catch {
            // cross-origin restriction
          }
        }
      }
    });
  }, [subscribe, appName]);

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
