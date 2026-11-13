import { useLayoutEffect, useMemo, useRef } from "react";
import { openDesktopRoutineConfirmation } from "./routine-action-confirmation";

/** Capture this rendered Chat authority; a retained callback cannot borrow a later scope. */
export function useDesktopRoutineConfirmation({ client, identity, active, chatId, projectId }: {
  client: unknown; identity: unknown; active: boolean; chatId: string | null; projectId: string | null;
}) {
  const key = useMemo(() => ({ client, identity, active, chatId, projectId }), [client, identity, active, chatId, projectId]);
  const scope = useRef<{ key: typeof key; abort: AbortController } | null>(null);
  useLayoutEffect(() => {
    const current = { key, abort: new AbortController() };
    scope.current = active ? current : null;
    return () => { current.abort.abort(); if (scope.current === current) scope.current = null; };
  }, [key, active]);
  return useMemo(() => ({
    isCurrent: () => scope.current?.key === key && !scope.current.abort.signal.aborted,
    async open(challengeId: string) {
      const current = scope.current;
      if (!current || current.key !== key || current.abort.signal.aborted) throw new Error("Confirmation unavailable");
      await openDesktopRoutineConfirmation(challengeId, current.abort.signal);
    },
  }), [key]);
}
