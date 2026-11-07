import type { RoutineChatOriginHistoryItem } from "@matrix-os/contracts";
import { InteractionCard } from "../chat-agents/bots/InteractionCard.js";
import { chatAgentButtonClass } from "../chat-agents/theme.js";
import { routineOriginHistoryStatus } from "./routine-approval-placement.js";
import type { RoutineOriginState } from "./use-routine-origin.js";
/** No BotMessageStateContext: an origin envelope never changes the canonical target. */
export function RoutineOriginApprovals({ state, items = state.view?.pending ?? [], notices = true, label = "Scheduled task approvals", earlier = false, onReviewInBrowser }: {
  state: RoutineOriginState;
  items?: readonly RoutineChatOriginHistoryItem[];
  notices?: boolean;
  earlier?: boolean;
  label?: string;
  onReviewInBrowser?: (interactionId: string) => void;
}) {
  const hasNotice = notices && (state.view?.deliveryPending || state.view?.hasMore || state.notice || state.error);
  if (!items.length && !hasNotice) return null;
  return <section aria-label={earlier ? "Scheduled task approvals from earlier messages" : label} className="grid min-w-0 gap-3">
    {earlier && items.length ? <p className="text-xs">From an earlier message in this Chat.</p> : null}
    {items.map(item => {
      const { interaction } = item;
      const historicalStatus = routineOriginHistoryStatus(item);
      const exactDecision = state.uncertain?.interactionId === interaction.interactionId ? state.uncertain : null;
      const canRespond = !historicalStatus && state.fresh && !state.pending && (!state.uncertain || Boolean(exactDecision));
      return <div key={interaction.interactionId} data-origin-anchor={item.anchorMessageId}>
        <InteractionCard interaction={interaction} agentName="Existing Matrix Bot" actionsAvailable={canRespond && !onReviewInBrowser}
          readOnlyStatus={historicalStatus} approvalDecision={exactDecision?.decision}
          decisionError="Your decision could not be confirmed. Check execution history before retrying."
          unavailableMessage={onReviewInBrowser ? "Review in your browser to respond." : undefined}
          onResolve={input => {
            if (input.kind !== "approval") throw new Error("This decision is unavailable.");
            return state.resolve(interaction, input);
          }}/>
        {onReviewInBrowser && !historicalStatus ? <button type="button" className={`${chatAgentButtonClass} justify-self-start`} disabled={!canRespond}
          onClick={() => onReviewInBrowser(interaction.interactionId)}>Review in browser</button> : null}
      </div>;
    })}
    {hasNotice ? <>
    {state.notice?<p role="status" className="text-sm">{state.notice}</p>:null}
    {state.view?.deliveryPending?<p role="status" className="text-sm">Scheduled task results are still arriving or unavailable. Check execution history in Schedules.</p>:null}
    {state.view?.hasMore?<p role="status" className="text-xs">More scheduled task items are available in Schedules.</p>:null}
    {state.error?<p role="alert" className="text-sm">{state.error}</p>:null}
    {state.error?<button type="button" className={`${chatAgentButtonClass} justify-self-start`} disabled={state.pending} onClick={state.refresh}>Refresh scheduled tasks</button>:null}
    </> : null}
  </section>;
}
