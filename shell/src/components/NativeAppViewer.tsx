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

function safeViewerMessage(value: unknown): string {
  if (!value || typeof value !== "object") return "Native apps are not available on this runtime";
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "string" || error.length > 120) return "Native apps are not available on this runtime";
  if (/postgres|twilio|openai|\/home\/|\/opt\/|enoent|stack|trace/i.test(error)) {
    return "Native apps are not available on this runtime";
  }
  return error;
}

async function launchNativeSession(appId: string): Promise<NativeAppSession> {
  const response = await fetch(`/api/native-apps/${appId}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(safeViewerMessage(body));
  }
  return (body as { session: NativeAppSession }).session;
}

async function terminateNativeSession(sessionId: string): Promise<void> {
  await fetch(`/api/native-apps/sessions/${sessionId}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((err: unknown) => {
    console.warn("[native-app-viewer] terminate failed:", err instanceof Error ? err.message : String(err));
  });
}

export function NativeAppViewer({ appId, windowId }: NativeAppViewerProps) {
  const [state, setState] = useState<ViewerState>({ status: "loading" });
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    sessionIdRef.current = null;
    setState({ status: "loading" });
    launchNativeSession(appId)
      .then((session) => {
        if (cancelled) {
          void terminateNativeSession(session.id);
          return;
        }
        sessionIdRef.current = session.id;
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
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sessionId) void terminateNativeSession(sessionId);
    };
  }, [appId, windowId]);

  if (state.status === "ready") {
    return (
      <iframe
        title={`${appId} native app`}
        src={state.session.streamUrl}
        className="ph-no-capture h-full w-full border-0 bg-black"
        sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups"
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
