"use client";

import { useGettingStartedBlocker } from "@matrix-os/ui";
import { useState, useEffect } from "react";
import { useFileBrowser } from "@/hooks/useFileBrowser";
import { Button } from "@/components/ui/button";
import { FileDownloadAction } from "./FileDownloadProvider";
import { XIcon } from "@/lib/hugeicons";

const QUICK_LOOK_FETCH_TIMEOUT_MS = 10_000;

export function QuickLook({ gatewayUrl, onOpenFile }: { gatewayUrl: string; onOpenFile(path: string): void }) {
  const quickLookPath = useFileBrowser((s) => s.quickLookPath);
  const entries = useFileBrowser((s) => s.entries);
  const currentPath = useFileBrowser((s) => s.currentPath);
  const setQuickLookPath = useFileBrowser((s) => s.setQuickLookPath);

  const fullPath = quickLookPath
    ? currentPath
      ? `${currentPath}/${quickLookPath}`
      : quickLookPath
    : null;

  useGettingStartedBlocker(Boolean(quickLookPath && fullPath));

  if (!quickLookPath || !fullPath) return null;
  const fileUrl = `${gatewayUrl}/files/${fullPath}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      // react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- custom overlay modal with backdrop; native <dialog> would change top-layer/focus semantics
      // react-doctor-disable-next-line react-doctor/prefer-html-dialog -- intentional ARIA dialog, not a native <dialog>: this is a light-dismiss Quick Look overlay rendered in normal flow with a backdrop button. A native <dialog> promotes to the top layer and traps focus, which would change dismiss/focus semantics and conflict with the shell's z-index/overlay model.
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Close preview"
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={() => setQuickLookPath(null)}
      />
      <div
        className="relative bg-background border rounded-lg shadow-xl w-[75%] max-w-[600px] max-h-[80vh] flex flex-col animate-in fade-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between px-4 py-2 border-b">
          <div className="text-sm font-medium truncate">{quickLookPath}</div>
          <div className="flex items-center gap-2">
            {entries.find((entry) => entry.name === quickLookPath)?.type === "file" ? <FileDownloadAction path={fullPath} size={entries.find((entry) => entry.name === quickLookPath)?.size} /> : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onOpenFile(fullPath);
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
            // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- arbitrary user file served from gateway; next/image cannot optimize dynamic gateway URLs
            <img
              src={fileUrl}
              alt={quickLookPath}
              className="max-w-full max-h-full mx-auto object-contain"
            />
          ) : isAudio(quickLookPath) ? (
            // react-doctor-disable-next-line react-doctor/media-has-caption -- arbitrary user audio file preview; no caption track exists
            <audio controls aria-label={`Audio preview: ${quickLookPath}`} className="w-full" src={fileUrl} />
          ) : isVideo(quickLookPath) ? (
            // react-doctor-disable-next-line react-doctor/media-has-caption -- arbitrary user video file preview; no caption track exists
            <video controls aria-label={`Video preview: ${quickLookPath}`} className="w-full max-h-96" src={fileUrl} />
          ) : (
            <QuickLookText key={fileUrl} fileUrl={fileUrl} />
          )}
        </div>

        <div className="px-4 py-1.5 border-t text-xs text-muted-foreground text-center">
          Space to dismiss &mdash; Enter to open &mdash; Arrow keys to navigate
        </div>
      </div>
    </div>
  );
}

function QuickLookText({ fileUrl }: { fileUrl: string }) {
  const [content, setContent] = useState<string | null>(null);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- load the selected file with a bounded request and cancel it when the selection changes.
  useEffect(() => {
    const controller = new AbortController();
    fetch(fileUrl, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(QUICK_LOOK_FETCH_TIMEOUT_MS)]) })
      .then((response) => response.ok ? response.text() : null)
      .then((text) => {
        if (!controller.signal.aborted && text) setContent(text.split("\n").slice(0, 50).join("\n"));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.warn("Failed to load quick look preview", error instanceof Error ? error.name : "UnknownError");
        }
      });
    return () => controller.abort();
  }, [fileUrl]);

  return content === null
    ? <div className="text-muted-foreground text-center">No preview available</div>
    : <pre className="text-xs font-mono whitespace-pre-wrap break-all">{content}</pre>;
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
