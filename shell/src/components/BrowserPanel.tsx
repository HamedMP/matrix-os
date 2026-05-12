"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getGatewayWs } from "@/lib/gateway";
import {
  GlobeIcon,
  RefreshCwIcon,
  XIcon,
  LoaderCircleIcon,
} from "lucide-react";

export function BrowserPanel() {
  const [url, setUrl] = useState("");
  const [inputUrl, setInputUrl] = useState("");
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [connected, setConnected] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportSize = useRef({ width: 1280, height: 800 });

  const getScale = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 1, y: 1 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: viewportSize.current.width / rect.width,
      y: viewportSize.current.height / rect.height,
    };
  }, []);

  const connectWs = useCallback(() => {
    const base = getGatewayWs().replace("/ws", "");
    const wsUrl = `${base}/ws/browser`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    if (!imgRef.current) {
      imgRef.current = new Image();
    }

    ws.onopen = () => setConnected(true);

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "frame") {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          const img = imgRef.current!;
          img.onload = () => {
            if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              viewportSize.current = { width: img.naturalWidth, height: img.naturalHeight };
            }
            ctx.drawImage(img, 0, 0);
          };
          img.src = "data:image/jpeg;base64," + msg.data;
          setActive(true);
          setLoading(false);
        } else if (msg.type === "status") {
          setActive(msg.active);
          if (msg.url) { setUrl(msg.url); setInputUrl(msg.url); }
          if (msg.title) setTitle(msg.title);
          setLoading(false);
        } else if (msg.type === "closed") {
          setActive(false);
        }
      } catch {}
    };

    ws.onclose = () => {
      setConnected(false);
      setTimeout(() => {
        if (wsRef.current === ws) connectWs();
      }, 2000);
    };
  }, []);

  useEffect(() => {
    connectWs();
    return () => {
      if (wsRef.current) {
        const ws = wsRef.current;
        wsRef.current = null;
        ws.close();
      }
    };
  }, [connectWs]);

  const sendWs = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const navigate = useCallback((targetUrl: string) => {
    if (!targetUrl.trim()) return;
    let normalized = targetUrl.trim();
    if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
    setInputUrl(normalized);
    setLoading(true);
    sendWs({ type: "navigate", url: normalized });
  }, [sendWs]);

  const closeBrowser = useCallback(async () => {
    await fetch("/api/browser/close", { method: "POST" }).catch(() => {});
    setActive(false);
    setUrl("");
    setTitle("");
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  const handleMouseEvent = useCallback((e: React.MouseEvent, type: string) => {
    const scale = getScale();
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) * scale.x);
    const y = Math.round((e.clientY - rect.top) * scale.y);
    const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
    sendWs({
      type: "mouse",
      params: { type, x, y, button, clickCount: type === "mousePressed" ? 1 : 0, modifiers: 0 },
    });
  }, [getScale, sendWs]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    const scale = getScale();
    const rect = canvasRef.current!.getBoundingClientRect();
    sendWs({
      type: "wheel",
      x: Math.round((e.clientX - rect.left) * scale.x),
      y: Math.round((e.clientY - rect.top) * scale.y),
      deltaX: e.deltaX,
      deltaY: e.deltaY,
    });
  }, [getScale, sendWs]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    const modifiers = (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
    sendWs({
      type: "key",
      params: {
        type: "keyDown",
        key: e.key,
        code: e.code,
        windowsVirtualKeyCode: e.keyCode,
        modifiers,
        text: e.key.length === 1 ? e.key : undefined,
      },
    });
    if (e.key.length === 1) {
      sendWs({
        type: "key",
        params: { type: "char", text: e.key, key: e.key, code: e.code, modifiers },
      });
    }
  }, [sendWs]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    const modifiers = (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
    sendWs({
      type: "key",
      params: { type: "keyUp", key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, modifiers },
    });
  }, [sendWs]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <button
          onClick={() => navigate(url)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Refresh"
        >
          <RefreshCwIcon className="size-3.5" />
        </button>
        <div className="flex flex-1 items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1">
          <GlobeIcon className="size-3 shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); navigate(inputUrl); } }}
            placeholder="Enter URL..."
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
          />
          {loading && <LoaderCircleIcon className="size-3 animate-spin text-muted-foreground" />}
        </div>
        {active && (
          <button
            onClick={closeBrowser}
            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="Close browser"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>

      <div ref={containerRef} className="flex-1 overflow-hidden relative">
        {active ? (
          <canvas
            ref={canvasRef}
            tabIndex={0}
            className="w-full h-full object-contain cursor-default outline-none"
            style={{ imageRendering: "auto" }}
            onMouseDown={(e) => handleMouseEvent(e, "mousePressed")}
            onMouseUp={(e) => handleMouseEvent(e, "mouseReleased")}
            onMouseMove={(e) => handleMouseEvent(e, "mouseMoved")}
            onWheel={handleWheel}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onContextMenu={(e) => e.preventDefault()}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <GlobeIcon className="size-10 opacity-20" />
            <p className="text-sm">Enter a URL to start browsing</p>
            <p className="text-xs opacity-60">
              Browse here, then ask your agent to continue
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-3 py-1 text-[10px] text-muted-foreground">
        <span className={`size-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-amber-500"}`} />
        <span className="truncate">{active ? (title || url || "Browser") : "Not connected"}</span>
      </div>
    </div>
  );
}
