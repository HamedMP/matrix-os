import { useEffect, useRef, useState } from "react";
import type { LocalChatgptPlanClient, LocalChatgptPlanStatus } from "./local-chatgpt-plan-client.js";

const ACTION_ERROR = "ChatGPT connection could not be updated. Check again.";
const REVOKE_ERROR = "Saving could not be confirmed. Retry turning background access off before restarting the app.";

/** This source is independent of the selected Computer's native Codex/API-key accounts. */
export function LocalChatgptSubscription({ client, disabled, readOnly, refreshRevision = 0, onChanged }: {
  client?: LocalChatgptPlanClient; disabled: boolean; readOnly: boolean; refreshRevision?: number; onChanged(): void;
}) {
  const [receipt, setReceipt] = useState<{ client: LocalChatgptPlanClient; status: LocalChatgptPlanStatus } | null>(null);
  const [error, setError] = useState<{ client: LocalChatgptPlanClient; text: string; recovery?: boolean } | null>(null);
  // A read or model refresh cannot confirm persistence of a failed downgrade.
  const [pendingRevocation, setPendingRevocation] = useState<{ client: LocalChatgptPlanClient; accountId: string } | null>(null);
  const [active, setActive] = useState<{ client: LocalChatgptPlanClient; kind: "connect" | "action" } | null>(null);
  const [backgroundDraft, setBackgroundDraft] = useState<{
    client: LocalChatgptPlanClient; accountId: string; revision: number; value: boolean;
  } | null>(null);
  const scope = useRef<{ client: LocalChatgptPlanClient; lifetime: AbortController; revision: number; pending: boolean } | null>(null);
  const changed = useRef(onChanged);
  useEffect(() => { changed.current = onChanged; }, [onChanged]);
  const status = receipt && receipt.client === client ? receipt.status : null;
  const background = backgroundDraft && backgroundDraft.client === client && backgroundDraft.accountId === status?.account?.id
    && backgroundDraft.revision === status?.grant.revision ? backgroundDraft.value : status?.grant.background ?? false;
  const busy = active?.client === client && !!client;
  const connecting = status?.state === "connecting" || busy && active?.kind === "connect";

  useEffect(() => {
    if (!client) return;
    const lifetime = new AbortController();
    const current = { client, lifetime, revision: 0, pending: false }; scope.current = current;
    setPendingRevocation(previous => previous?.client === client ? previous : null);
    return () => { lifetime.abort(); if (scope.current === current) scope.current = null; };
  }, [client]);

  // The existing Settings check retries local IPC too. Keep status reads separate
  // from the client lifetime so refreshing cannot cancel or supersede a mutation.
  useEffect(() => {
    const current = scope.current;
    if (!client || !current || current.client !== client || current.pending) return;
    const controller = new AbortController();
    const revision = ++current.revision;
    const read = async () => {
      try {
        const value = await client.status(AbortSignal.any([controller.signal, current.lifetime.signal]));
        if (controller.signal.aborted || current.lifetime.signal.aborted || scope.current !== current || current.revision !== revision) return;
        setReceipt({ client, status: value });
        setPendingRevocation(previous => previous?.client === client && previous.accountId === value.account?.id ? previous : null);
        setError(null);
      } catch (caught) {
        console.warn("[chatgpt-plan] Status unavailable:", caught instanceof Error ? caught.name : typeof caught);
        if (!controller.signal.aborted && !current.lifetime.signal.aborted && scope.current === current && current.revision === revision) setError({ client, text: ACTION_ERROR });
      }
    };
    void read();
    return () => controller.abort();
  }, [client, refreshRevision]);

  // Connect may return an in-progress receipt. Poll only during that transition
  // or while its authenticated device is registering; ordinary popup opens do
  // not restart model discovery or inference.
  const awaitingDevice = status?.state === "connecting" || status?.state === "connected" && !status.bridgeConnected && !status.bridgeFailure;
  useEffect(() => {
    const current = scope.current;
    if (!client || !current || current.client !== client || !awaitingDevice || busy) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const expires = Date.now() + 5 * 60_000;
    const read = async () => {
      const revision = current.revision;
      try {
        const value = await client.status(current.lifetime.signal);
        if (stopped || current.lifetime.signal.aborted || scope.current !== current || revision !== current.revision) return;
        setReceipt({ client, status: value });
        setPendingRevocation(previous => previous?.client === client && previous.accountId === value.account?.id ? previous : null);
        if (value.bridgeConnected) setError(previous => previous?.client === client && previous.recovery ? null : previous);
        if ((value.state === "connecting" || value.state === "connected" && !value.bridgeConnected && !value.bridgeFailure) && Date.now() < expires) {
          timer = setTimeout(() => void read(), 1500);
        } else changed.current();
      } catch (caught) {
        console.warn("[chatgpt-plan] Connection check unavailable:", caught instanceof Error ? caught.name : typeof caught);
        if (!stopped && scope.current === current && !current.lifetime.signal.aborted && current.revision === revision) setError({ client, text: ACTION_ERROR });
      }
    };
    timer = setTimeout(() => void read(), 1500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [client, awaitingDevice, busy, refreshRevision]);

  async function act(action: (signal: AbortSignal) => Promise<LocalChatgptPlanStatus>, kind: "connect" | "action" | "cancel" | "rebind" | "grant" = "action") {
    const current = scope.current;
    if (!client || !current || current.client !== client || current.lifetime.signal.aborted || current.pending && kind !== "cancel" || disabled || readOnly) return;
    const revision = ++current.revision; current.pending = true;
    setActive({ client, kind: kind === "connect" ? "connect" : "action" });
    setError(null);
    try {
      const value = await action(current.lifetime.signal);
      if (current.lifetime.signal.aborted || scope.current !== current || current.revision !== revision) return;
      setReceipt({ client, status: value });
      setPendingRevocation(previous => kind !== "grant" && previous?.client === client && previous.accountId === value.account?.id ? previous : null);
      setError(null);
      if (kind === "grant") setBackgroundDraft(null);
      onChanged();
    } catch (caught) {
      console.warn("[chatgpt-plan] Action unavailable:", caught instanceof Error ? caught.name : typeof caught);
      if (current.lifetime.signal.aborted || scope.current !== current || current.revision !== revision) return;
      setError({ client, text: ACTION_ERROR, recovery: kind === "rebind" });
      if (kind === "grant" && !background && status?.account) setPendingRevocation({ client, accountId: status.account.id });
      // The write may have committed despite a failed acknowledgement. Read its
      // accepted state once; never replay replacement or permission mutations.
      if (kind === "rebind" || kind === "grant") {
        try {
          const value = await client.status(current.lifetime.signal);
          if (current.lifetime.signal.aborted || scope.current !== current || current.revision !== revision) return;
          setReceipt({ client, status: value });
          setPendingRevocation(previous => previous?.client === client && previous.accountId === value.account?.id ? previous : null);
          if (kind === "grant") { setBackgroundDraft(null); onChanged(); }
          if (kind === "rebind" && value.bridgeConnected) { setError(null); onChanged(); }
        } catch (statusError) {
          console.warn("[chatgpt-plan] Recovery status unavailable:", statusError instanceof Error ? statusError.name : typeof statusError);
          // Preserve the safe error and let the existing Settings refresh retry.
        }
      }
    } finally {
      if (scope.current === current && current.revision === revision) { current.pending = false; setActive(null); }
    }
  }
  const connected = status?.state === "connected" && !!status.account;
  const blocked = disabled || readOnly || busy;
  const revocationUnconfirmed = !!status?.grantSaveUnconfirmed || !!pendingRevocation && pendingRevocation.client === client && pendingRevocation.accountId === status?.account?.id;
  const retryRevocation = revocationUnconfirmed && !background;
  const errorText = revocationUnconfirmed ? REVOKE_ERROR : error?.client === client ? error?.text : undefined;
  const canEnableBackground = connected && !connecting && !!status?.grant.enabled && !!status?.bridgeConnected && status.models.length > 0;
  const canRevokeBackground = !!status?.account && (status.grant.background || retryRevocation);
  const label = !client ? "Unavailable on this surface" : !status ? error && error.client === client ? "Unavailable" : "Checking connection…"
    : connecting ? "Connecting" : connected ? "Connected on this device" : "Not connected";
  return <article className="matrix-ap-subscription" aria-label="ChatGPT subscription">
    <div className="matrix-ap-subscription-head"><strong>Codex · ChatGPT subscription</strong>
      <span className="matrix-ap-status-chip" data-state={connected ? "ready" : "attention"}><i aria-hidden="true"/>{label}</span>
    </div>
    <p className="matrix-ap-help">Use your ChatGPT plan for chats and Matrix Bots. Keep this device connected while they run.</p>
    {!client ? <p className="matrix-ap-help">Available in Electron Desktop on your personal device. Native Codex login and API keys are managed separately.</p> : null}
    {connected ? <><p className="matrix-ap-help">{status.account!.label}</p>
      <p className="matrix-ap-help">{status.bridgeConnected ? !status.models.length ? "No subscription models are available. Check subscription models." : status.grant.enabled ? "Available for chats and interactive Matrix Bots on this Computer." : "Reconnect ChatGPT to resume chats and interactive Matrix Bots on this Computer." : status.bridgeFailure === "device_conflict" ? "Another device is connected to this Computer. Using this device will replace that connection and stop its active Chat and Bot requests." : "Device connection to this Computer is unavailable. Chat and Bot requests cannot start."}</p>
    </> : null}
    {status?.revocation === "unconfirmed" ? <p className="matrix-ap-help" role="status">Local access stopped. Provider sign-out could not be confirmed; check your ChatGPT connected apps.</p> : null}
    {errorText ? <p className="matrix-ap-help" role="alert">{errorText}</p> : null}
    {client && !readOnly ? <div className="matrix-ap-workflow-actions matrix-ap-subscription-actions">
      {connecting ? <button className="matrix-ap-button" type="button" disabled={disabled || readOnly} onClick={() => void act(signal => client.cancel(signal), "cancel")}>Cancel ChatGPT connection</button>
        : !connected ? <button type="button" className="matrix-ap-button" disabled={blocked || !status} onClick={() => void act(signal => client.connect({ purpose: "personal_local" }, signal), "connect")}>Continue with ChatGPT</button>
        : <>
          {status.bridgeFailure === "device_conflict" && client.rebind ? <button className="matrix-ap-button" type="button" disabled={blocked} onClick={() => void act(signal => client.rebind!({ purpose: "replace_device" }, signal), "rebind")}>Use this device</button> : null}
          {!status.grant.enabled ? <button className="matrix-ap-button" type="button" disabled={blocked} onClick={() => void act(signal => client.connect({ purpose: "personal_local" }, signal), "connect")}>Reconnect ChatGPT</button> : null}
          {!status.models.length ? <button className="matrix-ap-button" type="button" disabled={blocked} onClick={() => void act(signal => client.refreshModels(signal))}>Check subscription models</button> : null}
          <button className="matrix-ap-button" type="button" disabled={blocked} onClick={() => void act(signal => client.disconnect(signal))}>Disconnect ChatGPT</button>
        </>}
    </div> : null}
    {client && !readOnly && status && (canEnableBackground || canRevokeBackground) ? <section className="matrix-ap-workflow" aria-label="Background Bot permission">
      <label className="matrix-ap-uninstall-choice">
        <input type="checkbox" checked={background} disabled={blocked || !canEnableBackground && !background}
          onChange={event => setBackgroundDraft({ client, accountId: status.account!.id, revision: status.grant.revision, value: event.target.checked })}/>
        Allow scheduled and background Bot tasks on this Computer
        <span>Uses your subscription without a new message from you while this device stays connected.</span>
      </label>
      <button type="button" className="matrix-ap-button" disabled={blocked || background && !canEnableBackground || background === status.grant.background && !retryRevocation}
        onClick={() => void act(signal => client.setGrant({
          ...(background ? { enabled: true as const, background: true as const } : { enabled: status.grant.enabled, background: false as const }),
          accountId: status.account!.id, baseRevision: status.grant.revision }, signal), "grant")}>
        Save background permission
      </button>
      <p className="matrix-ap-help">{status.grant.background
        ? "Scheduled and background Bot tasks are allowed on this Computer."
        : "Scheduled Bot access is off on this Computer."}</p>
    </section> : null}
    {readOnly ? <p className="matrix-ap-help">Only this Computer’s owner can manage Bot connections.</p> : null}
  </article>;
}
