import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { useConnection } from "../../stores/connection";
import { captureRuntimeGeneration } from "../../stores/runtime-generation";
import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";
import {
  desktopCreditDiagnosticTarget, DesktopCreditDiagnosticError, readDesktopCreditDiagnostic,
  type DesktopCreditDiagnosticContext, type DesktopCreditDiagnosticObservation, type DesktopCreditDiagnosticTarget,
} from "./credit-diagnostic";

type Props = {
  api: Parameters<typeof readDesktopCreditDiagnostic>[0]["api"];
  snapshot: ProviderSettingsSnapshot;
  selectedHarnessId: string | null;
  identityKey: string;
  target?: DesktopCreditDiagnosticTarget;
};
type Receipt = { observation: DesktopCreditDiagnosticObservation; context: DesktopCreditDiagnosticContext };

/** Local, opt-in QA disclosure. No provider refresh, storage, analytics, auth or model request. */
export function CreditDiagnosticDisclosure(props: Props) {
  const configured = useMemo(() => desktopCreditDiagnosticTarget(import.meta.env), []);
  const target = props.target ?? configured;
  const liveIdentity = useConnection(state => desktopProviderIdentityKey(state));
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [state, setState] = useState("Open to read the accepted snapshot diagnostic.");
  const request = useRef<AbortController | null>(null);
  const current = useRef(props);
  current.current = props;
  const getContext = (): DesktopCreditDiagnosticContext => {
    const connection = useConnection.getState();
    if (desktopProviderIdentityKey(connection) !== current.current.identityKey) {
      throw new DesktopCreditDiagnosticError("identity_changed");
    }
    return { identityKey: current.current.identityKey, handle: connection.handle, runtimeSlot: connection.runtimeSlot,
      generation: captureRuntimeGeneration(), authGeneration: connection.authGeneration,
      snapshot: current.current.snapshot, selectedHarnessId: current.current.selectedHarnessId };
  };
  useEffect(() => {
    request.current?.abort();
    request.current = null;
    setReceipt(null);
    setState("Context changed. Close and reopen to read the accepted snapshot diagnostic.");
    return () => { request.current?.abort(); request.current = null; };
  }, [props.api, props.snapshot, props.selectedHarnessId, props.identityKey, liveIdentity, target]);

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open) {
      request.current?.abort(); request.current = null;
      setReceipt(null);
      setState("Open to read the accepted snapshot diagnostic.");
      return;
    }
    if (!target || request.current) return;
    const lifetime = new AbortController();
    request.current = lifetime;
    setReceipt(null);
    setState("Reading same-session diagnostic…");
    void (async () => {
      try {
        const context = getContext();
        const observation = await readDesktopCreditDiagnostic({ api: props.api, target, signal: lifetime.signal, getContext });
        if (lifetime.signal.aborted || request.current !== lifetime) return;
        // The helper fenced every await; the view also binds disclosure to accepted snapshot and identity.
        setReceipt({ observation, context });
        setState("Observed accepted snapshot; selected source unknown.");
      } catch (error) {
        if (lifetime.signal.aborted || request.current !== lifetime) return;
        setState(`Credit diagnostic blocked: ${error instanceof DesktopCreditDiagnosticError ? error.code : "unavailable"}.`);
      }
    })();
  };
  const visible = receipt && receipt.context.snapshot === props.snapshot
    && receipt.context.selectedHarnessId === props.selectedHarnessId && receipt.context.identityKey === liveIdentity
    && receipt.context.generation === captureRuntimeGeneration() ? receipt.observation : null;
  if (!target || target.runtimeSlot !== useConnection.getState().runtimeSlot) return null;
  return (
    <details className="matrix-agents-providers" onToggle={onToggle}>
      <summary>Credit diagnostic</summary>
      <div role="status" aria-label="Credit diagnostic observation">
        {visible ? <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "24rem", overflow: "auto" }}>
          {JSON.stringify(visible, null, 2)}
        </pre> : state}
      </div>
    </details>
  );
}
