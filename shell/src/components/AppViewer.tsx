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
const SESSION_REFRESH_DEBOUNCE_MS = 2000;

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

function extractSlug(path: string): string | null {
  // Extract slug from "apps/{slug}" or "apps/{slug}/index.html" paths
  const match = path.match(/^apps\/([a-z0-9][a-z0-9-]{0,63})(?:\/|$)/);
  return match ? match[1] : null;
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
          el.textContent = script + `\n;if(window.MatrixOS&&window.MatrixOS.db){useDb=true;}if(typeof loadData==="function"){loadData();}`;
          doc.head.appendChild(el);
        }
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

  // Session refresh handler: listen for matrix-os:session-expired from the
  // gateway's 401 interstitial HTML. This is the only recovery signal for
  // expired app-session cookies. Do NOT use iframe.onload as a failure probe.
  const lastRefreshAtRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const slug = extractSlug(path);

  useEffect(() => {
    if (!slug) return;

    const handler = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type !== "matrix-os:session-expired") return;
      if (event.data?.slug !== slug) return;
      if (refreshInFlightRef.current) return;
      if (Date.now() - lastRefreshAtRef.current < SESSION_REFRESH_DEBOUNCE_MS) return;

      refreshInFlightRef.current = true;
      try {
        await fetch(`${GATEWAY_URL}/api/apps/${slug}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        lastRefreshAtRef.current = Date.now();
        // Reassign src to trigger browser reload with new cookie
        if (iframeRef.current) {
          iframeRef.current.src = `/apps/${slug}/`;
        }
      } finally {
        refreshInFlightRef.current = false;
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [slug]);

  // Determine iframe src: use /apps/:slug/ for apps with runtime manifest,
  // fall back to /files/ for legacy paths (modules, etc.)
  const iframeSrc = slug ? `/apps/${slug}/` : `/files/${path}`;

  return (
    <iframe
      ref={iframeRef}
      key={refreshKey}
      src={iframeSrc}
      className="h-full w-full border-0"
      sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
      title={path}
    />
  );
}
