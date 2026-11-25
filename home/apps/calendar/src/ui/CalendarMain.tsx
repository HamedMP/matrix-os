/**
 * The main area: empty and loading states, or the active view.
 */
import { CalendarDays } from "lucide-react";
import { EmptyState, Skeleton } from "../../../_shared/office-ui";
import type { CalendarInfo, IsoInstant } from "../../../_shared/office-accounts/types/calendar";
import type { CalendarState, CalendarStore } from "../model";
import { AgendaView } from "./AgendaView";
import { MonthView } from "./MonthView";
import { TimeGrid } from "./TimeGrid";

/** The launcher artwork, shown where the app introduces itself. */
const appArtwork = new URL("../../../../system/icons/v3-calendar.png", import.meta.url).href;

export interface CalendarMainProps {
  store: CalendarStore;
  state: CalendarState;
  now: number;
  calendarsById: Readonly<Record<string, CalendarInfo>>;
  isEditable(eventId: string): boolean;
  onOpenEvent(eventId: string, anchor: HTMLElement): void;
  onCreate(dayKey: string, startMinute: number, endMinute?: number): void;
  onChangeTime(eventId: string, startMs: number, endMs: number): void;
  onProposal(proposalId: string): void;
  onPickDay(dayKey: string): void;
  onNewEvent(): void;
  /** A time the agent answered with that has no proposal block; the time grid draws it. */
  marker?: { id: string; start: IsoInstant; end: IsoInstant } | null;
}

export function CalendarMain(props: CalendarMainProps) {
  const { store, state, calendarsById } = props;
  const noAccounts = state.accounts.length === 0;

  if (noAccounts && state.accountsStatus === "error") {
    return (
      <EmptyState
        icon={<CalendarDays />}
        headline="Calendars could not be loaded"
        description={state.accountsError ?? "Something went wrong. Try again."}
        action={{ label: "Try again", onClick: () => void store.loadAccounts() }}
      />
    );
  }
  if (noAccounts && state.accountsStatus === "ready") {
    return (
      <EmptyState
        icon={<img className="oui-empty__artwork" src={appArtwork} alt="" width={80} height={80} draggable={false} />}
        headline="Connect a calendar"
        description="Connect Google Calendar in Settings, Integrations. Your events appear here, and invites go out only after you confirm."
        action={{ label: "Check again", onClick: () => void store.loadAccounts() }}
      />
    );
  }
  if (noAccounts) {
    return <div className="cal-skeleton" aria-busy="true" aria-label="Loading calendar"><Skeleton lines={10} height={18} /></div>;
  }

  const view = state.range.view;
  const onCreateAllDay = (day: string) => store.openAllDayDraft(day);
  return (
    <div className="cal-view" aria-busy={state.eventsStatus === "loading" || undefined}>
      {view === "month" && (
        <MonthView state={state} calendarsById={calendarsById} onOpenEvent={props.onOpenEvent} onCreateAllDay={onCreateAllDay} onPickDay={props.onPickDay} />
      )}
      {view === "agenda" && <AgendaView state={state} calendarsById={calendarsById} onOpenEvent={props.onOpenEvent} onNewEvent={props.onNewEvent} />}
      {view !== "month" && view !== "agenda" && (
        <TimeGrid
          state={state}
          now={props.now}
          calendarsById={calendarsById}
          isEditable={props.isEditable}
          onCreate={props.onCreate}
          onCreateAllDay={onCreateAllDay}
          onOpenEvent={props.onOpenEvent}
          onChangeTime={props.onChangeTime}
          onProposal={props.onProposal}
          onPickDay={props.onPickDay}
          marker={props.marker}
        />
      )}
      {state.eventsStatus === "loading" && state.events.length === 0 && (
        <div className="cal-view__loading" aria-hidden="true"><Skeleton lines={6} height={16} /></div>
      )}
    </div>
  );
}
