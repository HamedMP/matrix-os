"use client";

import { useState, useEffect, useRef } from "react";
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
import { capturePostHogEvent } from "@/lib/posthog-client";
import { createCoalescedBridgeDataHandler, type BridgeDataRequest } from "@/lib/app-data-write-queue";
import { MATRIX_TELEMETRY_EVENTS } from "@matrix-os/observability/events";
import {
  APP_IFRAME_SANDBOX,
  extractSlug,
  shouldRenderAppIframe,
  injectBridgeIntoAppHtml,
} from "./app-viewer-helpers";
import { isAllowedBridgeFetchUrl } from "./app-viewer-bridge-policy";

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

function readCurrentTheme(): ThemeVars {
  if (typeof document === "undefined") return {};
  const style = getComputedStyle(document.documentElement);
  return getThemeVariables(style);
}

function readCurrentDesign(): string {
  if (typeof document === "undefined") return "flat";
  return document.documentElement.dataset.themeStyle ?? "flat";
}

async function handleBridgeFetch(appName: string, payload: unknown, port: MessagePort): Promise<void> {
  try {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid bridge fetch payload");
    }
    const { url, init } = payload as { url?: unknown; init?: unknown };
    if (typeof url !== "string" || !isAllowedBridgeFetchUrl(appName, url)) {
      throw new Error("Blocked bridge fetch URL");
    }
    const requestInit = init && typeof init === "object" ? init as RequestInit : {};
    const response = await fetch(`${getGatewayUrl()}${url}`, {
      method: requestInit.method,
      headers: requestInit.headers,
      body: requestInit.body,
      signal: AbortSignal.timeout(BRIDGE_FETCH_TIMEOUT_MS),
    });
    const body = await response.json().catch((err: unknown) => {
      console.warn("[app-viewer] bridge fetch JSON parse failed:", err instanceof Error ? err.message : String(err));
      return null;
    });
    port.postMessage({ ok: response.ok, status: response.status, body });
  } catch (err: unknown) {
    port.postMessage({ ok: false, error: err instanceof Error ? err.message : "Bridge fetch failed" });
  } finally {
    port.close();
  }
}

const requestBridgeData: BridgeDataRequest = async (action, app, key, value) => {
  try {
    const response = await fetch(`${GATEWAY_URL}/api/bridge/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(BRIDGE_FETCH_TIMEOUT_MS),
      body: JSON.stringify({ action, app, key, value }),
    });
    const body = await response.json() as { value?: unknown };
    if (!response.ok) return Promise.reject(new Error("Bridge data request failed"));
    return action === "read" ? body.value : undefined;
  } catch (err: unknown) {
    console.warn("[app-viewer] bridge data fetch failed:", err instanceof Error ? err.message : String(err));
    return Promise.reject(new Error("Bridge data request failed"));
  }
};

// App windows can be removed while their final writes are still draining.
// Keep one process-local queue so a newly opened viewer for the same app/key
// waits behind those writes instead of racing an independent component queue.
const bridgeDataHandler = createCoalescedBridgeDataHandler(requestBridgeData);

export function AppViewer({ path, sessionId, onOpenApp }: AppViewerProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [iframeHtml, setIframeHtml] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { send, subscribe } = useSocket();
  // react-doctor-disable-next-line react-doctor/no-event-handler -- pure derived value computed from the `path` prop during render, not a DOM event handler or effect-driven side effect.
  const appName = appNameFromPath(path);

  useFileWatcher((changedPath: string, event: string) => {
    if (changedPath === path && event === "change") {
      setRefreshKey((k) => k + 1);
    }
  });

  // Legacy file paths can only receive the bridge when same-origin DOM access is
  // available. Runtime apps use srcdoc injection below so the sandbox can omit
  // allow-same-origin.
  useEffect(() => {
    const iframe = iframeRef.current;
    const slug = extractSlug(path);
    if (!iframe || slug) return;

    const onLoad = () => {
      try {
        const themeVars = readCurrentTheme();
        const script = buildBridgeScript(appName, themeVars, readCurrentDesign());
        // Inject bridge directly into iframe DOM, then trigger reload.
        const doc = iframe.contentDocument;
        if (doc) {
          const el = doc.createElement("script");
          // Bridge + zoom forwarding in a single script injection.
          el.textContent = script
            + `\n;if(window.MatrixOS&&window.MatrixOS.db){useDb=true;}if(typeof loadData==="function"){loadData();}`
            + `\n;`;
          doc.head.appendChild(el);
        } else {
          console.warn("[app-viewer] bridge injection skipped: iframe document is not accessible");
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
  }, [appName, path, refreshKey]);

  // Observe theme changes and broadcast to iframe (T2071)
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const observer = new MutationObserver(() => {
      try {
        const themeVars = readCurrentTheme();
        iframe.contentWindow?.postMessage(
          { type: "os:theme-update", payload: themeVars, design: readCurrentDesign() },
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
      attributeFilter: ["style", "class", "data-theme-style"],
    });

    return () => observer.disconnect();
  }, [refreshKey]);

  // Handle bridge messages from iframe
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- this effect only registers a window "message" listener; the fetch fires from the iframe bridge handler when a postMessage arrives (event-driven, not on mount/render) and already carries AbortSignal.timeout.
  useEffect(() => {
    const handler: BridgeHandler = {
      sendToKernel(text) {
        send({ type: "message", text, sessionId });
      },
      fetchData: bridgeDataHandler,
      openApp: onOpenApp,
    };

    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (
        data?.type === "os:bridge-fetch"
        && event.source === iframeRef.current?.contentWindow
        && (event.origin === window.location.origin || event.origin === "null")
        && data.app === appName
        && event.ports[0]
      ) {
        void handleBridgeFetch(appName, data.payload, event.ports[0]);
        return;
      }
      handleBridgeMessage(event, handler, {
        expectedSource: iframeRef.current?.contentWindow,
        expectedOrigins: new Set([window.location.origin, "null"]),
        expectedApp: appName,
      });
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [send, sessionId, onOpenApp, appName, bridgeDataHandler]);

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

  useEffect(() => {
    capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.SHELL_APP_OPENED, {
      app: slug ?? appName,
      runtime: slug ? "vite" : "file",
    });
  }, [appName, slug]);

  // Spec 063 session bootstrap: set the matrix_app_session__{slug} cookie
  // before the iframe ever navigates to /apps/{slug}/. Skipping this step
  // forces the browser to load the 401 interstitial first and recover via
  // postMessage, which races React's useEffect listener registration and
  // leaves the iframe stuck on "Refreshing session..." when the race loses.
  useEffect(() => {
    if (!slug) return;
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- async session bootstrap: reset the loading gate before the awaited openAppSession call, which flips sessionReady back true in .finally; guarded by the cancelled flag in cleanup.
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

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state, react-doctor/no-fetch-in-effect -- guarded async app-HTML load: the setIframeHtml calls live in mutually-exclusive branches (clear-on-not-ready vs set-on-success), the fetch carries AbortSignal.timeout, and the cancelled flag in cleanup prevents post-unmount writes. The HTML is bootstrapped imperatively (srcdoc injection), not server-render-able here.
  useEffect(() => {
    if (!slug || !sessionReady) {
      // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-adjust-state-on-prop-change -- clears the previously-loaded srcdoc when slug/session changes so a stale app's HTML is never shown while the new one loads; not derivable in render because the loaded HTML is the async result of the fetch below.
      setIframeHtml(null);
      return;
    }

    let cancelled = false;
    const baseHref = `${GATEWAY_URL}/apps/${slug}/`;
    fetch(baseHref, { signal: AbortSignal.timeout(BRIDGE_FETCH_TIMEOUT_MS) })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((html) => {
        if (!cancelled) {
          setIframeHtml(injectBridgeIntoAppHtml(html, appName, readCurrentTheme(), baseHref, readCurrentDesign()));
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn("[app-viewer] app html bootstrap failed:", slug, err instanceof Error ? err.message : String(err));
        setIframeHtml(null);
      });

    return () => {
      cancelled = true;
    };
  }, [slug, sessionReady, appName, refreshKey]);

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
      // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot yet lower a try/finally (BuildHIR Todo: TryStatement with a finalizer); the finally block is required to clear refreshInFlightRef even when the session refresh throws, so the pattern is intentional and behavior-preserving.
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

  // Runtime (slug) apps MUST only ever load through the bridged srcDoc — loading
  // the raw /apps/{slug}/ document in the iframe runs the app in the sandboxed,
  // null-origin context WITHOUT window.MatrixOS injected, so the app's data layer
  // sees no bridge and falls back to localStorage (SecurityError) or a direct
  // fetch (CORS/CSP). Hold on about:blank until the injected srcDoc HTML is ready;
  // never expose the un-bridged document. Legacy file paths keep /files/{path}.
  const iframeSrc = !slug ? `/files/${path}` : "about:blank";

  if (!shouldRenderAppIframe(path)) {
    return null;
  }

  return (
    <iframe
      ref={iframeRef}
      key={refreshKey}
      src={iframeSrc}
      srcDoc={slug && iframeHtml ? iframeHtml : undefined}
      className="h-full w-full border-0"
      sandbox={APP_IFRAME_SANDBOX}
      title={path}
    />
  );
}
