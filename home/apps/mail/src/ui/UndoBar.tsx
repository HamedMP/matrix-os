/**
 * The undo toast after a triage action. It follows `state.undo`, offers Undo
 * and dismisses itself after a few seconds.
 */
import { useEffect } from "react";
import { Undo2, X } from "lucide-react";
import type { UndoEntry } from "../model";
import { useMailUi } from "./context";

export const UNDO_VISIBLE_MS = 8000;

export function UndoBar({ undo }: { undo: UndoEntry | null }) {
  const { store } = useMailUi();
  const at = undo?.at;
  useEffect(() => {
    if (at === undefined) return undefined;
    const timer = setTimeout(() => store.dismissUndo(), UNDO_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [at, store]);
  if (!undo) return null;
  return (
    <div className="mail-undo" role="status" aria-live="polite">
      <span className="mail-undo__label">{undo.label}</span>
      <button type="button" className="oui-button oui-button--ghost mail-undo__action" onClick={() => void store.undo()}>
        <Undo2 size={14} aria-hidden="true" /> Undo
      </button>
      <button type="button" className="oui-icon-button" aria-label="Dismiss" onClick={() => store.dismissUndo()}><X size={14} /></button>
    </div>
  );
}
