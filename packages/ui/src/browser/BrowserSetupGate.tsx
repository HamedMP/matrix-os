"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod/v4";
import type { BrowserSetupTransport } from "./types.js";
const Setup = z.strictObject({ status: z.enum(["pending", "installing", "ready", "failed", "exhausted", "disabled"]), retryAvailable: z.boolean() });
type Status = z.infer<typeof Setup>;
export function BrowserSetupGate({ setup, active, scope, children }: { setup: BrowserSetupTransport; active: boolean; scope: string; children: ReactNode }) {
  const [state, setState] = useState<{ scope: string; status: Status | null; error: boolean; busy: boolean }>({ scope, status: null, error: false, busy: false });
  const [revision, setRevision] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  const retrying = useRef(false);
  const requestVersion = useRef(0);
  const current = state.scope === scope ? state : { scope, status: null, error: false, busy: false };
  const ready = current.status?.status === "ready";
  const upgradeRequired = setup.requiresDesktopUpdate === true;
  useEffect(() => {
    if (!active || ready || upgradeRequired) return;
    const controller = new AbortController(); lifetime.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const version = requestVersion.current;
      try {
        if (retrying.current) return;
        const status = Setup.parse(await setup.status(controller.signal));
        if (!controller.signal.aborted && version === requestVersion.current) setState({ scope, status, error: false, busy: false });
      } catch (error) {
        console.warn("[browser-setup] Status unavailable", error instanceof Error ? error.name : "unknown");
        if (!controller.signal.aborted && version === requestVersion.current) setState({ scope, status: null, error: true, busy: false });
      } finally { if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 4000); }
    };
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); if (lifetime.current === controller) lifetime.current = null; };
  }, [setup, active, scope, revision, ready, upgradeRequired]);
  const retry = async () => {
    const controller = lifetime.current;
    if (!active || !controller || controller.signal.aborted || retrying.current || !current.status?.retryAvailable) return;
    requestVersion.current++;
    retrying.current = true; setState(previous => ({ ...previous, busy: true }));
    try {
      const status = Setup.parse(await setup.retry(controller.signal));
      if (!controller.signal.aborted) setState({ scope, status, error: false, busy: false });
    } catch (error) {
      console.warn("[browser-setup] Retry unavailable", error instanceof Error ? error.name : "unknown");
      if (!controller.signal.aborted) setState({ scope, status: null, error: true, busy: false });
    } finally { retrying.current = false; }
  };
  if (ready && !upgradeRequired) return children;
  const disabled = current.status?.status === "disabled";
  const failed = current.status && ["failed", "exhausted"].includes(current.status.status);
  const heading = upgradeRequired ? "Update Matrix OS Desktop to use Browser" : current.error ? "Browser setup is unavailable" : disabled ? "Browser is disabled on this Computer"
    : failed ? "Browser setup could not finish" : "Preparing Browser…";
  return <section className="matrix-browser-surface ph-no-capture" aria-label="Browser setup"><div className="matrix-browser-viewport"><div className="matrix-browser-placeholder" role="status">
    <strong>{heading}</strong><p>{upgradeRequired ? "Install the latest Matrix OS Desktop update, then reopen Browser."
      : current.error ? "Check your connection or contact support if this continues."
      : disabled ? "Contact your administrator to enable Browser."
      : failed ? current.status?.retryAvailable ? "Retry setup to prepare Browser on this Computer." : "Setup retries are temporarily limited. Try again later or contact support."
      : "Your Computer is preparing Browser. Your tabs and sign-ins are preserved."}</p>
    {!upgradeRequired && current.status?.retryAvailable && <button disabled={current.busy || !active} onClick={() => { void retry(); }}>{current.busy ? "Retrying…" : "Retry setup"}</button>}
    {!upgradeRequired && current.error && <button disabled={!active} onClick={() => setRevision(value => value + 1)}>Check again</button>}
  </div></div></section>;
}
