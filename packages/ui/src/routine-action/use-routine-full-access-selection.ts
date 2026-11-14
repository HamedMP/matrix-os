import { useLayoutEffect, useMemo, useRef } from "react";
import { useRoutineFullAccess, type RoutineFullAccessContext } from "./use-routine-full-access.js";

/** Preserve the complete selected model/options while a context downgrade awaits revocation. */
export function useRoutineFullAccessSelection<Selection extends { permissionMode: string }>({ context, acceptedRunId, selection, onChange, isQualified }: {
  context?: RoutineFullAccessContext; selection: Selection | null; onChange: (selection: Selection) => void;
  acceptedRunId?: string;
  isQualified?: (selection: Selection) => boolean;
}) {
  // Run changes invalidate a pending selection only. The Chat-scoped revoke can still finish.
  const selectionRun = useMemo(() => ({ acceptedRunId }), [acceptedRunId]);
  const committedSelectionRun = useRef<typeof selectionRun | null>(null);
  useLayoutEffect(() => {
    committedSelectionRun.current = selectionRun;
    return () => { committedSelectionRun.current = null; };
  }, [selectionRun]);

  const controller = useRoutineFullAccess({ ...context, identity: context?.identity ?? "unavailable", enabled: context?.enabled ?? false,
    browserOrigin: false, permissionMode: selection?.permissionMode ?? "supervised", onPermissionModeChange: mode => {
      if (selection) onChange({ ...selection, permissionMode: mode });
    } });
  return { controller, onChange: (next: Selection) => controller.guardSelectionChange(
    isQualified?.(next) ?? Boolean(context?.enabled && next.permissionMode === "full_access"), () => {
      if (committedSelectionRun.current !== selectionRun) return;
      onChange(next);
      if (next.permissionMode === "full_access" && selection?.permissionMode !== "full_access" && context?.enabled) controller.beginReview();
    }) };
}
