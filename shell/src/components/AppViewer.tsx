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
import { openAppSession } from "@/lib/app-session";

const GATEWAY_URL = getGatewayUrl();
const SESSION_REFRESH_DEBOUNCE_MS = 2000;
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

export function extractSlug(path: string): string | null {
  // Only treat a path as a slug-route when it targets the top-level app
  // directory: "apps/{slug}", "apps/{slug}/", or "apps/{slug}/index.html".
  // Nested paths like "apps/games/2048/index.html" must fall back to the
  // legacy /files/ route -- they share a parent slug but are not runtime-
  // managed apps, so routing them through /apps/:slug/ would serve the
  // parent app's index.html instead of the requested file.
  const match = path.match(/^apps\/([a-z0-9][a-z0-9-]{0,63})(?:\/(?:index\.html)?)?$/);
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
          // Bridge + zoom forwarding in a single script injection.
          // Pinch-to-zoom (ctrl+wheel) is forwarded to the parent canvas
          // because iframes capture it in their own browsing context.
          el.textContent = script
            + `\n;if(window.MatrixOS&&window.MatrixOS.db){useDb=true;}if(typeof loadData==="function"){loadData();}`
            + `\n;window.addEventListener('wheel',function(e){if(e.ctrlKey||e.metaKey){e.preventDefault();parent.postMessage({type:'os:wheel-zoom',deltaX:e.deltaX,deltaY:e.deltaY,clientX:e.clientX,clientY:e.clientY},'*')}},{passive:false});`;
          doc.head.appendChild(el);
        }
      } catch (err) {
        // Cross-origin iframe -- bridge injection isn't possible.
        // SecurityError is expected; anything else worth logging.
        if (!(err instanceof DOMException) || err.name !== "SecurityError") {
          console.warn("[app-viewer] bridge injection failed:", err instanceof Error ? err.message : String(err));
        }
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
        // Cross-origin postMessage can reject when the iframe is unloading.
        if (!(err instanceof DOMException)) {
          console.warn("[app-viewer] theme update failed:", err instanceof Error ? err.message : String(err));
        }
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
            if (!(err instanceof DOMException)) {
              console.warn("[app-viewer] data change postMessage failed:", err instanceof Error ? err.message : String(err));
            }
          }
        }
      }
    });
  }, [subscribe, appName]);

  const slug = extractSlug(path);
  const [sessionReady, setSessionReady] = useState(!slug);
  const lastRefreshAtRef = useRef(0);
  const refreshInFlightRef = useRef(false);

  // Spec 063 session bootstrap: set the matrix_app_session__{slug} cookie
  // before the iframe ever navigates to /apps/{slug}/. Skipping this step
  // forces the browser to load the 401 interstitial first and recover via
  // postMessage, which races React's useEffect listener registration and
  // leaves the iframe stuck on "Refreshing session..." when the race loses.
  useEffect(() => {
    if (!slug) return;
    setSessionReady(false);
    let cancelled = false;
    openAppSession(slug, { gatewayUrl: GATEWAY_URL })
      .catch((err: unknown) => {
        // Log so failures are visible; the interstitial fallback path will
        // still retry via the session-expired postMessage handler below.
        console.warn("[app-viewer] session bootstrap failed:", slug, err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setSessionReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Cookie-expiry recovery: listen for matrix-os:session-expired from the
  // gateway's 401 interstitial HTML. Bumping refreshKey remounts the iframe
  // with a fresh DOM element so the browser issues a clean navigation that
  // picks up the new cookie (reassigning .src to the same URL is not reliable).
  useEffect(() => {
    if (!slug) return;

    const handler = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin && event.origin !== "null") return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type !== "matrix-os:session-expired") return;
      if (event.data?.slug !== slug) return;
      if (refreshInFlightRef.current) return;
      if (Date.now() - lastRefreshAtRef.current < SESSION_REFRESH_DEBOUNCE_MS) return;

      refreshInFlightRef.current = true;
      // Stamp the debounce BEFORE awaiting — otherwise a persistently failing
      // refresh (gateway down) would let every incoming session-expired event
      // through and flood the gateway with retries.
      lastRefreshAtRef.current = Date.now();
      try {
        await openAppSession(slug, { gatewayUrl: GATEWAY_URL });
        setRefreshKey((k) => k + 1);
      } catch (err: unknown) {
        console.warn("[app-viewer] session refresh failed:", slug, err instanceof Error ? err.message : String(err));
      } finally {
        refreshInFlightRef.current = false;
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [slug]);

  // Hold the iframe on about:blank until the session cookie is minted.
  const iframeSrc = !slug
    ? `/files/${path}`
    : sessionReady
      ? `/apps/${slug}/`
      : "about:blank";

  return (
    <iframe
      ref={iframeRef}
      key={refreshKey}
      src={iframeSrc}
      className="h-full w-full border-0"
      sandbox="allow-scripts allow-forms allow-popups"
      title={path}
    />
  );
}
