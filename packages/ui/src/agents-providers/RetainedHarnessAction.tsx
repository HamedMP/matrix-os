import { useEffect, useRef, useState } from "react";

/** Explicit legacy actions preserve their callback scope across async settlement. */
export function RetainedHarnessAction({ label, disabled, action, onSuccess }: {
  label: string; disabled: boolean; action: () => Promise<boolean | void> | void;
  onSuccess?: () => void;
}) {
  const scope = useRef<typeof action | null>(action);
  const [state, setState] = useState({ action, pending: false, failed: false });
  if (state.action !== action) setState({ action, pending: false, failed: false });
  useEffect(() => { scope.current = action; return () => { scope.current = null; }; }, [action]);
  const run = async () => {
    setState({ action, pending: true, failed: false });
    try {
      const result = await action();
      if (scope.current !== action) return;
      if (result === false) setState({ action, pending: false, failed: true });
      else { setState({ action, pending: false, failed: false }); onSuccess?.(); }
    } catch (error) {
      console.warn("[provider-settings] Retained action failed:", error instanceof Error ? error.name : typeof error);
      if (scope.current === action) setState({ action, pending: false, failed: true });
    }
  };
  return <div className="matrix-ap-workflow-actions">
    <button type="button" className="matrix-ap-link-button" disabled={disabled || state.pending} onClick={() => void run()}>{label}</button>
    {state.failed ? <p role="alert" className="matrix-ap-help">The connection could not be updated. Try again.</p> : null}
  </div>;
}
