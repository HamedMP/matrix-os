"use client";

import { useState, useEffect } from "react";
import { useFileBrowser } from "@/hooks/useFileBrowser";
import { usePreviewWindow } from "@/hooks/usePreviewWindow";
import { getGatewayUrl } from "@/lib/gateway";
import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";

const GATEWAY_URL = getGatewayUrl();

export function QuickLook() {
  const quickLookPath = useFileBrowser((s) => s.quickLookPath);
  const currentPath = useFileBrowser((s) => s.currentPath);
  const setQuickLookPath = useFileBrowser((s) => s.setQuickLookPath);
  const openFile = usePreviewWindow((s) => s.openFile);
  const [content, setContent] = useState<string | null>(null);

  const fullPath = quickLookPath
    ? currentPath
      ? `${currentPath}/${quickLookPath}`
      : quickLookPath
    : null;

  useEffect(() => {
    if (!fullPath) {
      setContent(null);
      return;
    }

    if (isImage(quickLookPath!)) {
      setContent(null);
      return;
    }

    fetch(`${GATEWAY_URL}/files/${fullPath}`)
      .then((r) => (r.ok ? r.text() : null))
      .then((text) => {
        if (text) setContent(text.split("\n").slice(0, 50).join("\n"));
        else setContent(null);
      })
      .catch(() => setContent(null));
  }, [fullPath, quickLookPath]);

  if (!quickLookPath || !fullPath) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={() => setQuickLookPath(null)}
      />
      <div
        className="relative bg-background border rounded-lg shadow-xl w-[75%] max-w-[600px] max-h-[80vh] flex flex-col animate-in fade-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between px-4 py-2 border-b">
          <div className="text-sm font-medium truncate">{quickLookPath}</div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                openFile(fullPath);
                setQuickLookPath(null);
              }}
            >
              Open
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setQuickLookPath(null)}
            >
              <XIcon className="size-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4 min-h-0">
          {isImage(quickLookPath) ? (
            <img
              src={`${GATEWAY_URL}/files/${fullPath}`}
              alt={quickLookPath}
              className="max-w-full max-h-full mx-auto object-contain"
            />
          ) : isAudio(quickLookPath) ? (
            <audio controls className="w-full" src={`${GATEWAY_URL}/files/${fullPath}`} />
          ) : isVideo(quickLookPath) ? (
            <video controls className="w-full max-h-96" src={`${GATEWAY_URL}/files/${fullPath}`} />
          ) : content !== null ? (
            <pre className="text-xs font-mono whitespace-pre-wrap break-all">
              {content}
            </pre>
          ) : (
            <div className="text-muted-foreground text-center">
              No preview available
            </div>
          )}
        </div>

        <div className="px-4 py-1.5 border-t text-xs text-muted-foreground text-center">
          Space to dismiss &mdash; Enter to open &mdash; Arrow keys to navigate
        </div>
      </div>
    </div>
  );
}

function isImage(name: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(name);
}

function isAudio(name: string): boolean {
  return /\.(mp3|wav)$/i.test(name);
}

function isVideo(name: string): boolean {
  return /\.(mp4|webm)$/i.test(name);
}
