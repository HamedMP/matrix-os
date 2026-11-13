import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BotInteraction, RoutineChatOriginView } from "@matrix-os/contracts";
import {
  isRoutineOriginApproval, ROUTINE_ORIGIN_ERROR, type RoutineOriginClient, type RoutineOriginDecision,
} from "./routine-origin-client.js";

type Scope = { client?: RoutineOriginClient | null; chatId?: string | null; eligible: boolean; identity?: unknown };
type ExactDecision = { interactionId: string; baseRevision: number; decision: RoutineOriginDecision["decision"] };
type Status = {
  view: RoutineChatOriginView | null; pending: boolean; error: string; notice: string; uncertain: ExactDecision | null;
};
const empty: Status = { view: null, pending: false, error: "", notice: "", uncertain: null };
type Session = { scope: Scope; controller: AbortController; status: Status; sequence: number; reading: boolean };

/** A source view may contain private proposal text. Invalidate the read and all
 * transports together when the source or owner/Computer scope changes. */
export function useRoutineOrigin({ client, chatId, eligible, revision = 0, identity }: Scope & { revision?: number }) {
  const scope = useMemo(() => ({ client, chatId, eligible, identity }), [client, chatId, eligible, identity]);
  const current = useRef<Session | null>(null);
  const [stored, setStored] = useState<{ scope: Scope; status: Status } | null>(null);
  const state = stored?.scope === scope ? stored.status : empty;
  useLayoutEffect(() => {
    const session = { scope, controller: new AbortController(), status: empty, sequence: 0, reading: false };
    current.current = session;
    return () => { current.current = null; session.controller.abort(); };
  }, [scope]);
  const update = useCallback((session: Session, patch: Partial<Status>) => {
    if (current.current !== session) return;
    session.status = { ...session.status, ...patch };
    setStored({ scope: session.scope, status: session.status });
  }, []);
  const load = useCallback(async (reconcile = false) => {
    const session = current.current;
    if (!session || session.scope !== scope || !client || !chatId || !eligible) return;
    if (!reconcile && (session.reading || session.status.pending)) return;
    const sequence = ++session.sequence;
    session.reading = true;
    try {
      const view = await client.get(chatId, session.controller.signal);
      if (view.sourceChatId !== chatId || [...view.pending, ...(view.history ?? [])].some(item =>
        item.sourceChatId !== chatId || !isRoutineOriginApproval(item.interaction)) ||
        view.history?.some(item => item.interaction.status === "pending")) throw new Error(ROUTINE_ORIGIN_ERROR);
      if (sequence === session.sequence) {
        const pin = session.status.uncertain;
        const stillPending = view.pending.some(({ interaction }) =>
          interaction.interactionId === pin?.interactionId && interaction.revision === pin.baseRevision);
        update(session, { view, error: "", uncertain: stillPending ? pin : null });
      }
    } catch (error: unknown) {
      if (!session.controller.signal.aborted && sequence === session.sequence) {
        console.warn("[routine-origin] Read unavailable", error instanceof Error ? error.name : "UnknownError");
        update(session, { view: null, error: ROUTINE_ORIGIN_ERROR });
      }
    } finally {
      if (sequence === session.sequence) session.reading = false;
    }
  }, [client, chatId, eligible, scope, update]);
  useEffect(() => {
    if (!eligible || !client || !chatId) return;
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load, eligible, client, chatId, revision]);

  const resolve = async (interaction: BotInteraction, input: RoutineOriginDecision) => {
    const session = current.current;
    if (!session || session.scope !== scope || !client || !chatId || !eligible) throw new Error(ROUTINE_ORIGIN_ERROR);
    const { view, pending, uncertain } = session.status;
    const exact = { interactionId: interaction.interactionId, baseRevision: input.baseRevision, decision: input.decision };
    if (pending || interaction.revision !== exact.baseRevision ||
        !view?.pending.some(item => item.interaction.interactionId === exact.interactionId &&
          item.interaction.revision === exact.baseRevision) ||
        (uncertain && (uncertain.interactionId !== exact.interactionId ||
          uncertain.baseRevision !== exact.baseRevision || uncertain.decision !== exact.decision))) throw new Error(ROUTINE_ORIGIN_ERROR);
    session.sequence++; // An earlier poll must not overwrite the post-decision read.
    update(session, { pending: true });
    try {
      const response = await client.resolve(chatId, exact.interactionId, input, session.controller.signal);
      update(session, { uncertain: null, notice: response.continuationPending
        ? "Your decision was saved. Continuation was not confirmed. Check execution history for current status." : "" });
      await load(true);
      return response;
    } catch (error: unknown) {
      update(session, { view: null, uncertain: exact, notice: "Your decision could not be confirmed. Check execution history before retrying." });
      await load(true);
      throw new Error(ROUTINE_ORIGIN_ERROR, { cause: error });
    } finally {
      update(session, { pending: false });
    }
  };
  return { ...state, fresh: state.view !== null, resolve, refresh: () => void load() };
}
export type RoutineOriginState = ReturnType<typeof useRoutineOrigin>;
