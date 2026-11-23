/**
 * Agenda view: events listed under each day they touch.
 */
import { useMemo } from "react";
import { CalendarDays } from "lucide-react";
import { EmptyState } from "../../../_shared/office-ui";
import { instantToMs, type CalendarInfo } from "../../../_shared/office-accounts/types/calendar";
import type { CalendarState } from "../model";
import { groupAgenda } from "../model/agenda";
import { calendarColorStyle } from "./colors";
import { formatLongDate, formatTime } from "./format";

export interface AgendaViewProps {
  state: CalendarState;
  calendarsById: Readonly<Record<string, CalendarInfo>>;
  onOpenEvent(eventId: string, anchor: HTMLElement): void;
  onNewEvent(): void;
}

export function AgendaView({ state, calendarsById, onOpenEvent, onNewEvent }: AgendaViewProps) {
  const pendingIds = useMemo(() => new Set(state.pendingEventIds), [state.pendingEventIds]);
  const groups = useMemo(() => groupAgenda(state.events, state.range.days, state.timeZone), [state.events, state.range.days, state.timeZone]);

  if (groups.length === 0 && state.eventsStatus === "ready") {
    return (
      <EmptyState
        icon={<CalendarDays />}
        headline="Nothing scheduled"
        description={`No events in the next ${state.range.days.length} days on the calendars you are showing.`}
        action={{ label: "New event", onClick: onNewEvent }}
      />
    );
  }

  return (
    <section className="cal-agenda" aria-label="Agenda">
      {groups.map((group) => (
        <section key={group.key} className="cal-agenda__day" data-day={group.key} aria-label={formatLongDate(group.key)}>
          <h2 className={`cal-agenda__date${group.key === state.today ? " is-today" : ""}`}>{formatLongDate(group.key)}</h2>
          <ul className="cal-agenda__list">
            {group.items.map((item) => {
              const { event } = item;
              const calendar = calendarsById[event.calendarId];
              const when = item.wholeDay
                ? "All day"
                : `${formatTime(instantToMs(event.start), state.timeZone)} – ${formatTime(instantToMs(event.end), state.timeZone)}`;
              return (
                <li key={`${group.key}-${event.id}`}>
                  <button
                    type="button"
                    data-event-id={event.id}
                    className={`cal-agenda__item${pendingIds.has(event.id) ? " is-pending" : ""}${event.myResponse === "declined" ? " is-declined" : ""}`}
                    style={calendarColorStyle(calendar)}
                    onClick={(click) => onOpenEvent(event.id, click.currentTarget)}
                  >
                    <span className="cal-swatch" aria-hidden="true" />
                    <span className="cal-agenda__when">{when}</span>
                    <span className="cal-agenda__title">{event.title || "(No title)"}</span>
                    {event.location && <span className="cal-agenda__location">{event.location}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </section>
  );
}
