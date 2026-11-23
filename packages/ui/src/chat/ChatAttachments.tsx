import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { resolveChatMessageLink, type ImportedChatAssetRef } from "@matrix-os/contracts";
import { Dialog } from "../Dialog.js";
import { chatImageDownloadFilename, savePreviewBlob } from "../files/file-image-actions.js";

export interface ChatMessageAttachment {
  id: string;
  label: string;
  kind: "file" | "image";
  path?: string;
  src?: string;
  importAsset?: ImportedChatAssetRef;
}

export function ChatAttachments({ attachments, open, loadImage, openImportedAsset, align = "end" }: {
  attachments: ChatMessageAttachment[];
  open?: (path: string) => boolean | void;
  loadImage?: (src: string) => Promise<Blob>;
  align?: "start" | "end";
  openImportedAsset?: (ref: ImportedChatAssetRef) => Promise<void>;
}) {
  return <div className={`flex max-w-[min(85%,48rem)] flex-wrap gap-2 ${align === "start" ? "justify-start" : "ml-auto justify-end"}`}>
    {attachments.map((attachment) => attachment.kind === "image" && attachment.src
      ? <div key={attachment.id}><AttachmentImage src={attachment.src} label={attachment.label} path={attachment.path} open={open} loadImage={loadImage} />
        {attachment.importAsset ? <ImportedAssetButton refValue={attachment.importAsset} open={openImportedAsset} /> : null}</div>
      : <div key={attachment.id} className="max-w-full overflow-hidden rounded-xl border bg-[var(--bg-surface,var(--background))]" style={{ borderColor: "var(--border-default, var(--border))" }}>
      {attachment.importAsset ? <ImportedAssetButton refValue={attachment.importAsset} open={openImportedAsset} /> : <button type="button" disabled={!attachment.path || !open} aria-label={`Preview ${attachment.label}`}
        onClick={() => attachment.path && open?.(attachment.path)} className="flex max-w-full items-center gap-2 px-3 py-2 text-sm hover:enabled:bg-[var(--bg-hover,var(--muted))] disabled:cursor-default">
        <span aria-hidden>{attachment.kind === "image" ? "▧" : "▤"}</span><span className="truncate">{attachment.label}</span>
      </button>}
    </div>)}
  </div>;
}

function ImportedAssetButton({ refValue, open }: { refValue: ImportedChatAssetRef; open?: (ref: ImportedChatAssetRef) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  return <span className="block max-w-full">
    <button type="button" disabled={!open || pending} aria-label={`Download ${refValue.label}`}
      className="flex max-w-full items-center gap-2 px-3 py-2 text-sm disabled:opacity-50"
      onClick={() => {
        if (!open || pending) return; setPending(true); setFailed(false);
        void open(refValue).catch((error: unknown) => {
          console.warn("[chat/import] asset download unavailable", error instanceof Error ? error.name : "UnknownError"); setFailed(true);
        }).finally(() => setPending(false));
      }}><span aria-hidden>▤</span><span className="truncate">{pending ? "Downloading…" : refValue.label}</span></button>
    {failed ? <span role="alert" className="block px-3 pb-2 text-xs">Download unavailable. Try again.</span> : null}
  </span>;
}

export function AttachmentImage({
  src,
  label,
  path,
  open,
  loadImage,
  openInBrowser,
  inline = false,
}: {
  src: string;
  label: string;
  path?: string;
  open?: (path: string) => boolean | void;
  loadImage?: (src: string) => Promise<Blob>;
  openInBrowser?: (src: string) => Promise<void>;
  inline?: boolean;
}) {
  const [enlarged, setEnlarged] = useState(false);
  const [browserError, setBrowserError] = useState<string>();
  const thumbnailRef = useRef<HTMLButtonElement>(null);
  const wasEnlarged = useRef(false);
  useEffect(() => {
    if (wasEnlarged.current && !enlarged) thumbnailRef.current?.focus();
    wasEnlarged.current = enlarged;
  }, [enlarged]);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ src: string; loader?: typeof loadImage; url: string; failed: boolean; blob?: Blob }>({ src, loader: loadImage, url: loadImage ? "" : src, failed: false });
  const currentResult = result.src === src && result.loader === loadImage ? result : null;
  const resolvedSrc = currentResult?.url ?? "";
  const blob = currentResult?.blob;
  const source = resolveChatMessageLink(path ?? src);
  const filename = blob ? chatImageDownloadFilename(source?.kind === "file" ? source.path : label, blob) : null;
  useEffect(() => {
    if (!loadImage) {
      setResult({ src, url: src, failed: false });
      return;
    }
    setResult({ src, loader: loadImage, url: "", failed: false });
    let active = true;
    let objectUrl: string | undefined;
    // A loader that throws or returns something other than a Blob shows the
    // same safe "preview unavailable" state instead of an uncaught error.
    let loading: Promise<unknown>;
    try { loading = Promise.resolve(loadImage(src)); }
    catch (error: unknown) { loading = Promise.reject(error); }
    void loading.then((blob) => {
      if (!active) return;
      if (!(blob instanceof Blob)) throw new TypeError("ImagePreviewUnavailable");
      objectUrl = URL.createObjectURL(blob);
      setResult({ src, loader: loadImage, url: objectUrl, failed: false, blob });
    }).catch((error: unknown) => {
      console.warn("[conversation] image preview unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (active) setResult({ src, loader: loadImage, url: "", failed: true });
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attempt, loadImage, src]);
  const fail = () => {
    setEnlarged(false);
    setResult({ src, loader: loadImage, url: "", failed: true });
  };
  if (currentResult?.failed) return <span role="alert" className="block p-3 text-xs">
    Image preview unavailable.
    <button type="button" aria-label={`Retry ${label}`} className="ml-2 underline" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
  </span>;
  return resolvedSrc ? (
    <>
      <button ref={thumbnailRef} type="button" onClick={() => { setBrowserError(undefined); setEnlarged(true); }} aria-label={`Open image ${label}`} title={label}
        className="block shrink-0 overflow-hidden rounded-xl border cursor-zoom-in focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ width: inline ? "min(100%, 480px)" : 96, height: inline ? "auto" : 96, maxWidth: "100%", borderColor: "var(--border-default, var(--border))", background: "var(--bg-surface, var(--background))" }}>
        <img src={resolvedSrc} alt={label} onError={fail} className={inline ? "block max-h-96 max-w-full object-contain" : "block h-full w-full object-cover"} />
        <span className="sr-only">{label}</span>
      </button>
      {enlarged ? createPortal(<Dialog open onClose={() => setEnlarged(false)} aria-label={`Image preview: ${label}`}
        style={{ width: "fit-content", maxWidth: "92vw", maxHeight: "90vh", padding: 12, background: "var(--bg-surface, var(--matrix-card))", color: "var(--text-primary, var(--matrix-card-fg))" }}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 truncate text-sm">{label}</span>
          <div className="flex flex-wrap items-center gap-2">
            {blob && filename ? <button type="button" aria-label="Download image" onClick={() => savePreviewBlob(blob, filename)}
              className="rounded-lg border px-3 py-1 text-sm">Download</button> : null}
            {openInBrowser ? <button type="button" onClick={() => {
              setBrowserError(undefined);
              void openInBrowser(src).catch((error: unknown) => {
                console.warn("[conversation] image could not open in browser", error instanceof Error ? error.name : "UnknownError");
                setBrowserError(src);
              });
            }} className="rounded-lg border px-3 py-1 text-sm">Open in browser</button> : null}
            {path && open ? (
              <button type="button" aria-label={`Open ${label} in File Preview`} onClick={() => {
                if (open(path) !== false) setEnlarged(false);
              }} className="rounded-lg border px-3 py-1 text-sm">
                File Preview
              </button>
            ) : null}
            <button type="button" aria-label="Close image preview" onClick={() => setEnlarged(false)} className="rounded-lg border px-3 py-1 text-sm">Close</button>
          </div>
        </div>
        {browserError === src ? <p className="mb-2 text-sm" role="alert">Could not open the image in your browser.</p> : null}
        <img src={resolvedSrc} alt={`Full size ${label}`} onError={fail} style={{ display: "block", maxWidth: "calc(92vw - 24px)", maxHeight: "calc(90vh - 76px)", objectFit: "contain" }} />
      </Dialog>, document.body) : null}
    </>
  ) : (
    <span role="status" aria-label={`Loading ${label}`} className="block px-3 py-6 text-center text-xs" style={{ color: "var(--text-tertiary)" }}>
      Loading image…
    </span>
  );
}
