"use client";

import { useEffect, useRef, useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import { readBoundedFileBlob } from "@/lib/read-bounded-file-blob";
import {
  FilePreviewDescriptorSchema,
  resolveChatMessageLink,
  type FilePreviewDescriptor,
  type FileResourceRef,
} from "@matrix-os/contracts";
import {
  FilePreviewContent,
  filePreviewContentUrl,
  filePreviewMetadataUrl,
} from "@matrix-os/ui";

const CHAT_FILE_LIMIT_BYTES = 50 * 1024 * 1024;

function resourceForChatPath(path: string): FileResourceRef {
  const target = resolveChatMessageLink(path);
  if (target?.kind !== "file") throw new Error("InvalidChatFile");
  return { kind: "home", path: target.path };
}

function gatewayPreviewUrl(url: string): string {
  if (!url.startsWith("/api/file-previews/")) throw new Error("InvalidPreviewUrl");
  return `${getGatewayUrl()}${url}`;
}

async function fetchPreview(url: string, signal?: AbortSignal): Promise<Response> {
  return fetch(gatewayPreviewUrl(url), {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
  });
}

export async function loadChatFile(path: string, signal?: AbortSignal): Promise<Blob> {
  const resource = resourceForChatPath(path);
  return readBoundedFileBlob(await fetchPreview(filePreviewContentUrl(resource), signal), CHAT_FILE_LIMIT_BYTES);
}

async function loadDescriptor(path: string, signal?: AbortSignal): Promise<FilePreviewDescriptor> {
  const resource = resourceForChatPath(path);
  const response = await fetchPreview(filePreviewMetadataUrl(resource), signal);
  if (!response.ok) throw new Error("ChatFileUnavailable");
  return FilePreviewDescriptorSchema.parse(await response.json());
}

async function loadPreviewBlob(url: string, maxBytes: number): Promise<Blob> {
  return readBoundedFileBlob(await fetchPreview(url), Math.min(maxBytes, CHAT_FILE_LIMIT_BYTES));
}

async function loadPreviewText(url: string, maxBytes: number): Promise<string> {
  return (await loadPreviewBlob(url, maxBytes)).text();
}

export function ChatFilePanel({ path, onClose }: { path: string; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeButton.current?.focus(); }, [path]);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<(
    { status: "ready"; descriptor: FilePreviewDescriptor } | { status: "failed" }
  ) & { path: string; attempt: number }>();
  const state = result?.path === path && result.attempt === attempt ? result : { status: "loading" as const };
  useEffect(() => {
    const controller = new AbortController();
    void loadDescriptor(path, controller.signal).then((descriptor) => {
      if (!controller.signal.aborted) setResult({ status: "ready", descriptor, path, attempt });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[chat-file] preview failed", error instanceof Error ? error.name : "UnknownError");
      setResult({ status: "failed", path, attempt });
    });
    return () => controller.abort();
  }, [attempt, path]);
  const retry = () => setAttempt((value) => value + 1);
  return <aside aria-label="Chat file preview" className="absolute inset-y-0 right-0 z-30 flex w-[min(100%,520px)] flex-col border-l bg-background shadow-xl" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header className="flex items-center justify-between gap-2 border-b p-3"><span className="truncate text-sm">{path.split("/").at(-1)}</span><button ref={closeButton} type="button" onClick={onClose} className="rounded px-2 py-1 hover:bg-muted">Close preview</button></header>
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      {state.status === "failed" ? <div role="alert">File preview unavailable. The file may have moved or been removed.<button type="button" className="ml-2 underline" onClick={retry}>Retry</button></div>
        : state.status === "loading" ? <p role="status">Loading preview…</p>
          : <FilePreviewContent
              key={`${state.descriptor.version}:${attempt}`}
              descriptor={state.descriptor}
              contentUrl={filePreviewContentUrl(state.descriptor.resource)}
              loadBlob={loadPreviewBlob}
              loadText={loadPreviewText}
              showImageDownload
              retry={retry}
            />}
    </div>
  </aside>;
}
