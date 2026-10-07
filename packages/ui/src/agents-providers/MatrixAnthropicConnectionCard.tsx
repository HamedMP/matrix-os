import { useEffect, useRef, useState } from "react";
import { MatrixAnthropicConnectSchema, type MatrixAnthropicConnection, type MatrixAnthropicDisconnect } from "@matrix-os/contracts";
import type { MatrixAnthropicConnectionClient } from "./matrix-anthropic-connection-client.js";

const ACTION_ERROR = "Claude connection could not be updated. Check again.";
const STATE_LABEL: Record<MatrixAnthropicConnection["state"], string> = {
  unsupported: "Unavailable", read_only: "Read only", disconnected: "Not connected",
  auth_required: "Reconnect required", refresh_required: "Check connection", ready: "Connected", unavailable: "Unavailable",
};

/** Matrix-only API connection; native Claude Code login and credential removal remain independent. */
export function MatrixAnthropicConnectionCard({ client, initialStatus, disabled, readOnly, refreshRevision = 0, onChanged }: {
  client?: MatrixAnthropicConnectionClient; initialStatus?: MatrixAnthropicConnection | null;
  disabled: boolean; readOnly: boolean; refreshRevision?: number; onChanged(): void;
}) {
  const [receipt, setReceipt] = useState<{ client: MatrixAnthropicConnectionClient; status: MatrixAnthropicConnection | null;
    projection: MatrixAnthropicConnection | null | undefined } | null>(null);
  const [error, setError] = useState<MatrixAnthropicConnectionClient | null>(null);
  const [active, setActive] = useState<MatrixAnthropicConnectionClient | null>(null);
  const [form, setForm] = useState<{ client: MatrixAnthropicConnectionClient; apiKey: string } | null>(null);
  const scope = useRef<{ client: MatrixAnthropicConnectionClient; lifetime: AbortController; revision: number; pending: boolean } | null>(null);
  const lastAttempt = useRef<{ client: MatrixAnthropicConnectionClient; kind: string; revision: number; generation: string | null; apiKey: string; id: string } | null>(null);
  // A newer canonical snapshot supersedes any local receipt from the previous
  // observation. null explicitly means unavailable, not permission to probe.
  const status = receipt?.client === client && receipt?.projection === initialStatus ? receipt?.status : initialStatus ?? null;
  const busy = Boolean(client && active === client);
  const keyForm = client && form?.client === client ? form : null;
  const blocked = disabled || readOnly || busy || status?.state === "read_only";

  useEffect(() => {
    if (!client) return;
    const current = { client, lifetime: new AbortController(), revision: 0, pending: false };
    scope.current = current; lastAttempt.current = null; setForm(null);
    return () => {
      current.lifetime.abort();
      if (scope.current === current) { scope.current = null; lastAttempt.current = null; }
    };
  }, [client]);

  useEffect(() => {
    const current = scope.current;
    if (initialStatus !== undefined || !client || !current || current.client !== client || current.pending) return;
    const controller = new AbortController(); const revision = ++current.revision;
    const signal = AbortSignal.any([controller.signal, current.lifetime.signal]);
    void client.status(signal).then(value => {
      if (signal.aborted || scope.current !== current || revision !== current.revision) return;
      setReceipt({ client, status: value, projection: initialStatus }); setError(null);
    }).catch(caught => {
      console.warn("[matrix-connection] Status unavailable:", caught instanceof Error ? caught.name : typeof caught);
      if (!signal.aborted && scope.current === current && revision === current.revision) setError(client);
    });
    return () => controller.abort();
  }, [client, initialStatus, refreshRevision]);

  async function act(kind: "connect" | "refresh" | "disconnect") {
    const current = scope.current;
    if (!client || !current || current.client !== client || current.lifetime.signal.aborted || current.pending
      || blocked || !status || !status.actions.includes(kind)) return;
    const apiKey = kind === "connect" ? keyForm?.apiKey ?? "" : "";
    const previous = lastAttempt.current;
    const same = previous?.client === client && previous.kind === kind && previous.revision === status.revision
      && previous.generation === status.credentialGeneration && previous.apiKey === apiKey;
    const intent: MatrixAnthropicDisconnect = { expectedRevision: status.revision,
      expectedCredentialGeneration: status.credentialGeneration, idempotencyKey: same ? previous.id : crypto.randomUUID() };
    const connect = kind === "connect" ? MatrixAnthropicConnectSchema.safeParse({ ...intent, apiKey }) : null;
    if (kind === "connect" && !connect?.success) return;
    lastAttempt.current = { client, kind, revision: status.revision, generation: status.credentialGeneration, apiKey, id: intent.idempotencyKey };
    const revision = ++current.revision; current.pending = true;
    setActive(client); setError(null);
    try {
      const value = kind === "connect" && connect?.success ? await client.connect(connect.data, current.lifetime.signal)
        : kind === "disconnect" ? await client.disconnect(intent, current.lifetime.signal)
          : await client.refresh(intent, current.lifetime.signal);
      if (current.lifetime.signal.aborted || scope.current !== current || revision !== current.revision) return;
      setReceipt({ client, status: value, projection: initialStatus }); setForm(null); lastAttempt.current = null;
      onChanged();
    } catch (caught) {
      console.warn("[matrix-connection] Action unavailable:", caught instanceof Error ? caught.name : typeof caught);
      if (!current.lifetime.signal.aborted && scope.current === current && revision === current.revision) {
        setError(client);
        // Every lost mutation response may conceal publication. Connect's
        // rejected discovery preserves the prior source; refresh failure must
        // withdraw readiness while its current authority is reconciled.
        if (kind !== "connect") {
          setReceipt({ client, status: null, projection: initialStatus });
          onChanged();
        }
        try {
          const value = await client.status(current.lifetime.signal);
          if (!current.lifetime.signal.aborted && scope.current === current && revision === current.revision) {
            setReceipt({ client, status: value, projection: initialStatus });
            if (value.revision !== status.revision || value.credentialGeneration !== status.credentialGeneration
              || value.sourceCredentialGeneration !== status.sourceCredentialGeneration) {
              lastAttempt.current = null;
              if (kind === "connect") onChanged();
            }
          }
        } catch (statusError) {
          console.warn("[matrix-connection] Reconciliation unavailable:", statusError instanceof Error ? statusError.name : typeof statusError);
        }
      }
    } finally {
      if (scope.current === current && revision === current.revision) { current.pending = false; setActive(null); }
    }
  }

  const label = busy ? "Updating connection…" : status ? STATE_LABEL[status.state]
    : client && initialStatus === undefined && error !== client ? "Checking connection…" : "Unavailable";
  return <article className="matrix-ap-subscription" aria-label="Claude API connection" aria-busy={busy ? "true" : undefined}>
    <div className="matrix-ap-subscription-head"><strong>Claude · Anthropic API</strong>
      <span className="matrix-ap-status-chip" data-state={status?.state === "ready" ? "ready" : "attention"}><i aria-hidden="true"/>{label}</span>
    </div>
    <p className="matrix-ap-help">Anthropic bills API requests separately from your Claude subscription and Matrix AI credit.</p>
    {status?.state === "ready" ? <p className="matrix-ap-help">{status.supports.rootChat && status.supports.recipeBots
      ? "Available for chats and Matrix Bots on this Computer." : status.supports.rootChat
        ? "Available for chats on this Computer." : status.supports.recipeBots
          ? "Available for Matrix Bots on this Computer." : "Connection saved. Model execution is unavailable on this Computer."}</p> : null}
    {!client || status?.state === "unsupported" ? <p className="matrix-ap-help">This Computer does not support the Claude API connection. Refresh or update this Computer to check again.</p> : null}
    {readOnly || status?.state === "read_only" ? <p className="matrix-ap-help">Only this Computer’s owner can manage connections.</p> : null}
    {error === client && client ? <p className="matrix-ap-help" role="alert">{ACTION_ERROR}</p> : null}
    {keyForm && !readOnly ? <form className="matrix-ap-key-form" onSubmit={event => { event.preventDefault(); void act("connect"); }}>
      <label className="matrix-ap-field"><span>Anthropic API key</span>
        <input type="password" autoComplete="off" spellCheck={false} maxLength={4096} value={keyForm.apiKey} disabled={blocked}
          onChange={event => setForm({ client: keyForm.client, apiKey: event.target.value })}/>
      </label>
      <div className="matrix-ap-workflow-actions matrix-ap-subscription-actions">
        <button type="submit" className="matrix-ap-button matrix-ap-button-primary" disabled={blocked || !status?.actions.includes("connect")
          || !MatrixAnthropicConnectSchema.safeParse({ expectedRevision: status.revision, expectedCredentialGeneration: status.credentialGeneration,
            idempotencyKey: "validation", apiKey: keyForm.apiKey }).success}>Connect Claude</button>
        <button type="button" className="matrix-ap-button" disabled={busy} onClick={() => { setForm(null); lastAttempt.current = null; }}>Cancel</button>
      </div>
    </form> : client && !readOnly && status?.state !== "read_only" ? <div className="matrix-ap-workflow-actions matrix-ap-subscription-actions">
      {status?.actions.includes("connect") ? <button type="button" className="matrix-ap-button" disabled={blocked}
        onClick={() => setForm({ client, apiKey: "" })}>{status.enabled ? "Change API key" : "Connect Claude"}</button> : null}
      {status?.actions.includes("refresh") ? <button type="button" className="matrix-ap-button" disabled={blocked} onClick={() => void act("refresh")}>Check Claude connection</button> : null}
      {status?.actions.includes("disconnect") ? <button type="button" className="matrix-ap-button" disabled={blocked} onClick={() => void act("disconnect")}>Disconnect Claude</button> : null}
    </div> : null}
  </article>;
}
