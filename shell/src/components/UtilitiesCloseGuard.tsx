"use client";
import { useEffect, useId, useRef, type RefObject } from "react";
import { useWindowManager } from "@/hooks/useWindowManager";
import { readUtilitiesWorkspaceState, useUtilitiesCloseGuard } from "@/stores/utilities-close-guard";
import { extractSlug } from "./app-viewer-helpers";

export function UtilitiesCloseGuard({ iframeRef, path, windowId, onConfirmClose }: {
  iframeRef: RefObject<HTMLIFrameElement | null>; path: string; windowId?: string;
  onConfirmClose?: (id: string, all: boolean) => void;
}) {
  const owner = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useUtilitiesCloseGuard((state) => state.pending);
  const enabled = extractSlug(path) === "utilities" && Boolean(windowId);
  const open = enabled && pending?.id === windowId && pending?.path === path;
  useEffect(() => {
    if (!enabled || !windowId) return;
    const store = useUtilitiesCloseGuard.getState();
    store.register(windowId, owner);
    const onMessage = (event: MessageEvent) => {
      if (!iframeRef.current?.contentWindow || event.source !== iframeRef.current.contentWindow
        || (event.origin !== "null" && event.origin !== window.location.origin)) return;
      const message = readUtilitiesWorkspaceState(event.data);
      if (message) useUtilitiesCloseGuard.getState().update(windowId, owner, message.dirty);
    };
    window.addEventListener("message", onMessage);
    return () => { window.removeEventListener("message", onMessage); useUtilitiesCloseGuard.getState().release(windowId, owner); };
  }, [enabled, iframeRef, owner, windowId]);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  if (!enabled) return null;
  const cancel = () => { useUtilitiesCloseGuard.getState().cancel(); iframeRef.current?.focus(); };
  const confirm = () => {
    if (!windowId || useUtilitiesCloseGuard.getState().pending?.id !== windowId) return;
    const all = useUtilitiesCloseGuard.getState().pending?.all ?? false;
    useUtilitiesCloseGuard.getState().approve(windowId, owner);
    if (onConfirmClose) onConfirmClose(windowId, all);
    else useWindowManager.getState().closeWindow(windowId);
  };
  return <dialog ref={dialog} aria-labelledby={`${owner}-close-title`} className="m-auto max-w-md rounded-2xl border border-border bg-background p-6 text-foreground shadow-xl backdrop:bg-black/35" onCancel={(event) => { event.preventDefault(); cancel(); }}>
    <h2 id={`${owner}-close-title`} className="text-lg font-semibold">Close Utilities?</h2>
    <p className="mt-3 text-sm text-muted-foreground">Your input and results are temporary. Download or copy anything you need before closing.</p>
    <div className="mt-5 flex justify-end gap-3"><button autoFocus className="rounded-lg border border-border px-4 py-2 text-sm" onClick={cancel}>Keep working</button><button className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground" onClick={confirm}>Close Utilities</button></div>
  </dialog>;
}
