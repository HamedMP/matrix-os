import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderAccount, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { RemovalDialog } from "./RemovalDialog.js";
import type { ProviderSettingsMutationIntent } from "./types.js";

/** Account lifecycle is separate from the agent's saved enabled state. */
export function AccountLifecycleActions({ accounts, snapshot, harnessId, scopeOwner, disabled, canLogout, canRemove, canReassign, onMutate, onRefresh }: {
  accounts: ProviderAccount[]; snapshot: ProviderSettingsSnapshot; harnessId: string; scopeOwner: unknown;
  disabled: boolean; canLogout: boolean; canRemove: boolean; canReassign: boolean;
  onMutate: (intent: ProviderSettingsMutationIntent) => Promise<boolean> | void; onRefresh: () => void;
}) {
  const scope = useMemo(() => ({}), [harnessId, scopeOwner]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const mounted = useRef(false);
  const pendingScope = useRef<object | null>(null);
  const [state, setState] = useState({ scope, pending: false, error: false, removeId: null as string | null });
  if (state.scope !== scope) setState({ scope, pending: false, error: false, removeId: null });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const removal = accounts.find(account => account.id === state.removeId);
  const run = async (intent: ProviderSettingsMutationIntent): Promise<boolean> => {
    if (disabled || pendingScope.current === scope) return false;
    pendingScope.current = scope;
    setState(current => ({ ...current, pending: true, error: false }));
    try {
      const result = await onMutate(intent);
      if (!mounted.current || currentScope.current !== scope) return false;
      if (result !== true) { setState(current => ({ ...current, error: true })); return false; }
      onRefresh();
      return true;
    } catch (caught) {
      console.warn("[provider-settings] Account action failed:", caught instanceof Error ? caught.name : typeof caught);
      if (mounted.current && currentScope.current === scope) setState(current => ({ ...current, error: true }));
      return false;
    } finally {
      if (pendingScope.current === scope) pendingScope.current = null;
      if (mounted.current && currentScope.current === scope) setState(current => ({ ...current, pending: false }));
    }
  };
  if (!accounts.some(account => canRemove || canReassign || (canLogout && account.authState === "authenticated"))) return null;
  return <div className="matrix-ap-workflow-actions" role="group" aria-label="Account actions">
    {accounts.map(account => <div key={account.id}>
      {canLogout && account.authState === "authenticated" ? <button type="button" className="matrix-ap-link-button"
        aria-label={`Log out ${account.displayName}`} disabled={disabled || state.pending}
        onClick={() => void run({ type: "logout_account", accountId: account.id })}>Log out{accounts.length > 1 ? ` ${account.displayName}` : ""}</button> : null}
      {canRemove || canReassign ? <button type="button" className="matrix-ap-link-button matrix-ap-danger-text"
        aria-label={`Remove ${account.displayName}`} disabled={disabled || state.pending}
        onClick={() => { if (!disabled && !state.pending) setState(current => ({ ...current, removeId: account.id, error: false })); }}>Remove{accounts.length > 1 ? ` ${account.displayName}` : ""}</button> : null}
    </div>)}
    {state.error && !removal ? <p role="alert" className="matrix-ap-help">Changes were not saved. Your account is kept; try again.</p> : null}
    {removal ? <RemovalDialog key={removal.id} account={removal} accounts={snapshot.accounts}
      sources={snapshot.accessSources} harnesses={snapshot.harnesses} gatewayPolicy={snapshot.gatewayPolicy}
      disabled={disabled} canRemove={canRemove} canReassign={canReassign} onMutate={run}
      onClose={() => setState(current => ({ ...current, removeId: null, error: false }))} /> : null}
  </div>;
}
