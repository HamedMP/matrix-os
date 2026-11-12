"use client";

import * as ContextMenu from "@radix-ui/react-context-menu";
import { useRef, useEffect, useState, type ReactElement } from "react";

/** File actions belong to the preview's context menu, keeping the image clear. */
export function FilePreviewActions({ name, children, onDownload, onCopyImage, onCopyPath, onOpenInFiles, pending = false, zIndex = 100 }: {
  name: string;
  children: ReactElement;
  onDownload?: () => Promise<void> | void;
  onCopyImage?: () => Promise<void>;
  onCopyPath?: () => Promise<void>;
  onOpenInFiles?: () => Promise<void> | void;
  pending?: boolean;
  zIndex?: number;
}) {
  type Action = "download" | "copy" | "path" | "files";
  const [state, setState] = useState<{ busy?: Action; error?: string; copied?: string }>({});
  const active = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const run = async (kind: Action) => {
    if (inFlight.current || pending) return;
    inFlight.current = true;
    setState({ busy: kind });
    try {
      await ({ copy: onCopyImage, download: onDownload, path: onCopyPath, files: onOpenInFiles }[kind]?.());
      if (active.current) setState({ copied: kind === "copy" ? "Image copied" : kind === "path" ? "Path copied" : undefined });
    } catch (error: unknown) {
      console.warn("[file-preview] action failed", error instanceof Error ? error.name : "UnknownError");
      if (active.current) setState({ error: { copy: "Could not copy image. Try again.", download: "Could not download file. Try again.", path: "Could not copy path. Try again.", files: "Could not open Files. Try again." }[kind] });
    } finally { inFlight.current = false; }
  };
  if (!onDownload && !onCopyImage && !onCopyPath && !onOpenInFiles) return children;
  const actions: Array<{ kind: Action; label: string; busyLabel?: string; available: boolean }> = [
    { kind: "files", label: "Open in Files", available: Boolean(onOpenInFiles) },
    { kind: "path", label: "Copy path", available: Boolean(onCopyPath) },
    { kind: "copy", label: "Copy image", busyLabel: "Copying…", available: Boolean(onCopyImage) },
    { kind: "download", label: "Download", busyLabel: "Downloading…", available: Boolean(onDownload) },
  ];
  const itemClass = "cursor-default rounded px-2.5 py-1.5 text-sm outline-none focus:bg-[var(--bg-hover,var(--muted))] data-[disabled]:opacity-40";
  return <ContextMenu.Root onOpenChange={(open) => { if (open && !inFlight.current) setState({}); }}>
    <ContextMenu.Trigger asChild onContextMenu={(event) => event.stopPropagation()}>{children}</ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content aria-label={`File actions for ${name}`} className="min-w-[180px] rounded-xl border p-1 shadow-lg" style={{
        zIndex, background: "var(--bg-overlay, var(--popover))", color: "var(--text-primary, var(--popover-foreground))", borderColor: "var(--border-default, var(--border))",
      }}>
        {actions.filter((action) => action.available).map((action) => <ContextMenu.Item key={action.kind}
          aria-label={`${action.label} ${name}`} disabled={pending || Boolean(state.busy)} className={itemClass}
          onSelect={(event) => { event.preventDefault(); void run(action.kind); }}>
          {action.busyLabel && (state.busy === action.kind || action.kind === "download" && pending) ? action.busyLabel : action.label}
        </ContextMenu.Item>)}
        {state.error ? <div role="alert" className="max-w-xs px-2.5 py-1.5 text-xs">{state.error}</div> : state.copied ? <div role="status" className="px-2.5 py-1.5 text-xs">{state.copied}</div> : null}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}
