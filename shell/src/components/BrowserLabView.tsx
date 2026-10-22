"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import { getGatewayUrl } from "@/lib/gateway";
import { openAppSession } from "@/lib/app-session";

const Status = z.object({
  phase: z.enum(["idle", "running", "human", "completed", "failed", "stopped"]),
  engine: z.enum(["agent-browser", "browser-use"]).nullable(),
  generation: z.number().int().nonnegative(), checkpoint: z.number().int().min(0).max(3),
  workCompleted: z.number().int().min(0).max(10), humanControlAvailable: z.boolean(),
  comparisonAvailable: z.boolean().optional(),
});
type LabStatus = z.infer<typeof Status>;
type Engine = "agent-browser" | "browser-use";
type Action = "start" | "takeover" | "resume" | "stop";
const INITIAL: LabStatus = { phase: "idle", engine: null, generation: 0, checkpoint: 0, workCompleted: 0, humanControlAvailable: false };
const Ticket = z.object({ ticket: z.string().regex(/^[a-f0-9]{48}$/), expiresAt: z.number().positive() });

/** Compiled Matrix UI: this never loads or executes the owner's app HTML. */
export function BrowserLabView() {
  const gateway = getGatewayUrl();
  const appBase = `${gateway}/apps/browser-lab`;
  const [status, setStatus] = useState<LabStatus>(INITIAL);
  const [engine, setEngine] = useState<Engine>("agent-browser");
  const [connected, setConnected] = useState(false);
  const [comparisonAvailable, setComparisonAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [viewerBusy, setViewerBusy] = useState(false);
  const [viewerUrl, setViewerUrl] = useState("");
  const [error, setError] = useState("");
  const lifetime = useRef<AbortController | null>(null);
  const controlVersion = useRef(0);
  const viewerVersion = useRef(0);
  const controlBusy = useRef(false);

  const request = async (suffix: string, signal: AbortSignal, body?: object): Promise<unknown> => {
    const response = await fetch(`${appBase}/api/${suffix}`, {
      method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error("Browser service unavailable");
    const value: unknown = await response.json();
    if (suffix === "status") return { ...Status.parse(value), comparisonAvailable: response.headers.get("x-matrix-browser-lab-comparison") === "enabled" };
    return value;
  };
  const reconnect = async (signal: AbortSignal) => {
    const version = ++viewerVersion.current;
    setViewerBusy(true);
    try {
      await openAppSession("browser-lab", { gatewayUrl: gateway });
      if (signal.aborted) return;
      const ticket = Ticket.parse(await request("viewer-session", signal));
      if (signal.aborted || version !== viewerVersion.current) return;
      const gatewayPath = new URL(gateway).pathname.replace(/\/$/, "");
      const path = `${gatewayPath}/apps/browser-lab/viewer/websockify?lab_ticket=${ticket.ticket}`.replace(/^\//, "");
      setViewerUrl(`${appBase}/viewer/?path=${encodeURIComponent(path)}&autoconnect=true&resize=scale`);
      setError("");
    } catch (failure) {
      if (!signal.aborted && version === viewerVersion.current) {
        console.warn("[browser-lab] Preview unavailable", failure instanceof Error ? failure.name : "unknown");
        setError("Preview connection failed. Reconnect preview to try again.");
      }
    } finally { if (!signal.aborted && version === viewerVersion.current) setViewerBusy(false); }
  };

  // Requests belong to the selected runtime, and cleanup prevents stale state
  // or a late ticket from being rendered after a window/runtime change.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let nextSessionRefresh = 0;
    const poll = async () => {
      const version = controlVersion.current;
      try {
        if (controlBusy.current) return;
        if (Date.now() >= nextSessionRefresh) {
          await openAppSession("browser-lab", { gatewayUrl: gateway });
          nextSessionRefresh = Date.now() + 480_000;
        }
        if (controller.signal.aborted) return;
        const next = Status.parse(await request("status", controller.signal));
        if (!controller.signal.aborted && version === controlVersion.current && !controlBusy.current) { setStatus(next); setComparisonAvailable(next.comparisonAvailable === true); setConnected(true); }
      } catch (failure) {
        if (!controller.signal.aborted && version === controlVersion.current && !controlBusy.current) {
          setConnected(false);
          setComparisonAvailable(false);
          console.warn("[browser-lab] Status unavailable", failure instanceof Error ? failure.name : "unknown");
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 1500);
      }
    };
    void poll();
    void reconnect(controller.signal);
    return () => { controller.abort(); if (timer) clearTimeout(timer); lifetime.current = null; };
  }, [gateway]);

  const control = async (action: Action) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || controlBusy.current || !connected || !comparisonAvailable) return;
    controlBusy.current = true;
    controlVersion.current++;
    setBusy(true); setError("");
    try {
      const next = Status.parse(await request("control", signal, action === "start" ? { action, engine } : { action }));
      if (!signal.aborted) { setStatus((previous) => next.generation >= previous.generation ? next : previous); setConnected(true); }
    } catch (failure) {
      if (!signal.aborted) {
        setConnected(false);
        setError("The action could not be completed. Reconnect and try again.");
        console.warn("[browser-lab] Control unavailable", failure instanceof Error ? failure.name : "unknown");
      }
    } finally {
      controlVersion.current++;
      controlBusy.current = false;
      if (!signal.aborted) setBusy(false);
    }
  };
  const running = status.phase === "running";
  const human = status.phase === "human";
  const canCompare = connected && comparisonAvailable;
  const interactive = canCompare && status.humanControlAvailable && !busy;
  const canResume = !!status.engine && ["human", "failed", "stopped"].includes(status.phase);
  const buttonClass = "rounded-md border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-40";
  const stateLabel = !connected ? "Connecting…" : human ? "You are in control" : running ? "Agent working" : status.phase === "completed" ? "Fixture complete" : "Ready";
  return <section className="flex h-full min-h-0 flex-col gap-2 bg-[var(--background)] p-3 text-[var(--foreground)]" aria-label="Browser Lab">
    <header className="flex items-center justify-between"><div><h1 className="font-semibold">Browser Lab</h1><p className="text-xs opacity-70">Your Chrome. Shared with the agent.</p></div><span className="text-xs">Owner-only test VPS</span></header>
    <div className="flex flex-wrap items-center gap-2" aria-label="Automation controls">
      {(["agent-browser", "browser-use"] as const).map((tool) => <button key={tool} className={buttonClass} aria-pressed={engine === tool} disabled={!canCompare || busy || running || human} onClick={() => setEngine(tool)}>{tool === "browser-use" ? "Browser Use" : "agent-browser"}</button>)}
      <button className={buttonClass} disabled={!canCompare || busy || running || human} onClick={() => { void control("start"); }}>Run comparison</button>
      <button className={buttonClass} disabled={!canCompare || busy || human} onClick={() => { void control("takeover"); }}>Take over</button>
      <button className={buttonClass} disabled={!canCompare || busy || !canResume} onClick={() => { void control("resume"); }}>Resume</button>
      <button className={buttonClass} disabled={!canCompare || busy || ["idle", "stopped"].includes(status.phase)} onClick={() => { void control("stop"); }}>Stop</button>
      <button className={buttonClass} disabled={viewerBusy} onClick={() => { const signal = lifetime.current?.signal; if (signal) void reconnect(signal); }}>Reconnect preview</button>
    </div>
    {connected && !comparisonAvailable && <p className="text-xs opacity-70">Comparison controls are unavailable while shared Chat owns Chrome. Use Browser controls in Matrix.</p>}
    <div className="flex justify-between text-xs" aria-live="polite"><span>{busy ? "Applying action…" : stateLabel}</span><span>{status.workCompleted}/10 actions</span></div>
    {error && <p role="alert" className="text-sm">{error}</p>}
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-[var(--border)]">
      {viewerUrl ? <iframe title="Live VPS Chrome including password manager windows" src={viewerUrl} className="h-full w-full border-0" allow="clipboard-read; clipboard-write; fullscreen" tabIndex={interactive ? 0 : -1} inert={!interactive} style={{ pointerEvents: interactive ? "auto" : "none" }} /> : <div className="p-4 text-sm">{viewerBusy ? "Opening browser preview…" : "Browser connection unavailable"}</div>}
      {running && <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-[var(--background)] px-2 py-1 text-xs">Watching live · Take over to click</span>}
    </div>
    <p className="text-xs opacity-70">Takeover disconnects automation and keeps Chrome open. Resume observes again and continues from a fixture checkpoint.</p>
    <p className="text-xs opacity-70">Take over to sign in to 1Password privately. Real passwords, passkeys and device approval require your participation.</p>
  </section>;
}
