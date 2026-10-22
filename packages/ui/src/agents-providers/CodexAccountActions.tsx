import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ProviderAccount } from "@matrix-os/contracts";
import type { ProviderSettingsMutationIntent } from "./types.js";
import { useDialogFocus } from "./use-dialog-focus.js";

/** One lifecycle for the selected native profile, never every historical alias. */
export function CodexAccountActions({ account, harnessId, scopeOwner, disabled, canLogout, canChangeAccount, onMutate, onRefresh }: {
  account?: ProviderAccount; harnessId: string; scopeOwner: unknown;
  disabled: boolean; canLogout: boolean; canChangeAccount: boolean;
  onMutate: (intent: ProviderSettingsMutationIntent) => Promise<boolean> | void;
  onRefresh: () => void;
}) {
  const scope = useMemo(() => ({}), [scopeOwner, harnessId, account?.id, account?.accessSourceId, account?.authState]);
  const current = useRef(scope);
  useLayoutEffect(() => { current.current = scope; }, [scope]);
  const mounted = useRef(false), running = useRef<object | null>(null);
  const [state, setState] = useState({ scope, intent: null as "change" | "logout" | null, pending: false, error: false });
  if (state.scope !== scope) setState({ scope, intent: null, pending: false, error: false });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dialog = useRef<HTMLElement | null>(null);
  const close = () => { if (!running.current) setState(value => ({ ...value, intent: null, error: false })); };
  useDialogFocus(dialog, state.intent !== null, close);
  if (!account || account.authState !== "authenticated" || !canLogout) return null;
  const confirm = async () => {
    if (disabled || running.current || !state.intent) return;
    running.current = scope;
    setState(value => ({ ...value, pending: true, error: false }));
    try {
      if (await onMutate({ type: "logout_account", accountId: account.id }) !== true) throw new Error("sign-out unconfirmed");
      if (mounted.current && current.current === scope) {
        setState(value => ({ ...value, intent: null }));
        // Refreshed signed-out props reveal the normal login flow. Never start
        // sign-in using the old account snapshot, even after a successful write.
        onRefresh();
      }
    } catch (error) {
      console.warn("[provider-settings] Native sign-out unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (mounted.current && current.current === scope) setState(value => ({ ...value, error: true }));
    } finally {
      if (running.current === scope) running.current = null;
      if (mounted.current && current.current === scope) setState(value => ({ ...value, pending: false }));
    }
  };
  const blocked = disabled || state.pending;
  const change = state.intent === "change";
  return <div className="matrix-ap-workflow-actions" role="group" aria-label="Codex account actions">
    {canChangeAccount ? <button className="matrix-ap-button" type="button" disabled={blocked}
      onClick={() => setState(value => ({ ...value, intent: "change", error: false }))}>Change account</button> : null}
    <button className="matrix-ap-link-button" type="button" aria-label={`Log out ${account.displayName}`} disabled={blocked}
      onClick={() => setState(value => ({ ...value, intent: "logout", error: false }))}>Log out</button>
    {state.intent ? <div className="matrix-ap-dialog-backdrop"><section ref={dialog} className="matrix-ap-dialog" role="dialog" aria-modal="true" aria-label={change ? "Change Codex account?" : "Log out of Codex?"}>
      <h3>{change ? "Change Codex account?" : "Log out of Codex?"}</h3>
      <p>This logs out {account.displayName} from Codex on this Computer and stops its active Codex work. Your chats and projects stay. The separate ChatGPT connection for Matrix Chat and Bots stays unchanged.</p>
      {change ? <p>After signing out, choose how to sign in with your new account. If you cancel that sign-in, Codex stays signed out.</p> : null}
      {state.error ? <p className="matrix-ap-help" role="alert">Could not confirm sign-out. Check the account before trying again.</p> : null}
      <div className="matrix-ap-dialog-actions">
        <button className="matrix-ap-button" type="button" disabled={state.pending} onClick={close}>Cancel</button>
        <button className="matrix-ap-button matrix-ap-button-danger" type="button" disabled={blocked} onClick={() => void confirm()}>{change ? "Log out and change account" : "Log out"}</button>
      </div>
    </section></div> : null}
  </div>;
}
