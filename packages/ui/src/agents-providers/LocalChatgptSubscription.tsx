import { useEffect, useRef, useState } from "react";
import type { LocalChatgptPlanClient, LocalChatgptPlanStatus } from "./local-chatgpt-plan-client.js";

const ACTION_ERROR = "ChatGPT connection could not be updated. Check again.";

/** This source is independent of the selected Computer's native Codex/API-key accounts. */
export function LocalChatgptSubscription({ client, disabled, readOnly, refreshRevision = 0, onChanged }: {
  client?: LocalChatgptPlanClient; disabled: boolean; readOnly: boolean; refreshRevision?: number; onChanged(): void;
}) {
  const [receipt, setReceipt] = useState<{ client: LocalChatgptPlanClient; status: LocalChatgptPlanStatus } | null>(null);
  const [error, setError] = useState<{ client: LocalChatgptPlanClient; text: string } | null>(null);
  const [active, setActive] = useState<{ client: LocalChatgptPlanClient; kind: "connect" | "action" } | null>(null);
  const scope = useRef<{ client: LocalChatgptPlanClient; lifetime: AbortController; revision: number; pending: boolean } | null>(null);
  const changed = useRef(onChanged);
  useEffect(() => { changed.current = onChanged; }, [onChanged]);
  const status = receipt && receipt.client === client ? receipt.status : null;
  const busy = active?.client === client && !!client;
  const connecting = status?.state === "connecting" || busy && active?.kind === "connect";

  useEffect(() => {
    if (!client) return;
    const lifetime = new AbortController();
    const current = { client, lifetime, revision: 0, pending: false }; scope.current = current;
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
        setReceipt({ client, status: value }); setError(null);
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
  const awaitingDevice = status?.state === "connecting" || status?.state === "connected" && !status.bridgeConnected;
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
        if ((value.state === "connecting" || value.state === "connected" && !value.bridgeConnected) && Date.now() < expires) {
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

  async function act(action: (signal: AbortSignal) => Promise<LocalChatgptPlanStatus>, kind: "connect" | "action" | "cancel" = "action") {
    const current = scope.current;
    if (!client || !current || current.client !== client || current.lifetime.signal.aborted || current.pending && kind !== "cancel" || disabled || readOnly) return;
    const revision = ++current.revision; current.pending = true;
    setActive({ client, kind: kind === "connect" ? "connect" : "action" }); setError(null);
    try {
      const value = await action(current.lifetime.signal);
      if (current.lifetime.signal.aborted || scope.current !== current || current.revision !== revision) return;
      setReceipt({ client, status: value });
      onChanged();
    } catch (caught) {
      console.warn("[chatgpt-plan] Action unavailable:", caught instanceof Error ? caught.name : typeof caught);
      if (!current.lifetime.signal.aborted && scope.current === current && current.revision === revision) setError({ client, text: ACTION_ERROR });
    } finally {
      if (scope.current === current && current.revision === revision) { current.pending = false; setActive(null); }
    }
  }
  const connected = status?.state === "connected" && !!status.account;
  const blocked = disabled || readOnly || busy;
  const label = !client ? "Unavailable on this surface" : !status ? error && error.client === client ? "Unavailable" : "Checking connection…"
    : connecting ? "Connecting" : connected ? "Connected on this device" : "Not connected";
  return <article className="matrix-ap-subscription" aria-label="ChatGPT subscription">
    <div className="matrix-ap-subscription-head"><strong>Codex · ChatGPT subscription</strong>
      <span className="matrix-ap-status-chip" data-state={connected ? "ready" : "attention"}><i aria-hidden="true"/>{label}</span>
    </div>
    <p className="matrix-ap-help">Use your ChatGPT plan for Matrix Bots. Keep this device connected while your Bot runs.</p>
    {!client ? <p className="matrix-ap-help">Available in Electron Desktop on your personal device. Native Codex login and API keys are managed separately.</p> : null}
    {connected ? <><p className="matrix-ap-help">{status.account!.label}</p>
      <p className="matrix-ap-help">{status.bridgeConnected ? !status.models.length ? "No subscription models are available. Check subscription models." : status.grant.enabled ? "Available for interactive Bots on this Computer." : "Reconnect ChatGPT to resume interactive Bots on this Computer." : "Device connection to this Computer is unavailable. Bot requests cannot start."}</p>
    </> : null}
    {status?.revocation === "unconfirmed" ? <p className="matrix-ap-help" role="status">Local access stopped. Provider sign-out could not be confirmed; check your ChatGPT connected apps.</p> : null}
    {error && error.client === client ? <p className="matrix-ap-help" role="alert">{error.text}</p> : null}
    {client && !readOnly ? <div className="matrix-ap-workflow-actions matrix-ap-subscription-actions">
      {connecting ? <button className="matrix-ap-button" type="button" disabled={disabled || readOnly} onClick={() => void act(signal => client.cancel(signal), "cancel")}>Cancel ChatGPT connection</button>
        : !connected ? <button type="button" className="matrix-ap-button" disabled={blocked || !status} onClick={() => void act(signal => client.connect({ purpose: "personal_local" }, signal), "connect")}>Continue with ChatGPT</button>
        : <>
          {!status.grant.enabled ? <button className="matrix-ap-button" type="button" disabled={blocked} onClick={() => void act(signal => client.connect({ purpose: "personal_local" }, signal), "connect")}>Reconnect ChatGPT</button> : null}
          {!status.models.length ? <button className="matrix-ap-button" type="button" disabled={blocked} onClick={() => void act(signal => client.refreshModels(signal))}>Check subscription models</button> : null}
          <button className="matrix-ap-button" type="button" disabled={blocked} onClick={() => void act(signal => client.disconnect(signal))}>Disconnect ChatGPT</button>
        </>}
    </div> : null}
    {readOnly ? <p className="matrix-ap-help">Only this Computer’s owner can manage Bot connections.</p> : null}
  </article>;
}
