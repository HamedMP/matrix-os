/**
 * While composing with guests: who is overlaid on the grid in which colour,
 * whether their busy time loaded, and suggested free slots to pick from.
 */
import { RefreshCw } from "lucide-react";
import { Spinner } from "../../../_shared/office-ui";
import { instantToMs } from "../../../_shared/office-accounts/types/calendar";
import type { AssistantState } from "../model";
import type { Proposal } from "../model/proposals";
import { personColorClass } from "./colors";
import { durationLabel, formatShortDate, formatTime } from "./format";
import { dayKeyAt } from "../model/dates";

export interface SchedulingAssistantProps {
  assistant: AssistantState;
  proposals: readonly Proposal[];
  timeZone: string;
  /** Length of the meeting being searched for. */
  durationMinutes: number;
  onApply(proposalId: string): void;
  onFind(): void;
  onRetry(): void;
}

export function SchedulingAssistant({ assistant, proposals, timeZone, durationMinutes, onApply, onFind, onRetry }: SchedulingAssistantProps) {
  if (assistant.attendees.length === 0) return null;
  const suggestions = proposals.filter((proposal) => proposal.source === "assistant");
  return (
    <section className="cal-assistant" aria-label="Scheduling assistant">
      <div className="cal-assistant__head">
        <h3>Availability</h3>
        {assistant.status === "loading" && <Spinner label="Loading availability" size={14} />}
      </div>
      <ul className="cal-assistant__legend" aria-label="Busy time colours">
        {assistant.attendees.map((address, index) => (
          <li key={address} className={personColorClass(index)}>
            <span className="cal-attendee__dot" aria-hidden="true" />
            {address}
          </li>
        ))}
      </ul>
      {assistant.status === "error" && (
        <p className="cal-assistant__error" role="alert">
          {assistant.error ?? "Could not load availability."}{" "}
          <button type="button" className="oui-button oui-button--ghost" onClick={onRetry}>Retry</button>
        </p>
      )}
      <div className="cal-assistant__head">
        <h3>Suggested times ({durationLabel(durationMinutes)})</h3>
        <button type="button" className="oui-icon-button" aria-label="Find times again" onClick={onFind} disabled={assistant.status !== "ready"}>
          <RefreshCw size={14} />
        </button>
      </div>
      {assistant.status === "ready" && suggestions.length === 0 && (
        <p className="cal-assistant__none">No common free time in this range. Try the next week.</p>
      )}
      <ul className="cal-assistant__slots">
        {suggestions.map((proposal) => {
          const startMs = instantToMs(proposal.start);
          return (
            <li key={proposal.id}>
              <button type="button" className="oui-chip cal-assistant__slot" onClick={() => onApply(proposal.id)}>
                {formatShortDate(dayKeyAt(startMs, timeZone))}, {formatTime(startMs, timeZone)} – {formatTime(instantToMs(proposal.end), timeZone)}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
