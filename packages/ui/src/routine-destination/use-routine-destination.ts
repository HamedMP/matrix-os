import { useCallback, useEffect, useRef, useState } from "react";
import { ROUTINE_DESTINATION_COPY as copy, routineDestinationPresentation, type RoutineDestinationView } from "@matrix-os/contracts/routine-destination";
import { safeHttpStatus } from "../chat-agents/safe-http-status.js";
export interface RoutineDestinationClient {
  get(signal?: AbortSignal): Promise<RoutineDestinationView>;
  remember(input: { botId: string; chatId: string; baseRevision: number }, signal?: AbortSignal): Promise<RoutineDestinationView>;
  reset(input: { baseRevision: number }, signal?: AbortSignal): Promise<RoutineDestinationView>;
}
type Scope = { client: RoutineDestinationClient | null; botId: string; chatId: string; eligible: boolean; request?: AbortController };
type State = { scope: Scope; view: RoutineDestinationView | null; pending: boolean; fresh: boolean; error: string };
/** One scoped selection, no global cache. Late loads/saves and retained old callbacks cannot overwrite
 * or mutate a new client/owner/Chat, including A -> B -> A. Every mutation is one explicit owner click. */
export function useRoutineDestination(input: Scope) {
  const current = useRef<Scope>({ ...input }), mutation = useRef<Scope | null>(null), mounted = useRef(false);
  if (current.current.client !== input.client || current.current.botId !== input.botId || current.current.chatId !== input.chatId || current.current.eligible !== input.eligible) current.current = { ...input };
  const scope = current.current, [stored, setStored] = useState<State | null>(null);
  const state = stored?.scope === scope ? stored : { scope, view: null, pending: true, fresh: false, error: "" };
  const active = useCallback((signal: AbortSignal) => mounted.current && current.current === scope && !signal.aborted, [scope]);
  const load = useCallback(async (signal: AbortSignal, message = "") => {
    if (!scope.client) { if (active(signal)) setStored({ scope, view: null, pending: false, fresh: false, error: copy.error }); return; }
    try {
      const view = await scope.client.get(signal);
      if (active(signal)) setStored({ scope, view, pending: false, fresh: true, error: message });
    } catch (error: unknown) {
      console.warn("[routine-destination] Load unavailable", error instanceof Error ? error.name : "UnknownError");
      if (active(signal)) setStored(previous => ({ scope, view: previous?.scope === scope ? previous.view : null, pending: false, fresh: false, error: message || copy.error }));
    }
  }, [scope, active]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); scope.request = controller;
    void load(controller.signal);
    return () => { mounted.current = false; controller.abort(); scope.request?.abort(); };
  }, [scope, load]);
  const refresh = () => {
    if (!mounted.current || current.current !== scope || state.pending) return;
    scope.request?.abort(); const controller = new AbortController(); scope.request = controller;
    setStored({ ...state, pending: true }); void load(controller.signal);
  };
  const mutate = async (kind: "remember" | "reset") => {
    if (!mounted.current || current.current !== scope || !scope.client || !state.view || !state.fresh || state.pending || mutation.current === scope) return;
    if (kind === "remember" && !scope.eligible) return;
    mutation.current = scope;
    scope.request?.abort(); const controller = new AbortController(); scope.request = controller;
    setStored({ ...state, pending: true, error: "" });
    try {
      const baseRevision = state.view.preference.revision;
      const view = kind === "remember" ? await scope.client.remember({ botId: scope.botId, chatId: scope.chatId, baseRevision }, controller.signal)
        : await scope.client.reset({ baseRevision }, controller.signal);
      if (active(controller.signal)) setStored({ scope, view, pending: false, fresh: true, error: "" });
    } catch (error: unknown) {
      console.warn("[routine-destination] Change unconfirmed", error instanceof Error ? error.name : "UnknownError");
      if (!active(controller.signal)) return;
      if (safeHttpStatus(error) === 409) await load(controller.signal, copy.conflict);
      else setStored({ ...state, pending: false, fresh: false, error: copy.saveError });
    } finally { if (mutation.current === scope) mutation.current = null; }
  };
  return { ...state, presentation: state.view ? routineDestinationPresentation(state.view, scope) : null, refresh,
    remember: () => mutate("remember"), reset: () => mutate("reset") };
}
