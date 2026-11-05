import { InteractionCard } from "../chat-agents/bots/InteractionCard.js";
import { chatAgentButtonClass } from "../chat-agents/theme.js";
import type { RoutineOriginState } from "./use-routine-origin.js";
/** No BotMessageStateContext: an origin envelope never changes the canonical target. */
export function RoutineOriginApprovals({state,onReviewInBrowser}:{state:RoutineOriginState;onReviewInBrowser?:(interactionId:string)=>void}) {
  if(!state.view?.pending.length&&!state.view?.deliveryPending&&!state.view?.hasMore&&!state.notice&&!state.error)return null;
  return <section aria-label="Scheduled task approvals" className="grid min-w-0 gap-3">
    {state.view?.pending.map(item=><div key={`${item.interaction.interactionId}:${item.interaction.revision}`} data-origin-anchor={item.anchorMessageId}>
      <InteractionCard interaction={item.interaction} agentName="Existing Matrix Bot" actionsAvailable={!onReviewInBrowser&&state.fresh&&!state.pending&&(!state.uncertain||state.uncertain.interactionId===item.interaction.interactionId)}
        approvalDecision={state.uncertain?.decision} decisionError="Your decision could not be confirmed. Check execution history before retrying."
        unavailableMessage={onReviewInBrowser?"Review in your browser to respond.":undefined}
        onResolve={input=>{if(input.kind!=="approval")throw new Error("This decision is unavailable.");return state.resolve(item.interaction,input);}}/>
      {onReviewInBrowser?<button type="button" className={`${chatAgentButtonClass} justify-self-start`} disabled={!state.fresh||state.pending} onClick={()=>onReviewInBrowser(item.interaction.interactionId)}>Review in browser</button>:null}
    </div>)}
    {state.notice?<p role="status" className="text-sm">{state.notice}</p>:null}
    {state.view?.deliveryPending?<p role="status" className="text-sm">Scheduled task results are still arriving or unavailable. Check execution history in Schedules.</p>:null}
    {state.view?.hasMore?<p role="status" className="text-xs">More scheduled task items are available in Schedules.</p>:null}
    {state.error?<p role="alert" className="text-sm">{state.error}</p>:null}
    {state.error?<button type="button" className={`${chatAgentButtonClass} justify-self-start`} disabled={state.pending} onClick={state.refresh}>Refresh scheduled tasks</button>:null}
  </section>;
}
