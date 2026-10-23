"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod/v4";
import type { BrowserSetupTransport } from "./types.js";
const Setup = z.strictObject({ status: z.enum(["pending", "installing", "ready", "failed", "exhausted", "disabled"]), retryAvailable: z.boolean() });
type Status = z.infer<typeof Setup>;
export function BrowserSetupGate({ setup, active, scope, children }: { setup: BrowserSetupTransport; active: boolean; scope: string; children: (recheck: () => Promise<boolean>) => ReactNode }) {
  const [state, setState] = useState<{ scope: string; status: Status | null; error: boolean; busy: boolean }>({ scope, status: null, error: false, busy: false });
  const [revision, setRevision] = useState(0);
  const retrying = useRef(false);
  const requestVersion = useRef(0);
  const rechecking = useRef<AbortController | null>(null);
  const retryRequest = useRef<AbortController | null>(null);
  // A failed manual check already supplied current state; avoid an immediate
  // duplicate when the ordinary setup poll resumes.
  const deferPoll = useRef(false);
  useEffect(() => () => { rechecking.current?.abort(); rechecking.current = null; retryRequest.current?.abort(); retryRequest.current = null; }, [setup, active, scope]);
  const current = state.scope === scope ? state : { scope, status: null, error: false, busy: false };
  const ready = current.status?.status === "ready";
  const upgradeRequired = setup.requiresDesktopUpdate === true;
  useEffect(() => {
    if (!active || ready || upgradeRequired) return;
    const controller = new AbortController();
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
    if (deferPoll.current) { deferPoll.current = false; timer = setTimeout(() => { void poll(); }, 4000); }
    else void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [setup, active, scope, revision, ready, upgradeRequired]);
  const retry = async () => {
    if (!active || retrying.current || !current.status?.retryAvailable) return;
    const controller = new AbortController(); retryRequest.current = controller;
    requestVersion.current++;
    retrying.current = true; setState(previous => ({ ...previous, busy: true }));
    try {
      const status = Setup.parse(await setup.retry(controller.signal));
      if (!controller.signal.aborted) setState({ scope, status, error: false, busy: false });
    } catch (error) {
      console.warn("[browser-setup] Retry unavailable", error instanceof Error ? error.name : "unknown");
      if (!controller.signal.aborted) setState({ scope, status: null, error: true, busy: false });
    } finally { retrying.current = false; if (retryRequest.current === controller) retryRequest.current = null; }
  };
  const recheck = async (): Promise<boolean> => {
    if (!active || upgradeRequired || rechecking.current) return false;
    const controller = new AbortController(); rechecking.current = controller;
    requestVersion.current++;
    try {
      const status = Setup.parse(await setup.status(controller.signal));
      if (controller.signal.aborted) return false;
      deferPoll.current = status.status !== "ready";
      setState({ scope, status, error: false, busy: false });
      return status.status === "ready";
    } catch (error) {
      console.warn("[browser-setup] Reconnect check unavailable", error instanceof Error ? error.name : "unknown");
      if (!controller.signal.aborted) { deferPoll.current = true; setState({ scope, status: null, error: true, busy: false }); }
      return false;
    } finally { if (rechecking.current === controller) rechecking.current = null; }
  };
  if (ready && !upgradeRequired) return children(recheck);
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
