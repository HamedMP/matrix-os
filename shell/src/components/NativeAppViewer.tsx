"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface NativeAppViewerProps {
  appId: string;
  windowId: string;
}

interface NativeAppSession {
  id: string;
  appId: string;
  status: "starting" | "running" | "exited" | "terminated" | "failed";
  streamUrl: string;
  transport: "xpra";
  transportVersion: string;
}

interface NativeAppViewport {
  width: number;
  height: number;
}

type ViewerState =
  | { status: "loading" }
  | { status: "ready"; session: NativeAppSession }
  | { status: "failed"; message: string }
  | { status: "terminated" };

const REQUEST_TIMEOUT_MS = 10_000;
const TERMINATION_ATTEMPTS = 3;
const MAX_NATIVE_SESSION_LEASES = 64;
const SAFE_RUNTIME_SLOT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const XPRA_EMBED_OPTIONS = {
  clipboard: "false",
  file_transfer: "false",
  floating_menu: "false",
  offscreen: "false",
  printing: "false",
  reconnect: "false",
  remote_logging: "false",
  sound: "false",
  submit: "false",
} as const;

interface NativeSessionLease {
  appId: string;
  consumers: number;
  lastTouched: number;
  session: Promise<NativeAppSession>;
}

interface NativeSessionLeaseHandle {
  release(): void;
  session: Promise<NativeAppSession>;
}

const nativeSessionLeases = new Map<string, NativeSessionLease>();
let pageHideListenerInstalled = false;

function safeViewerMessage(value: unknown): string {
  if (!value || typeof value !== "object") return "Native apps are not available on this runtime";
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "string" || error.length > 120) return "Native apps are not available on this runtime";
  if (/postgres|twilio|openai|\/home\/|\/opt\/|enoent|stack|trace/i.test(error)) {
    return "Native apps are not available on this runtime";
  }
  return error;
}

function nativeApiPath(path: string): string {
  return withSelectedRuntime(`${explicitVmPrefix()}/api/native-apps${path}`);
}

function explicitVmPrefix(): string {
  if (typeof window === "undefined") return "";
  const match = window.location.pathname.match(/^\/vm\/([a-z0-9][a-z0-9-]{0,62})(?:\/|$)/);
  return match?.[1] ? `/vm/${match[1]}` : "";
}

function nativeStreamUrl(streamUrl: string): string {
  const prefix = explicitVmPrefix();
  const explicitStreamUrl = prefix && streamUrl.startsWith("/api/native-apps/")
    ? `${prefix}${streamUrl}`
    : streamUrl;
  const url = new URL(explicitStreamUrl, window.location.origin);
  for (const [name, value] of Object.entries(XPRA_EMBED_OPTIONS)) {
    url.searchParams.set(name, value);
  }
  return withSelectedRuntime(`${url.pathname}${url.search}${url.hash}`);
}

function withSelectedRuntime(path: string): string {
  if (typeof window === "undefined") return path;
  const runtime = new URLSearchParams(window.location.search).get("runtime");
  if (!runtime || runtime.length > 32 || !SAFE_RUNTIME_SLOT.test(runtime)) return path;
  const url = new URL(path, window.location.origin);
  url.searchParams.set("runtime", runtime);
  return `${url.pathname}${url.search}${url.hash}`;
}

async function launchNativeSession(appId: string, viewport: NativeAppViewport): Promise<NativeAppSession> {
  const response = await fetch(nativeApiPath(`/${appId}/sessions`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(viewport),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch((err: unknown) => {
    console.warn("[native-app-viewer] failed to parse launch response:", err instanceof Error ? err.message : String(err));
    return {};
  });
  if (!response.ok) {
    throw new Error(safeViewerMessage(body));
  }
  const session = (body as { session: NativeAppSession }).session;
  return {
    ...session,
    streamUrl: nativeStreamUrl(session.streamUrl),
  };
}

async function terminateNativeSession(sessionId: string): Promise<void> {
  let lastFailure = "request failed";
  for (let attempt = 0; attempt < TERMINATION_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(nativeApiPath(`/sessions/${sessionId}`), {
        method: "DELETE",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok || response.status === 404) return;
      lastFailure = `status ${response.status}`;
    } catch (err: unknown) {
      lastFailure = err instanceof Error ? err.message : String(err);
    }
  }
  console.warn("[native-app-viewer] terminate failed after retries:", lastFailure);
}

function terminateNativeSessionOnPageHide(sessionId: string): void {
  void fetch(nativeApiPath(`/sessions/${sessionId}`), {
    method: "DELETE",
    keepalive: true,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((err: unknown) => {
    console.warn("[native-app-viewer] unload termination failed:", err instanceof Error ? err.message : String(err));
  });
}

function drainNativeSessionLeasesOnPageHide(): void {
  const leases = [...nativeSessionLeases.values()];
  nativeSessionLeases.clear();
  for (const lease of leases) {
    void lease.session.then(
      (session) => terminateNativeSessionOnPageHide(session.id),
      () => undefined,
    );
  }
}

function ensurePageHideListener(): void {
  if (pageHideListenerInstalled || typeof window === "undefined") return;
  window.addEventListener("pagehide", drainNativeSessionLeasesOnPageHide);
  pageHideListenerInstalled = true;
}

function terminateLease(windowId: string, lease: NativeSessionLease): void {
  if (nativeSessionLeases.get(windowId) === lease) {
    nativeSessionLeases.delete(windowId);
  }
  void lease.session.then(
    (session) => terminateNativeSession(session.id),
    () => undefined,
  );
}

function evictIdleNativeSessionLease(): boolean {
  let oldest: [string, NativeSessionLease] | null = null;
  for (const entry of nativeSessionLeases) {
    if (entry[1].consumers !== 0) continue;
    if (!oldest || entry[1].lastTouched < oldest[1].lastTouched) oldest = entry;
  }
  if (!oldest) return false;
  terminateLease(oldest[0], oldest[1]);
  return true;
}

function acquireNativeSessionLease(
  windowId: string,
  appId: string,
  viewport: NativeAppViewport,
): NativeSessionLeaseHandle {
  ensurePageHideListener();
  const existing = nativeSessionLeases.get(windowId);
  if (existing?.appId === appId) {
    existing.consumers += 1;
    existing.lastTouched = Date.now();
    return {
      session: existing.session,
      release: () => releaseNativeSessionLease(windowId, existing),
    };
  }
  if (existing) terminateLease(windowId, existing);

  if (nativeSessionLeases.size >= MAX_NATIVE_SESSION_LEASES && !evictIdleNativeSessionLease()) {
    return {
      session: Promise.reject(new Error("Too many native app windows are open")),
      release: () => undefined,
    };
  }

  const lease: NativeSessionLease = {
    appId,
    consumers: 1,
    lastTouched: Date.now(),
    session: launchNativeSession(appId, viewport),
  };
  nativeSessionLeases.set(windowId, lease);
  return {
    session: lease.session,
    release: () => releaseNativeSessionLease(windowId, lease),
  };
}

function releaseNativeSessionLease(windowId: string, lease: NativeSessionLease): void {
  lease.consumers = Math.max(0, lease.consumers - 1);
  lease.lastTouched = Date.now();
  if (lease.consumers !== 0) return;

  queueMicrotask(() => {
    if (nativeSessionLeases.get(windowId) === lease && lease.consumers === 0) {
      terminateLease(windowId, lease);
    }
  });
}

export function NativeAppViewer({ appId, windowId }: NativeAppViewerProps) {
  const [state, setState] = useState<ViewerState>({ status: "loading" });
  const [launchViewport, setLaunchViewport] = useState<NativeAppViewport | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const leaseRef = useRef<NativeSessionLeaseHandle | null>(null);

  useLayoutEffect(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    const width = Math.min(3840, Math.max(320, Math.floor(rect?.width || 900)));
    const height = Math.min(2160, Math.max(240, Math.floor(rect?.height || 640)));
    setLaunchViewport({ width, height });
  }, [appId, windowId]);

  useEffect(() => {
    if (!launchViewport) return;
    let cancelled = false;
    setState({ status: "loading" });
    const lease = acquireNativeSessionLease(windowId, appId, launchViewport);
    leaseRef.current = lease;
    lease.session
      .then((session) => {
        if (cancelled) return;
        setState({ status: "ready", session });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "failed",
          message: err instanceof Error ? err.message : "Native apps are not available on this runtime",
        });
      });

    return () => {
      cancelled = true;
      if (leaseRef.current === lease) leaseRef.current = null;
      lease.release();
    };
  }, [appId, launchViewport, windowId]);

  if (state.status === "ready") {
    return (
      <div ref={containerRef} className="h-full w-full overflow-hidden bg-black">
        <iframe
          title={`${appId} native app`}
          src={state.session.streamUrl}
          className="ph-no-capture block h-full w-full border-0 bg-black"
          sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups"
        />
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div ref={containerRef} className="flex h-full items-center justify-center bg-card px-6 text-center text-sm text-muted-foreground">
        {state.message}
      </div>
    );
  }

  if (state.status === "terminated") {
    return (
      <div ref={containerRef} className="flex h-full items-center justify-center bg-card px-6 text-center text-sm text-muted-foreground">
        Native app session ended
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-full items-center justify-center bg-card px-6 text-center text-sm text-muted-foreground">
      Opening native app...
    </div>
  );
}
