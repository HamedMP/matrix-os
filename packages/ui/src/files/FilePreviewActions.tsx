import { useRef, useEffect, useState } from "react";

export function FilePreviewActions({ name, onDownload, onCopyImage, pending = false }: {
  name: string;
  onDownload?: () => Promise<void> | void;
  onCopyImage?: () => Promise<void>;
  pending?: boolean;
}) {
  const [state, setState] = useState<{ busy?: "download" | "copy"; error?: string; copied?: boolean }>({});
  const active = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const run = async (kind: "download" | "copy") => {
    if (inFlight.current || pending) return;
    inFlight.current = true;
    setState({ busy: kind });
    try {
      await (kind === "copy" ? onCopyImage?.() : onDownload?.());
      if (active.current) setState({ copied: kind === "copy" });
    } catch (error: unknown) {
      console.warn("[file-preview] action failed", error instanceof Error ? error.name : "UnknownError");
      if (active.current) setState({ error: kind === "copy" ? "Could not copy image. Try again." : "Could not download file. Try again." });
    } finally { inFlight.current = false; }
  };
  return <div className="flex flex-wrap items-center gap-2 text-xs">
    {onDownload ? <button type="button" aria-label={`Download ${name}`} disabled={pending || Boolean(state.busy)} onClick={() => void run("download")} className="rounded-md border px-2 py-1 hover:enabled:bg-[var(--bg-hover,var(--muted))] disabled:opacity-50">{pending || state.busy === "download" ? "Downloading…" : "Download"}</button> : null}
    {onCopyImage ? <button type="button" aria-label={`Copy image ${name}`} disabled={pending || Boolean(state.busy)} onClick={() => void run("copy")} className="rounded-md border px-2 py-1 hover:enabled:bg-[var(--bg-hover,var(--muted))] disabled:opacity-50">{state.busy === "copy" ? "Copying…" : "Copy image"}</button> : null}
    {state.error ? <span role="alert">{state.error}</span> : state.copied ? <span role="status">Image copied</span> : null}
  </div>;
}
