import { useEffect, useMemo, useRef, useState } from "react";

/** Explicit legacy actions retain their captured owner/target scope across renders. */
export function RetainedHarnessAction({ label, disabled, action, onSuccess, scopeKey, scopeOwner }: {
  label: string; disabled: boolean; action: () => Promise<boolean | void> | void;
  onSuccess?: () => void; scopeKey: string; scopeOwner: unknown;
}) {
  const scope = useMemo(() => ({ scopeKey, scopeOwner }), [scopeKey, scopeOwner]);
  const activeScope = useRef<object | null>(scope);
  const [state, setState] = useState({ scope, pending: false, failed: false });
  if (state.scope !== scope) setState({ scope, pending: false, failed: false });
  useEffect(() => {
    activeScope.current = scope;
    return () => { activeScope.current = null; };
  }, [scope]);
  const run = async () => {
    setState({ scope, pending: true, failed: false });
    try {
      const result = await action();
      if (activeScope.current !== scope) return;
      if (result === false) setState({ scope, pending: false, failed: true });
      else { setState({ scope, pending: false, failed: false }); onSuccess?.(); }
    } catch (error) {
      console.warn("[provider-settings] Retained action failed:", error instanceof Error ? error.name : typeof error);
      if (activeScope.current === scope) setState({ scope, pending: false, failed: true });
    }
  };
  return <div className="matrix-ap-workflow-actions">
    <button type="button" className="matrix-ap-link-button" disabled={disabled || state.pending} onClick={() => void run()}>{label}</button>
    {state.failed ? <p role="alert" className="matrix-ap-help">The connection could not be updated. Try again.</p> : null}
  </div>;
}
