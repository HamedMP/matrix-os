"use client";

import { useEffect, useRef, useState } from "react";

interface NativeAppViewerProps {
  appId: string;
  windowId: string;
}

interface NativeAppSession {
  id: string;
  appId: string;
  status: "starting" | "running" | "exited" | "terminated" | "failed";
  streamUrl: string;
}

type ViewerState =
  | { status: "loading" }
  | { status: "ready"; session: NativeAppSession }
  | { status: "failed"; message: string }
  | { status: "terminated" };

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_NATIVE_SESSION_LEASES = 64;

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
  return `${explicitVmPrefix()}/api/native-apps${path}`;
}

function explicitVmPrefix(): string {
  if (typeof window === "undefined") return "";
  const match = window.location.pathname.match(/^\/vm\/([a-z][a-z0-9-]{2,30})(?:\/|$)/);
  return match?.[1] ? `/vm/${match[1]}` : "";
}

function nativeStreamUrl(streamUrl: string): string {
  const prefix = explicitVmPrefix();
  if (!prefix || !streamUrl.startsWith("/api/native-apps/")) return streamUrl;
  return `${prefix}${streamUrl}`;
}

async function launchNativeSession(appId: string): Promise<NativeAppSession> {
  const response = await fetch(nativeApiPath(`/${appId}/sessions`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
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
  await fetch(nativeApiPath(`/sessions/${sessionId}`), {
    method: "DELETE",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((err: unknown) => {
    console.warn("[native-app-viewer] terminate failed:", err instanceof Error ? err.message : String(err));
  });
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

function acquireNativeSessionLease(windowId: string, appId: string): NativeSessionLeaseHandle {
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
    session: launchNativeSession(appId),
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
  const leaseRef = useRef<NativeSessionLeaseHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const lease = acquireNativeSessionLease(windowId, appId);
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
  }, [appId, windowId]);

  if (state.status === "ready") {
    return (
      <iframe
        title={`${appId} native app`}
        src={state.session.streamUrl}
        className="ph-no-capture h-full w-full border-0 bg-black"
        sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups"
      />
    );
  }

  if (state.status === "failed") {
    return (
      <div className="flex h-full items-center justify-center bg-card px-6 text-center text-sm text-muted-foreground">
        {state.message}
      </div>
    );
  }

  if (state.status === "terminated") {
    return (
      <div className="flex h-full items-center justify-center bg-card px-6 text-center text-sm text-muted-foreground">
        Native app session ended
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-card px-6 text-center text-sm text-muted-foreground">
      Opening native app...
    </div>
  );
}
