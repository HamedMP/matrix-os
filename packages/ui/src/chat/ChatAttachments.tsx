import { useEffect, useState } from "react";

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
    {attachments.map((attachment) => <div key={attachment.id} className="max-w-full overflow-hidden rounded-xl border bg-[var(--bg-surface,var(--background))]" style={{ borderColor: "var(--border-default, var(--border))" }}>
      {attachment.kind === "image" && attachment.src ? <AttachmentImage src={attachment.src} label={attachment.label} onOpen={attachment.path && open ? () => open(attachment.path!) : undefined} loadImage={loadImage} /> : null}
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
  onOpen,
  loadImage,
}: {
  src: string;
  label: string;
  onOpen?: () => unknown;
  loadImage?: (src: string) => Promise<Blob>;
}) {
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
    <button type="button" disabled={!onOpen} onClick={onOpen} aria-label={`Open image ${label}`} className="block w-full">
      <img src={resolvedSrc} alt={label} onError={() => setResult({ src, url: "", failed: true })} className="block max-h-72 w-full object-contain" />
    </button>
  ) : (
    <span role="status" aria-label={`Loading ${label}`} className="block px-3 py-6 text-center text-xs" style={{ color: "var(--text-tertiary)" }}>
      Loading image…
    </span>
  );
}
