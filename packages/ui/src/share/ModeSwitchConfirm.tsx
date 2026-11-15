"use client";
import { useEffect, useId, useRef } from "react";
import { modeSwitchCopy, type PageModeTarget } from "./share-model";
import { InlineError, ShareButton, Spinner } from "./share-controls";

/**
 * Inline confirm shown before switching the Matrix.page access mode. Nothing
 * changes until the owner confirms; the switch then uses the platform's
 * revision-checked transition.
 */
export function ModeSwitchConfirm({ current, target, invitedCount, pending, error, onConfirm, onCancel }: {
  current: PageModeTarget; target: PageModeTarget; invitedCount: number; pending: boolean; error: string | null;
  onConfirm: () => void; onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const copy = modeSwitchCopy(current, target, invitedCount);
  useEffect(() => { confirmRef.current?.focus(); }, [target]);
  // Non-modal inline <dialog open>: the popover stays usable, focus moves to the confirm action.
  return <dialog open aria-labelledby={titleId} aria-describedby={bodyId}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onCancel(); } }}
    className="static m-0 flex w-auto max-w-none flex-col gap-1 rounded-xl border border-[var(--share-border)] bg-[var(--share-panel)] p-3 text-[var(--share-fg)]">
    <div id={titleId} className="text-[13px] font-semibold">{copy.title}</div>
    <div id={bodyId} className="text-xs leading-[17px] text-[var(--share-muted-fg)]">{copy.body}</div>
    {error ? <InlineError>{error}</InlineError> : null}
    <div className="mt-2 flex gap-2">
      <ShareButton ref={confirmRef} variant="primary" size="sm" className="px-3" disabled={pending} onClick={onConfirm}>{pending ? <Spinner /> : null}{copy.cta}</ShareButton>
      <ShareButton size="sm" disabled={pending} onClick={onCancel}>Cancel</ShareButton>
    </div>
  </dialog>;
}
