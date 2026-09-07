"use client";

import { useEffect, useRef, useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import { resolveChatMessageLink } from "@matrix-os/contracts";

export async function loadChatFile(path: string, signal?: AbortSignal): Promise<Blob> {
  const target = resolveChatMessageLink(path);
  if (target?.kind !== "file") throw new Error("InvalidChatFile");
  const response = await fetch(`${getGatewayUrl()}/api/files/blob?path=${encodeURIComponent(target.path)}`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  });
  if (!response.ok || !response.body) throw new Error("ChatFileUnavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new Error("ChatFileTooLarge"); }
      chunks.push(new Uint8Array(part.value));
    }
  } finally { reader.releaseLock(); }
  return new Blob(chunks, { type: response.headers.get("content-type") ?? "application/octet-stream" });
}

export function ChatFilePanel({ path, onClose }: { path: string; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeButton.current?.focus(); }, [path]);
  const [attempt, setAttempt] = useState(0);
  const [content, setContent] = useState<{ kind: "text" | "image" | "unsupported"; value: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setContent(null); setFailed(false);
    void loadChatFile(path, controller.signal).then(async (blob) => {
      if (controller.signal.aborted) return;
      if (/^image\/(png|jpeg|gif|webp|avif)/.test(blob.type)) {
        url = URL.createObjectURL(blob); setContent({ kind: "image", value: url });
      } else if (blob.type.startsWith("text/") || /json|javascript|xml/.test(blob.type)) {
        const text = await blob.text();
        if (!controller.signal.aborted) setContent({ kind: "text", value: text.length > 100_000 ? text.slice(0, 100_000) + "\n\n[Preview limited to the first 100,000 characters.]" : text });
      } else setContent({ kind: "unsupported", value: "" });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[chat-file] preview failed", error instanceof Error ? error.name : "UnknownError");
      setFailed(true);
    });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [attempt, path]);
  return <aside aria-label="Chat file preview" className="absolute inset-y-0 right-0 z-30 flex w-[min(100%,520px)] flex-col border-l bg-background shadow-xl" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header className="flex items-center justify-between gap-2 border-b p-3"><span className="truncate text-sm">{path.split("/").at(-1)}</span><button ref={closeButton} type="button" onClick={onClose} className="rounded px-2 py-1 hover:bg-muted">Close preview</button></header>
    <div className="min-h-0 flex-1 overflow-auto p-4">
      {failed ? <div role="alert">File preview unavailable. The file may have moved or been removed.<button type="button" className="ml-2 underline" onClick={() => setAttempt((value) => value + 1)}>Retry</button></div>
        : !content ? <p role="status">Loading preview…</p>
          : content.kind === "image" ? <img src={content.value} alt={path.split("/").at(-1)} className="max-w-full" />
            : content.kind === "text" ? <pre className="whitespace-pre-wrap break-words text-xs">{content.value}</pre>
              : <p>This file type does not support a preview.</p>}
    </div>
  </aside>;
}
