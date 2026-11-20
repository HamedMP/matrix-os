import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { NotificationPreferences } from "@matrix-os/contracts/notifications";
import type { GatewayClient } from "@/lib/gateway-client";

type Preferences = NotificationPreferences;
type Section = "events" | "phone" | "content";
type Scope = { ownerKey: string; client: GatewayClient | null; active: boolean };
interface State {
  scope: Scope;
  server: Preferences | null;
  draft: Preferences | null;
  latest: Preferences | null;
  conflict: boolean;
  pending: boolean;
  message: string | null;
  saved: boolean;
}
const empty = (scope: Scope): State => ({
  scope, server: null, draft: null, latest: null, conflict: false, pending: false, message: null, saved: false,
});
const dirty = (state: State) => JSON.stringify(state.server) !== JSON.stringify(state.draft);

/** Preserve changed fields only: another surface's unrelated edits must survive conflict recovery. */
function reapply(server: Preferences, draft: Preferences, latest: Preferences): Preferences {
  const next = { ...latest, events: { ...latest.events }, phone: { ...latest.phone }, content: { ...latest.content } };
  for (const section of ["events", "phone", "content"] as const) {
    for (const field of Object.keys(server[section]) as (keyof Preferences[typeof section])[]) {
      if (server[section][field] !== draft[section][field]) {
        Object.assign(next[section], { [field]: draft[section][field] });
      }
    }
  }
  return next;
}

export function useNotificationPreferences(client: GatewayClient | null, ownerKey: string) {
  const scope = useMemo<Scope>(() => ({ client, ownerKey, active: true }), [client, ownerKey]);
  const [state, setState] = useState(() => empty(scope));
  const stateRef = useRef(state);
  const currentScope = useRef(scope);
  useLayoutEffect(() => { currentScope.current = scope; }, [scope]);
  const operation = useRef<Scope | null>(null);
  const isCurrent = () => scope.active && currentScope.current === scope;
  function change(update: (current: State) => State) {
    if (!isCurrent()) return;
    const current = stateRef.current.scope === scope ? stateRef.current : empty(scope);
    const next = update(current);
    stateRef.current = next;
    setState(next);
  }
  async function load(conflict: boolean) {
    if (!client || !isCurrent()) return;
    const result = await client.getNotificationPreferences();
    if (!isCurrent()) return;
    if (result.ok) change((current) => conflict
      ? { ...current, latest: result.preferences, message: null }
      : { ...current, server: result.preferences, draft: result.preferences, message: null });
    else change((current) => ({
      ...current,
      message: result.reason === "unsupported"
        ? "Update this Matrix computer to use notification settings."
        : conflict ? "Couldn’t reload notification settings. Your edits are still here."
          : "Couldn’t load notification settings. Try again.",
    }));
  }
  async function reload() {
    if (!isCurrent() || operation.current === scope) return;
    operation.current = scope;
    change((current) => ({ ...current, pending: true, saved: false }));
    try {
      await load(stateRef.current.scope === scope && stateRef.current.conflict);
    } catch (error: unknown) {
      console.warn("[mobile] Notification settings reload failed", error instanceof Error ? error.name : "unknown");
      change((current) => ({ ...current, message: "Couldn’t reload notification settings. Try again." }));
    } finally {
      if (operation.current === scope) operation.current = null;
      change((current) => ({ ...current, pending: false }));
    }
  }
  useEffect(() => {
    scope.active = true;
    // Each client/account/computer owns a fresh draft; late requests retain their old scope.
    stateRef.current = empty(scope);
    setState(stateRef.current);
    void reload();
    return () => { scope.active = false; };
    // Requests use the exact client captured by this scope, never a later render's client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  async function save() {
    const current = stateRef.current;
    if (!client || !isCurrent() || current.scope !== scope || !current.draft || !dirty(current) || current.conflict || operation.current === scope) return;
    operation.current = scope;
    change((value) => ({ ...value, pending: true, message: null, saved: false }));
    try {
      const result = await client.updateNotificationPreferences(current.draft);
      if (!isCurrent()) return;
      if (result.ok) change((value) => ({
        ...value, server: result.preferences, draft: result.preferences, saved: true,
      }));
      else if (result.reason === "conflict") {
        change((value) => ({ ...value, conflict: true, latest: null }));
        await load(true);
      } else change((value) => ({
        ...value, message: result.reason === "unsupported"
          ? "Update this Matrix computer to save notification settings."
          : "Couldn’t save notification settings. Your edits are still here. Try again.",
      }));
    } catch (error: unknown) {
      console.warn("[mobile] Notification settings save failed", error instanceof Error ? error.name : "unknown");
      change((value) => ({ ...value, message: "Couldn’t save notification settings. Your edits are still here. Try again." }));
    } finally {
      if (operation.current === scope) operation.current = null;
      change((value) => ({ ...value, pending: false }));
    }
  }
  const visible = state.scope === scope ? state : empty(scope);
  return {
    ...visible,
    dirty: dirty(visible),
    reload,
    save,
    edit: <S extends Section, K extends keyof Preferences[S]>(section: S, field: K, value: Preferences[S][K]) => {
      if (operation.current === scope) return;
      change((current) => current.draft ? {
        ...current, draft: { ...current.draft, [section]: { ...current.draft[section], [field]: value } }, saved: false,
      } : current);
    },
    resolve: (keepChanges: boolean) => change((current) => {
      if (!current.latest || !current.server || !current.draft || current.pending) return current;
      return {
        ...current, server: current.latest,
        draft: keepChanges ? reapply(current.server, current.draft, current.latest) : current.latest,
        latest: null, conflict: false, message: null, saved: false,
      };
    }),
  };
}
