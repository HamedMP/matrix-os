"use client";

import * as ContextMenu from "@radix-ui/react-context-menu";
import { useRef, useEffect, useState, type ReactElement } from "react";

/** File actions belong to the preview's context menu, keeping the image clear. */
export function FilePreviewActions({ name, children, onDownload, onCopyImage, pending = false, zIndex = 100 }: {
  name: string;
  children: ReactElement;
  onDownload?: () => Promise<void> | void;
  onCopyImage?: () => Promise<void>;
  pending?: boolean;
  zIndex?: number;
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
  if (!onDownload && !onCopyImage) return children;
  const itemClass = "cursor-default rounded px-2.5 py-1.5 text-sm outline-none focus:bg-[var(--bg-hover,var(--muted))] data-[disabled]:opacity-40";
  return <ContextMenu.Root onOpenChange={(open) => { if (open && !inFlight.current) setState({}); }}>
    <ContextMenu.Trigger asChild onContextMenu={(event) => event.stopPropagation()}>{children}</ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content aria-label={`File actions for ${name}`} className="min-w-[180px] rounded-xl border p-1 shadow-lg" style={{
        zIndex, background: "var(--bg-overlay, var(--popover))", color: "var(--text-primary, var(--popover-foreground))", borderColor: "var(--border-default, var(--border))",
      }}>
        {onCopyImage ? <ContextMenu.Item aria-label={`Copy image ${name}`} disabled={pending || Boolean(state.busy)} className={itemClass}
          onSelect={(event) => { event.preventDefault(); void run("copy"); }}>{state.busy === "copy" ? "Copying…" : "Copy image"}</ContextMenu.Item> : null}
        {onDownload ? <ContextMenu.Item aria-label={`Download ${name}`} disabled={pending || Boolean(state.busy)} className={itemClass}
          onSelect={(event) => { event.preventDefault(); void run("download"); }}>{pending || state.busy === "download" ? "Downloading…" : "Download"}</ContextMenu.Item> : null}
        {state.error ? <div role="alert" className="max-w-xs px-2.5 py-1.5 text-xs">{state.error}</div> : state.copied ? <div role="status" className="px-2.5 py-1.5 text-xs">Image copied</div> : null}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}
