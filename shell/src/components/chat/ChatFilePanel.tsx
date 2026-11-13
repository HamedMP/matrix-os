"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import {
  FilePreviewDescriptorSchema,
  FileResourceRefSchema,
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
  // Message links are resolved by their caller; the file tree supplies literal paths.
  const resource = FileResourceRefSchema.safeParse({ kind: "home", path });
  if (!resource.success) throw new Error("InvalidChatFile");
  return resource.data;
}

function gatewayPreviewUrl(url: string, gatewayUrl = getGatewayUrl()): string {
  if (!url.startsWith("/api/file-previews/")) throw new Error("InvalidPreviewUrl");
  return `${gatewayUrl}${url}`;
}

async function readBoundedBlob(response: Response, maxBytes: number): Promise<Blob> {
  if (!response.ok || !response.body) throw new Error("ChatFileUnavailable");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("ChatFileTooLarge");
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error("ChatFileTooLarge"); }
      chunks.push(new Uint8Array(part.value));
    }
  } finally { reader.releaseLock(); }
  return new Blob(chunks, { type: response.headers.get("content-type") ?? "application/octet-stream" });
}

async function fetchPreview(url: string, signal?: AbortSignal, gatewayUrl?: string): Promise<Response> {
  return fetch(gatewayPreviewUrl(url, gatewayUrl), {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
  });
}

export async function loadChatFile(path: string, signal?: AbortSignal): Promise<Blob> {
  const resource = resourceForChatPath(path);
  return readBoundedBlob(await fetchPreview(filePreviewContentUrl(resource), signal), CHAT_FILE_LIMIT_BYTES);
}

async function loadDescriptor(path: string, signal?: AbortSignal, gatewayUrl?: string): Promise<FilePreviewDescriptor> {
  const resource = resourceForChatPath(path);
  const response = await fetchPreview(filePreviewMetadataUrl(resource), signal, gatewayUrl);
  if (!response.ok) throw new Error("ChatFileUnavailable");
  return FilePreviewDescriptorSchema.parse(await response.json());
}

async function loadPreviewBlob(url: string, maxBytes: number, gatewayUrl?: string): Promise<Blob> {
  return readBoundedBlob(await fetchPreview(url, undefined, gatewayUrl), Math.min(maxBytes, CHAT_FILE_LIMIT_BYTES));
}

async function loadPreviewText(url: string, maxBytes: number, gatewayUrl?: string): Promise<string> {
  return (await loadPreviewBlob(url, maxBytes, gatewayUrl)).text();
}

export function ChatFilePanel({ path, onClose, embedded = false, gatewayUrl }: { path: string; onClose: () => void; embedded?: boolean; gatewayUrl?: string }) {
  // These identities control FilePreviewContent's fetch/object-URL lifetime.
  const loadBlob = useCallback((url: string, maxBytes: number) => loadPreviewBlob(url, maxBytes, gatewayUrl), [gatewayUrl]);
  const loadText = useCallback((url: string, maxBytes: number) => loadPreviewText(url, maxBytes, gatewayUrl), [gatewayUrl]);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeButton.current?.focus(); }, [path]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; descriptor: FilePreviewDescriptor } | { status: "failed" }
  >({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void loadDescriptor(path, controller.signal, gatewayUrl).then((descriptor) => {
      if (!controller.signal.aborted) setState({ status: "ready", descriptor });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[chat-file] preview failed", error instanceof Error ? error.name : "UnknownError");
      setState({ status: "failed" });
    });
    return () => controller.abort();
  }, [attempt, path, gatewayUrl]);
  const retry = () => setAttempt((value) => value + 1);
  return <aside aria-label="Chat file preview" className={embedded ? "flex min-h-0 w-full flex-1 flex-col bg-background" : "absolute inset-y-0 right-0 z-30 flex w-[min(100%,520px)] flex-col border-l bg-background shadow-xl"} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header className="flex items-center justify-between gap-2 border-b p-3"><span className="truncate text-sm">{path.split("/").at(-1)}</span><button ref={closeButton} type="button" onClick={onClose} className="rounded px-2 py-1 hover:bg-muted">Close preview</button></header>
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      {state.status === "failed" ? <div role="alert">File preview unavailable. The file may have moved or been removed.<button type="button" className="ml-2 underline" onClick={retry}>Retry</button></div>
        : state.status === "loading" ? <p role="status">Loading preview…</p>
          : <FilePreviewContent
              key={`${state.descriptor.version}:${attempt}`}
              descriptor={state.descriptor}
              contentUrl={filePreviewContentUrl(state.descriptor.resource)}
              loadBlob={loadBlob}
              loadText={loadText}
              retry={retry}
            />}
    </div>
  </aside>;
}
