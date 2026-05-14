import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserProtocolError, browserApiSignal, createBrowserSession, normalizeBrowserTarget, type BrowserSessionResponse } from "./browser-protocol";

export type BrowserConnectionState =
  | "empty"
  | "starting"
  | "stream-pending"
  | "connected"
  | "locked"
  | "hibernated"
  | "recoverable"
  | "limit"
  | "error";

export function useBrowserSession() {
  const [url, setUrl] = useState("about:blank");
  const [surface, setSurface] = useState<"canvas" | "standalone">("canvas");
  const [state, setState] = useState<BrowserConnectionState>("empty");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<BrowserSessionResponse | null>(null);
  const [frameDataUrl, setFrameDataUrl] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  const sendStreamMessage = useCallback((message: unknown) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const surfaceId = surface === "standalone" ? "browser-standalone" : "browser-canvas";

  useEffect(() => {
    if (!session || typeof WebSocket === "undefined") return undefined;
    if (!session.wsUrl || !session.streamToken) return undefined;
    const wsUrl = new URL(session.wsUrl, window.location.origin);
    if (wsUrl.protocol === "https:") {
      wsUrl.protocol = "wss:";
    } else if (wsUrl.protocol === "http:") {
      wsUrl.protocol = "ws:";
    }
    const socket = new WebSocket(wsUrl.toString(), [`browser-stream.${session.streamToken}`]);
    let closingForCleanup = false;
    socketRef.current = socket;

    socket.onopen = () => {
      sendStreamMessage({
        type: "stream.hello",
        payload: {
          protocolVersion: 1,
          surfaceId,
          surface,
          deviceId: surfaceId,
          viewport: { width: 1280, height: 720, deviceScaleFactor: window.devicePixelRatio || 1 },
          media: {
            preferredMode: "webrtc",
            audio: true,
            fallbackFrames: true,
            iceTransportPolicy: "relay",
          },
        },
      });
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          type?: string;
          payload?: {
            code?: string;
            message?: string;
            data?: string;
            url?: string;
          };
        };
        if (message.type === "stream.ready" || message.type === "surface.focused" || message.type === "navigation.committed") {
          setState("connected");
        } else if (message.type === "frame.jpeg" && typeof message.payload?.data === "string") {
          setFrameDataUrl(`data:image/jpeg;base64,${message.payload.data}`);
          if (typeof message.payload.url === "string") setUrl(message.payload.url);
          setState("connected");
        } else if (message.type === "stream.taken_over") {
          setState("locked");
          setError("Browser was opened on another device.");
        } else if (message.type === "stream.error") {
          const code = message.payload?.code ?? "";
          setState(stateForErrorCode(code));
          setError(message.payload?.message ?? "Browser is unavailable right now.");
        }
      } catch (err: unknown) {
        console.warn("[browser-app] Invalid Browser stream message:", err instanceof Error ? err.message : String(err));
      }
    };
    socket.onclose = () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      if (!closingForCleanup) {
        setState("recoverable");
        setError("Browser stream disconnected.");
      }
    };
    socket.onerror = () => {
      setState("error");
      setError("Browser stream disconnected.");
    };

    return () => {
      closingForCleanup = true;
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      socket.close();
    };
  }, [session, sendStreamMessage, surface, surfaceId]);

  const navigate = useCallback(async (
    target: string,
    nextSurface: "canvas" | "standalone" = "canvas",
    handoffToken?: string,
  ) => {
    try {
      const normalized = normalizeBrowserTarget(target);
      const nextSurfaceId = nextSurface === "standalone" ? "browser-standalone" : "browser-canvas";
      setUrl(normalized);
      setFrameDataUrl(null);
      setSurface(nextSurface);
      setState("starting");
      setError(null);
      if (session && sendStreamMessage({
        type: "browser.navigate",
        payload: { targetUrl: normalized, surface: nextSurface },
      })) {
        setState("stream-pending");
        return;
      }
      const next = await createBrowserSession({
        targetUrl: normalized,
        profileName: "default",
        surface: nextSurface,
        deviceId: nextSurfaceId,
        handoffToken,
      });
      setSession(next);
      if (next.session.takeoverRequired || next.session.state === "locked") {
        setState("locked");
        setError("This profile is already open on another device.");
      } else if (next.session.state === "hibernated") {
        setState("hibernated");
      } else if (next.session.state === "recoverable") {
        setState("recoverable");
      } else {
        setState("stream-pending");
      }
    } catch (err: unknown) {
      setState(err instanceof BrowserProtocolError && /limit/i.test(err.message) ? "limit" : "error");
      setError(err instanceof BrowserProtocolError ? err.message : "Browser is unavailable right now.");
    }
  }, [sendStreamMessage, session]);

  const takeover = useCallback(async () => {
    if (!session) return;
    try {
      setState("starting");
      setError(null);
      const deviceId = surfaceId;
      const res = await fetch(`/api/browser/sessions/${encodeURIComponent(session.session.id)}/takeover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: browserApiSignal(),
        body: JSON.stringify({ deviceId, confirm: true }),
      });
      const body = await res.json().catch((error: unknown) => {
        console.warn("[browser-app] Invalid takeover response:", error instanceof Error ? error.message : String(error));
        return null;
      }) as BrowserSessionResponse | null;
      if (!res.ok || !body) {
        throw new BrowserProtocolError("Browser request is invalid.");
      }
      setSession(body);
      if (body.session.takeoverRequired || body.session.state === "locked") {
        setState("locked");
        setError("This profile is already open on another device.");
      } else if (body.session.state === "hibernated") {
        setState("hibernated");
      } else if (body.session.state === "recoverable") {
        setState("recoverable");
      } else {
        setState("stream-pending");
      }
    } catch (err: unknown) {
      setState("error");
      setError(err instanceof BrowserProtocolError ? err.message : "Browser is unavailable right now.");
    }
  }, [session, surfaceId]);

  return {
    url,
    setUrl,
    state,
    error,
    frameDataUrl,
    session,
    surface,
    surfaceId,
    navigate,
    takeover,
    sendStreamMessage,
  };
}

function stateForErrorCode(code: string): BrowserConnectionState {
  if (code === "profile_locked" || code === "taken_over") return "locked";
  if (code === "idle_hibernated") return "hibernated";
  if (code === "recoverable_session") return "recoverable";
  if (code.includes("limit")) return "limit";
  return "error";
}
