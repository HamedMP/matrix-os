/**
 * The body of one agent answer: clickable time chips that highlight events
 * and slots on the grid, notes, and "Open draft" actions. All text is
 * rendered as text; event titles come from other people.
 */
import type { CalendarAgentAnswer, EventRef, SlotRef } from "../../agent";
import { eventLabel, slotLabel } from "../../agent";
import type { Proposal } from "../../model";

export type CalendarHighlight =
  | { type: "event"; id: string; start: string; end: string }
  | { type: "slot"; id: string; start: string; end: string };

export interface AnswerActions {
  highlight(target: CalendarHighlight): void;
  openDraft(): void;
  openSlot(slot: SlotRef): void;
  openProposal(proposal: Proposal): void;
}

interface AnswerBodyProps {
  answer: CalendarAgentAnswer;
  /** Proposals as the store holds them (kind "proposals" only). */
  proposals: readonly Proposal[];
  timeZone: string;
  activeId: string | null;
  actions: AnswerActions;
}

function EventChip({ event, timeZone, active, onClick }: { event: EventRef; timeZone: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className="oui-chip cal-agent__chip" aria-pressed={active} onClick={onClick}>
      <span className="cal-agent__chip-title">{event.title || "(no title)"}</span>
      <span className="cal-agent__chip-time">{eventLabel(event, timeZone)}</span>
    </button>
  );
}

function SlotRow({ slot, timeZone, active, onHighlight, onOpen, openLabel }: {
  slot: SlotRef;
  timeZone: string;
  active: boolean;
  onHighlight: () => void;
  onOpen: () => void;
  openLabel: string;
}) {
  const label = slotLabel(slot, timeZone);
  return (
    <li className="cal-agent__slot">
      <button type="button" className="oui-chip cal-agent__chip" aria-pressed={active} aria-label={`Show ${label} on the calendar`} onClick={onHighlight}>
        <span className="cal-agent__chip-time">{label}</span>
      </button>
      <button type="button" className="oui-button cal-agent__open" aria-label={`${openLabel} for ${label}`} onClick={onOpen}>{openLabel}</button>
    </li>
  );
}

export function AnswerBody({ answer, proposals, timeZone, activeId, actions }: AnswerBodyProps) {
  const slotHighlight = (slot: SlotRef) => actions.highlight({ type: "slot", id: slot.id, start: slot.start, end: slot.end });
  return (
    <div className="cal-agent__answer">
      {answer.events.length > 0 && (
        <div className="cal-agent__chips" role="group" aria-label="Events">
          {answer.events.map((event) => (
            <EventChip
              key={event.id}
              event={event}
              timeZone={timeZone}
              active={activeId === event.id}
              onClick={() => actions.highlight({ type: "event", id: event.id, start: event.start, end: event.end })}
            />
          ))}
        </div>
      )}

      {answer.kind === "proposals" && proposals.length > 0 && (
        <ul className="cal-agent__slots" aria-label="Suggested times">
          {proposals.map((proposal) => {
            // The grid draws this time as the proposal's block, so the highlight names the proposal.
            const slot: SlotRef = { id: proposal.id, start: proposal.start, end: proposal.end };
            return (
              <SlotRow key={proposal.id} slot={slot} timeZone={timeZone} active={activeId === slot.id} openLabel="Open draft"
                onHighlight={() => slotHighlight(slot)} onOpen={() => actions.openProposal(proposal)} />
            );
          })}
        </ul>
      )}

      {(answer.kind === "slots" || answer.kind === "reschedule") && answer.slots.length > 0 && (
        <ul className="cal-agent__slots" aria-label={answer.kind === "slots" ? "Free times" : "New times"}>
          {answer.slots.map((slot) => (
            <SlotRow key={slot.id} slot={slot} timeZone={timeZone} active={activeId === slot.id} openLabel="Open draft"
              onHighlight={() => slotHighlight(slot)} onOpen={() => actions.openSlot(slot)} />
          ))}
        </ul>
      )}

      {answer.kind === "draft" && (
        <div className="cal-agent__draft">
          {answer.slots[0] && (
            <button type="button" className="oui-chip cal-agent__chip" aria-pressed={activeId === answer.slots[0].id} onClick={() => slotHighlight(answer.slots[0])}>
              <span className="cal-agent__chip-time">{slotLabel(answer.slots[0], timeZone)}</span>
            </button>
          )}
          <button type="button" className="oui-button oui-button--primary" onClick={actions.openDraft}>Open draft</button>
        </div>
      )}

      {answer.notes.length > 0 && (
        <ul className="cal-agent__notes">
          {answer.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
    </div>
  );
}
