"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSocket, type ServerMessage } from "@/hooks/useSocket";
import {
  GlobeIcon,
  ArrowLeftIcon,
  RefreshCwIcon,
  XIcon,
  LoaderCircleIcon,
} from "lucide-react";

export function BrowserPanel() {
  const [url, setUrl] = useState("");
  const [inputUrl, setInputUrl] = useState("");
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(false);
  const [title, setTitle] = useState("");
  const imgRef = useRef<HTMLImageElement>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/browser/status`);
      const data = await res.json();
      setActive(data.active ?? false);
      if (data.url) {
        setUrl(data.url);
        setInputUrl(data.url);
      }
      if (data.title) setTitle(data.title);
      if (data.active) {
        setScreenshotUrl(`/api/browser/screenshot?t=${Date.now()}`);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const { subscribe } = useSocket();
  useEffect(() => {
    return subscribe((msg: ServerMessage) => {
      if (msg.type === "browser:screenshot") {
        setScreenshotUrl(`/files/${msg.path}?t=${Date.now()}`);
        fetchStatus();
      }
    });
  }, [subscribe, fetchStatus]);

  const navigate = useCallback(async (targetUrl: string) => {
    if (!targetUrl.trim()) return;
    let normalized = targetUrl.trim();
    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `https://${normalized}`;
    }
    setLoading(true);
    setInputUrl(normalized);
    try {
      const res = await fetch(`/api/browser/navigate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: normalized }),
      });
      const data = await res.json();
      if (data.ok) {
        setUrl(data.url ?? normalized);
        setInputUrl(data.url ?? normalized);
        setTitle(data.title ?? "");
        setActive(true);
        if (data.screenshotPath) {
          setScreenshotUrl(`/files/${data.screenshotPath}?t=${Date.now()}`);
        }
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  const closeBrowser = useCallback(async () => {
    await fetch(`/api/browser/close`, { method: "POST" }).catch(() => {});
    setActive(false);
    setScreenshotUrl(null);
    setUrl("");
    setTitle("");
  }, []);

  const handleClick = useCallback(async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!imgRef.current || !active) return;
    const rect = imgRef.current.getBoundingClientRect();
    const scaleX = imgRef.current.naturalWidth / rect.width;
    const scaleY = imgRef.current.naturalHeight / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    setLoading(true);
    try {
      const res = await fetch(`/api/browser/click`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x, y }),
      });
      const data = await res.json();
      if (data.screenshotPath) {
        setScreenshotUrl(`/files/${data.screenshotPath}?t=${Date.now()}`);
      }
      fetchStatus();
    } catch {
    } finally {
      setLoading(false);
    }
  }, [active, fetchStatus]);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* URL bar */}
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
            onKeyDown={(e) => e.key === "Enter" && navigate(inputUrl)}
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

      {/* Browser viewport */}
      <div className="flex-1 overflow-auto">
        {screenshotUrl ? (
          <img
            ref={imgRef}
            src={screenshotUrl}
            alt={title || "Browser"}
            className="w-full cursor-pointer"
            onClick={handleClick}
            draggable={false}
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

      {/* Status bar */}
      {active && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-1 text-[10px] text-muted-foreground">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          <span className="truncate">{title || url}</span>
        </div>
      )}
    </div>
  );
}
