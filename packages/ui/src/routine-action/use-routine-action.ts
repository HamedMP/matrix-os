import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RoutineActionView, RoutineActionSubmit } from "@matrix-os/contracts";
import type { RoutineActionClient } from "./client.js";
/** Shared owner/Computer/session fencing and one-operation decision lifecycle for web and Native Mobile. */
export function useRoutineAction({ client, challengeId, identity, openConfirmation, createRequestId = () => crypto.randomUUID() }: {
  client: RoutineActionClient; challengeId: string; identity: string; openConfirmation?: (id: string, signal?: AbortSignal) => Promise<void>; createRequestId?: () => string;
}) {
  const [view, setView] = useState<RoutineActionView | null>(null), [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState(false), [opened, setOpened] = useState(false);
  const scopeKey = useMemo(() => ({ client, challengeId, identity }), [client, challengeId, identity]);
  const scope = useRef<{ key: typeof scopeKey; view: RoutineActionView | null; fresh: boolean; active: boolean; busy: boolean; generation: number; abort: AbortController } | null>(null), requestIds = useRef<Partial<Record<RoutineActionSubmit["decision"], string>>>({});
  useLayoutEffect(() => {
    const current = { key: scopeKey, view: null as RoutineActionView | null, fresh: false, active: true, busy: false, generation: 0, abort: new AbortController() }; scope.current = current; requestIds.current = {};
    setView(null); setFresh(false); setError(null); setBusy(false); setOpened(false);
    return () => { current.active = false; current.abort.abort(); if (scope.current === current) scope.current = null; };
  }, [scopeKey]);
  useEffect(() => {
    const current = scope.current; if (!current) return;
    let reading = false;
    const read = async () => { if (reading || !current.active || current.busy) return; reading = true; const generation = ++current.generation;
      try { const next = await client.read(challengeId, current.abort.signal); if (scope.current === current && current.active && current.generation === generation) { current.view = next; current.fresh = true; setView(next); setFresh(true); setError(null); } }
      catch (failure: unknown) { console.warn("[routine-action] Confirmation read unavailable", failure instanceof Error ? failure.name : "UnknownError"); if (scope.current === current && current.active && current.generation === generation) { current.fresh = false; setFresh(false); setError("Could not refresh this confirmation. Try again."); } }
      finally { reading = false; }
    };
    void read(); const timer = setInterval(() => { void read(); }, 2000); return () => clearInterval(timer);
  }, [client, challengeId, identity]);
  const status: RoutineActionView["status"] | undefined = view?.status === "pending" ? Date.parse(view.expiresAt) <= Date.now() ? "expired" : fresh ? "pending" : "unavailable" : view?.status;
  const active = status === "pending";
  const submit = async (decision: RoutineActionSubmit["decision"]) => {
    const current = scope.current; if (!current?.active || current.key !== scopeKey || current.busy || !view || current.view !== view
      || !current.fresh || view.status !== "pending" || Date.parse(view.expiresAt) <= Date.now() || !active) return;
    current.busy = true; current.generation++; setBusy(true); setError(null);
    try {
      if (openConfirmation) { await openConfirmation(challengeId, current.abort.signal); if (scope.current === current && current.active) setOpened(true); }
      else {
        const clientRequestId = requestIds.current[decision] ??= createRequestId();
        await client.submit(challengeId, { decision, clientRequestId, actionDigest: view.actionDigest }, current.abort.signal);
        if (!current.active || scope.current !== current) return;
        const next = await client.read(challengeId, current.abort.signal);
        if (scope.current === current && current.active) { current.view = next; current.fresh = true; setView(next); setFresh(true); }
      }
    } catch (failure: unknown) { console.warn("[routine-action] Confirmation unavailable", failure instanceof Error ? failure.name : "UnknownError"); if (scope.current === current && current.active) { current.fresh = false; setFresh(false); setError("Could not confirm this operation. Refresh before trying again."); } }
    finally { if (scope.current === current && current.active) { current.busy = false; setBusy(false); } }
  };
  return { view, status, error, busy, opened, active, submit };
}
