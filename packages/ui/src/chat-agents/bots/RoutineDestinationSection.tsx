import { ROUTINE_DESTINATION_COPY as copy } from "@matrix-os/contracts/routine-destination";
import { useRoutineDestination, type RoutineDestinationClient } from "../../routine-destination/use-routine-destination.js";
import { chatAgentButtonClass, chatAgentMutedStyle } from "../theme.js";
export function RoutineDestinationSection({ client, botId, chatId, eligible }: { client: RoutineDestinationClient | null; botId: string; chatId: string; eligible: boolean }) {
  const state = useRoutineDestination({ client, botId, chatId, eligible });
  return <section className="grid gap-2" aria-label={copy.title}>
    <h4 className="text-xs font-semibold">{copy.title}</h4>
    <p className="text-xs" style={chatAgentMutedStyle} role="status">{state.presentation?.message ?? (state.pending ? copy.loading : copy.unknown)}</p>
    <p className="text-xs leading-5" style={chatAgentMutedStyle}>{copy.explanation}</p>
    {state.error ? <p role="alert" className="text-xs">{state.error}</p> : null}
    <div className="flex flex-wrap gap-2">
      {state.presentation?.canRemember !== false && eligible ? <button type="button" className={chatAgentButtonClass} disabled={state.pending || !state.fresh} onClick={() => { void state.remember(); }}>{state.presentation?.remember ?? copy.remember}</button> : null}
      {state.presentation?.canReset ? <button type="button" className={chatAgentButtonClass} disabled={state.pending || !state.fresh} onClick={() => { void state.reset(); }}>{copy.reset}</button> : null}
      <button type="button" className={chatAgentButtonClass} disabled={state.pending} onClick={state.refresh}>{copy.retry}</button>
    </div>
    {state.pending && state.view ? <p role="status" className="text-xs">{copy.pending}</p> : null}
  </section>;
}
