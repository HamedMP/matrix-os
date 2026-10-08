"use client";
import { useCallback, useState } from "react";
import type { ChatNavigationRecord } from "@matrix-os/ui";

type Selection = { scope: string; id?: string; explicit: boolean; rejected: string[] };
/** Cache restoration is provisional; explicit user choices are never inferred from list membership. */
export function useCanonicalChatSelection({ scope, candidates, authoritativeItems, fresh, truncated, missingId, initialExplicit }: {
  scope: string;
  candidates: readonly ChatNavigationRecord[];
  authoritativeItems: readonly ChatNavigationRecord[];
  fresh: boolean;
  truncated: boolean;
  missingId?: string;
  initialExplicit: boolean;
}) {
  const [selection, setSelection] = useState<Selection>({ scope, explicit: initialExplicit, rejected: [] });
  const current: Selection = selection.scope === scope ? selection : { scope, explicit: initialExplicit, rejected: [] };
  // Bound rejected cache entries to the same 1,000-row navigation window.
  const rejected = missingId && !current.rejected.includes(missingId)
    ? [...current.rejected.slice(-999), missingId] : current.rejected;
  const removed = current.id !== undefined && (rejected.includes(current.id)
    || (fresh && !truncated && !authoritativeItems.some(item => item.chat.id === current.id)));
  const id = !current.explicit && (!current.id || removed)
    ? candidates.find(item => !rejected.includes(item.chat.id))?.chat.id : current.id;
  // Guarded render adjustment prevents a stale selection reaching detail effects.
  if (selection.scope !== scope || selection.id !== id || current.rejected !== rejected) setSelection({ ...current, id, rejected });
  const select = useCallback((id: string | undefined) => setSelection(previous => ({
    scope, id, explicit: true, rejected: previous.scope === scope ? previous.rejected : [],
  })), [scope]);
  return [id, select] as const;
}
