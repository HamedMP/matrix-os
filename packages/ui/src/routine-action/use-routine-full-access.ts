import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RoutineFullAccessStatus } from "@matrix-os/contracts";
import type { RoutineFullAccessClient } from "./full-access-client.js";

export interface RoutineFullAccessContext {
  client?: RoutineFullAccessClient; chatId?: string; identity: string; enabled: boolean; manage?: boolean;
  browserOrigin: boolean; openOwnerBrowser?: (signal?: AbortSignal) => Promise<void>;
}
/** Ephemeral presentation only. Mount/focus reads do not create or renew consent. */
export function useRoutineFullAccess(input: RoutineFullAccessContext & {
  permissionMode: string; onPermissionModeChange: (mode: string) => void;
}) {
  const { client, chatId, identity, enabled, browserOrigin, openOwnerBrowser } = input;
  const manage = input.manage ?? enabled;
  const key = useMemo(() => ({ client, chatId, identity, enabled, manage, browserOrigin }), [client, chatId, identity, enabled, manage, browserOrigin]);
  const scope = useRef<{ key: typeof key; abort: AbortController; busy: boolean; generation: number; view: RoutineFullAccessStatus | null } | null>(null);
  const commit = useRef(input.onPermissionModeChange); commit.current = input.onPermissionModeChange;
  const [status, setStatus] = useState<RoutineFullAccessStatus | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [open, setOpen] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const requestIds = useRef<Partial<Record<"approve" | "decline", { challengeId: string; id: string }>>>({});
  useLayoutEffect(() => {
    const current = { key, abort: new AbortController(), busy: false, generation: 0, view: null as RoutineFullAccessStatus | null };
    scope.current = current; requestIds.current = {}; setStatus(null); setError(null); setBusy(false); setOpen(false);
    return () => { current.abort.abort(); if (scope.current === current) scope.current = null; };
  }, [key]);
  const currentScope = () => {
    const current = scope.current;
    return current?.key === key && !current.abort.signal.aborted ? current : null;
  };
  const refresh = async () => {
    const current = currentScope(); if (!current || !client || !chatId || !manage || current.busy) return;
    const generation = ++current.generation;
    try {
      const next = await client.read(chatId, current.abort.signal);
      if (currentScope() === current && current.generation === generation) { current.view = next; setStatus(next); setClock(Date.now()); setError(null); }
    } catch (failure: unknown) {
      console.warn("[routine-full-access] Status unavailable", failure instanceof Error ? failure.name : "UnknownError");
      if (currentScope() === current && current.generation === generation) { current.view = null; setStatus(null); setError("Routine CLI access could not be checked. Refresh to try again."); }
    }
  };
  useEffect(() => {
    if (!client || !chatId || !manage) return;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 15_000);
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { clearInterval(timer); window.removeEventListener("focus", focus); };
    // The key captures all owner/Computer/Chat/client authority, never a stored scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (!status?.consent && !status?.challenge) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status]);
  const perform = async (work: (current: NonNullable<typeof scope.current>) => Promise<void>) => {
    const current = currentScope(); if (!current || current.busy || !client || !chatId || !manage) return;
    current.busy = true; current.generation++; setBusy(true); setError(null);
    try { await work(current); }
    catch (failure: unknown) {
      console.warn("[routine-full-access] Operation unavailable", failure instanceof Error ? failure.name : "UnknownError");
      if (currentScope() === current) { current.view = null; setStatus(null); setError("Could not save routine CLI access. Refresh before trying again."); setOpen(true); }
    } finally { if (currentScope() === current) { current.busy = false; setBusy(false); } }
  };
  const beginReview = () => {
    setOpen(true);
    if (!browserOrigin || !enabled) return;
    void perform(async current => {
      const fresh = await client!.read(chatId!, current.abort.signal);
      if (currentScope() !== current) return;
      if (fresh.eligibility === "ineligible" || fresh.eligibility === "target_required") { current.view = fresh; setStatus(fresh); return; }
      const next = fresh.consent && Date.parse(fresh.consent.expiresAt) > Date.now() ? fresh
        : await client!.challenge(chatId!, fresh.revision, current.abort.signal);
      if (currentScope() === current) { current.view = next; setStatus(next); setClock(Date.now()); }
    });
  };
  const decide = (decision: "approve" | "decline") => {
    const challenge = status?.challenge;
    if (!enabled || !browserOrigin || currentScope()?.view !== status || !challenge || Date.parse(challenge.expiresAt) <= Date.now()
      || status?.eligibility === "ineligible" || status?.eligibility === "target_required") return;
    void perform(async current => {
      const previous = requestIds.current[decision];
      const id = previous?.challengeId === challenge.challengeId ? previous.id : crypto.randomUUID();
      requestIds.current[decision] = { challengeId: challenge.challengeId, id };
      const next = await client!.decide(chatId!, challenge.challengeId, { scopeDigest: challenge.scopeDigest, decision, clientRequestId: id }, current.abort.signal);
      if (currentScope() === current) { current.view = next; setStatus(next); setClock(Date.now()); }
    });
  };
  const revoke = (after?: () => void) => {
    void perform(async current => {
      const fresh = await client!.read(chatId!, current.abort.signal);
      if (currentScope() !== current) return;
      const next = await client!.revoke(chatId!, fresh.revision, current.abort.signal);
      if (next.consent || next.challenge) throw new Error("Routine CLI revocation unconfirmed");
      if (currentScope() === current) { current.view = next; setStatus(next); setClock(Date.now()); after?.(); }
    });
  };
  const guardSelectionChange = (qualified: boolean, after: () => void) => {
    if (!currentScope() || currentScope()?.busy) return;
    if (!qualified && manage && client && chatId && (input.permissionMode === "full_access" || status?.consent || status?.challenge)) {
      revoke(after); return;
    }
    after();
  };
  const changeMode = (mode: string) => guardSelectionChange(enabled && mode === "full_access", () => {
    commit.current(mode);
    if (mode === "full_access" && enabled && client && chatId) beginReview();
    else setOpen(false);
  });
  const consent = status?.consent && Date.parse(status.consent.expiresAt) > clock ? status.consent : null;
  const challenge = status?.challenge && Date.parse(status.challenge.expiresAt) > clock ? status.challenge : null;
  return { status, consent, challenge, busy, error, open, setOpen, browserOrigin, grantEnabled: enabled,
    visible: manage && ((enabled && input.permissionMode === "full_access" && status?.eligibility !== "ineligible") || busy || error !== null),
    refresh, beginReview, decide, revoke: () => revoke(), changeMode, guardSelectionChange,
    openOwnerBrowser: openOwnerBrowser ? () => perform(async current => { await openOwnerBrowser(current.abort.signal); }) : undefined };
}
export type RoutineFullAccessController = ReturnType<typeof useRoutineFullAccess>;
