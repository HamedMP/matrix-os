import { useEffect, useRef, useState } from "react";
import { Dialog } from "../Dialog.js";

export interface ChatMessageAttachment {
  id: string;
  label: string;
  kind: "file" | "image";
  path?: string;
  src?: string;
}

export function ChatAttachments({ attachments, open, loadImage }: {
  attachments: ChatMessageAttachment[];
  open?: (path: string) => boolean | void;
  loadImage?: (src: string) => Promise<Blob>;
}) {
  return <div className="ml-auto flex max-w-[min(85%,48rem)] flex-wrap justify-end gap-2">
    {attachments.map((attachment) => attachment.kind === "image" && attachment.src
      ? <AttachmentImage key={attachment.id} src={attachment.src} label={attachment.label} loadImage={loadImage} />
      : <div key={attachment.id} className="max-w-full overflow-hidden rounded-xl border bg-[var(--bg-surface,var(--background))]" style={{ borderColor: "var(--border-default, var(--border))" }}>
      <button type="button" disabled={!attachment.path || !open} aria-label={`Preview ${attachment.label}`}
        onClick={() => attachment.path && open?.(attachment.path)} className="flex max-w-full items-center gap-2 px-3 py-2 text-sm hover:enabled:bg-[var(--bg-hover,var(--muted))] disabled:cursor-default">
        <span aria-hidden>{attachment.kind === "image" ? "▧" : "▤"}</span><span className="truncate">{attachment.label}</span>
      </button>
    </div>)}
  </div>;
}

function AttachmentImage({
  src,
  label,
  loadImage,
}: {
  src: string;
  label: string;
  loadImage?: (src: string) => Promise<Blob>;
}) {
  const [enlarged, setEnlarged] = useState(false);
  const thumbnailRef = useRef<HTMLButtonElement>(null);
  const wasEnlarged = useRef(false);
  useEffect(() => {
    if (wasEnlarged.current && !enlarged) thumbnailRef.current?.focus();
    wasEnlarged.current = enlarged;
  }, [enlarged]);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ src: string; url: string; failed: boolean }>({ src, url: loadImage ? "" : src, failed: false });
  const resolvedSrc = result.src === src ? result.url : "";
  const failed = result.src === src && result.failed;
  useEffect(() => {
    if (!loadImage) {
      setResult({ src, url: src, failed: false });
      return;
    }
    setResult({ src, url: "", failed: false });
    let active = true;
    let objectUrl: string | undefined;
    void loadImage(src).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setResult({ src, url: objectUrl, failed: false });
    }).catch((error: unknown) => {
      console.warn("[conversation] image preview unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (active) setResult({ src, url: "", failed: true });
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attempt, loadImage, src]);
  if (failed) return <span className="block p-3 text-xs">
    Image preview unavailable.
    <button type="button" aria-label={`Retry ${label}`} className="ml-2 underline" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
  </span>;
  return resolvedSrc ? (
    <>
      <button ref={thumbnailRef} type="button" onClick={() => setEnlarged(true)} aria-label={`Open image ${label}`} title={label}
        className="block shrink-0 overflow-hidden rounded-xl border cursor-zoom-in focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ width: 96, height: 96, borderColor: "var(--border-default, var(--border))", background: "var(--bg-surface, var(--background))" }}>
        <img src={resolvedSrc} alt={label} onError={() => setResult({ src, url: "", failed: true })} className="block h-full w-full object-cover" />
        <span className="sr-only">{label}</span>
      </button>
      {enlarged ? <Dialog open onClose={() => setEnlarged(false)} aria-label={`Image preview: ${label}`}
        style={{ width: "fit-content", maxWidth: "92vw", maxHeight: "90vh", padding: 12, background: "var(--bg-surface, var(--matrix-card))", color: "var(--text-primary, var(--matrix-card-fg))" }}>
        <div className="mb-3 flex items-center justify-between gap-4">
          <span className="min-w-0 truncate text-sm">{label}</span>
          <button type="button" aria-label="Close image preview" onClick={() => setEnlarged(false)} className="shrink-0 rounded-lg border px-3 py-1 text-sm">Close</button>
        </div>
        <img src={resolvedSrc} alt={`Full size ${label}`} style={{ display: "block", maxWidth: "calc(92vw - 24px)", maxHeight: "calc(90vh - 76px)", objectFit: "contain" }} />
      </Dialog> : null}
    </>
  ) : (
    <span role="status" aria-label={`Loading ${label}`} className="block px-3 py-6 text-center text-xs" style={{ color: "var(--text-tertiary)" }}>
      Loading image…
    </span>
  );
}
