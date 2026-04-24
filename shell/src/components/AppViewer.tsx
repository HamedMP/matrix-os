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
const BRIDGE_FETCH_TIMEOUT_MS = 10_000;

interface AppViewerProps {
  path: string;
  sessionId?: string;
  onOpenApp?: (name: string, path: string) => void;
}

function appNameFromPath(path: string): string {
  if (path.startsWith("modules/")) {
    return path.split("/")[1];
  }
  return path.replace("apps/", "").replace(/\/index\.html$/, "").replace(".html", "");
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
        // Inject bridge directly into iframe DOM (same-origin), then trigger reload
        const doc = iframe.contentDocument;
        if (doc) {
          const el = doc.createElement("script");
          // Bridge + zoom forwarding in a single script injection.
          // Pinch-to-zoom (ctrl+wheel) is forwarded to the parent canvas
          // because iframes capture it in their own browsing context.
          el.textContent = script
            + `\n;if(window.MatrixOS&&window.MatrixOS.db){useDb=true;}if(typeof loadData==="function"){loadData();}`
            + `\n;window.addEventListener('wheel',function(e){if(e.ctrlKey||e.metaKey){e.preventDefault();parent.postMessage({type:'os:wheel-zoom',deltaX:e.deltaX,deltaY:e.deltaY,clientX:e.clientX,clientY:e.clientY},'*')}},{passive:false});`;
          doc.head.appendChild(el);
        }
      } catch (err) {
        console.warn("[app-viewer] bridge injection failed:", err instanceof Error ? err.message : String(err));
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
      } catch (err) {
        console.warn("[app-viewer] theme update failed:", err instanceof Error ? err.message : String(err));
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
          signal: AbortSignal.timeout(BRIDGE_FETCH_TIMEOUT_MS),
          body: JSON.stringify({ action, app, key, value }),
        }).catch((err: unknown) => {
          console.warn("[app-viewer] bridge data fetch failed:", err instanceof Error ? err.message : String(err));
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
          } catch (err) {
            console.warn("[app-viewer] data change postMessage failed:", err instanceof Error ? err.message : String(err));
          }
        }
      }
    });
  }, [subscribe, appName]);

  return (
    <iframe
      ref={iframeRef}
      key={refreshKey}
      src={`/files/${path}`}
      className="h-full w-full border-0"
      sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
      title={path}
    />
  );
}
