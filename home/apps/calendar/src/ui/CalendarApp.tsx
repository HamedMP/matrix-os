/**
 * The Calendar app: toolbar, calendars rail, the active view, the event
 * popover, the composer or agent panel, and the confirmations that guard
 * anything that notifies other people.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { AppFrame, EmptyState, Skeleton } from "../../../_shared/office-ui";
import { instantToMs, type EventChanges, type EventResponse } from "../../../_shared/office-accounts/types/calendar";
import { defaultCalendar, type CalendarStore } from "../model";
import { AgendaView } from "./AgendaView";
import { AgentSlot } from "./AgentSlot";
import { CalendarRail } from "./CalendarRail";
import { CalendarToolbar } from "./CalendarToolbar";
import { calendarIndex } from "./colors";
import { ConfirmGuestChange, type GuestChange } from "./ConfirmGuestChange";
import { canEdit, guestAddresses, ownerAddressFor, timeChanges } from "./eventActions";
import { EventComposer } from "./EventComposer";
import { EventPopover } from "./EventPopover";
import { formatZoneShort, wallInputValue } from "./format";
import { isEditableTarget, keyCommand } from "./gridMath";
import { useCalendarState, useNow } from "./hooks";
import { MonthView } from "./MonthView";
import { statusBanners } from "./StatusBanners";
import { TimeGrid } from "./TimeGrid";

export interface CalendarAppProps {
  store: CalendarStore;
  /** Clock for the current-time line; tests pass a fixed one. */
  now?: () => number;
}

type PendingGuestChange = GuestChange & { eventId: string; changes: EventChanges | null };

export function CalendarApp({ store, now = Date.now }: CalendarAppProps) {
  const state = useCalendarState(store);
  const currentTime = useNow(now);
  const calendarsById = useMemo(() => calendarIndex(state.calendars), [state.calendars]);
  const popoverAnchor = useRef<HTMLElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [guestChange, setGuestChange] = useState<PendingGuestChange | null>(null);
  const selected = selectedId ? state.events.find((event) => event.id === selectedId) ?? null : null;
  const canCreate = defaultCalendar(state.calendars) !== null;

  const isEditable = useCallback((eventId: string) => {
    const event = state.events.find((item) => item.id === eventId);
    return Boolean(event && canEdit(event, calendarsById[event.calendarId], state.pendingEventIds));
  }, [state.events, state.pendingEventIds, calendarsById]);

  const openNew = useCallback(() => {
    setSelectedId(null);
    store.openNewDraft();
  }, [store]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      if (event.target instanceof Element && event.target.closest("[role='dialog'], [role='alertdialog']")) return;
      const command = keyCommand({ key: event.key, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
      if (!command) return;
      event.preventDefault();
      if (command.type === "today") store.goToToday();
      else if (command.type === "shift") store.shift(command.steps);
      else if (command.type === "view") store.setView(command.view);
      else openNew();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store, openNew]);

  function openEvent(eventId: string, anchor: HTMLElement) {
    popoverAnchor.current = anchor;
    setSelectedId(eventId);
  }

  function guestsOf(eventId: string): { title: string; recipients: string[] } | null {
    const event = state.events.find((item) => item.id === eventId);
    if (!event) return null;
    return { title: event.title, recipients: guestAddresses(event, ownerAddressFor(event, state.calendars, state.accounts)) };
  }

  function changeTime(eventId: string, startMs: number, endMs: number) {
    const event = state.events.find((item) => item.id === eventId);
    if (!event || (startMs === instantToMs(event.start) && endMs === instantToMs(event.end))) return;
    const changes = timeChanges(event, startMs, endMs);
    const guests = guestsOf(eventId);
    if (guests && guests.recipients.length > 0) {
      setGuestChange({ kind: "move", eventId, changes, eventTitle: guests.title, recipients: guests.recipients });
      return;
    }
    void store.updateEvent(eventId, changes, { sendInvites: false });
  }

  function deleteSelected() {
    if (!selected) return;
    const guests = guestsOf(selected.id);
    setSelectedId(null);
    if (guests && guests.recipients.length > 0) {
      setGuestChange({ kind: "delete", eventId: selected.id, changes: null, eventTitle: guests.title, recipients: guests.recipients });
      return;
    }
    void store.deleteEvent(selected.id, { sendInvites: false });
  }

  function finishGuestChange(sendInvites: boolean) {
    const change = guestChange;
    setGuestChange(null);
    if (!change) return;
    if (change.kind === "delete") void store.deleteEvent(change.eventId, { sendInvites });
    else if (change.changes) void store.updateEvent(change.eventId, change.changes, { sendInvites });
  }

  function onProposal(proposalId: string) {
    const proposal = state.proposals.find((item) => item.id === proposalId);
    if (!proposal) return;
    if (state.draft) {
      const zone = state.draft.draft.allDay ? state.timeZone : state.draft.draft.timeZone;
      store.setDraftTimes(wallInputValue(proposal.start, zone), wallInputValue(proposal.end, zone), zone);
      return;
    }
    setSelectedId(null);
    store.openDraftFromProposal(proposalId);
  }

  function pickDay(day: string) {
    store.goToDate(day);
    store.setView("day");
  }

  function respond(response: EventResponse) {
    if (selected) void store.respond(selected.id, response);
  }

  const view = state.range.view;
  const noAccounts = state.accountsStatus === "ready" && state.accounts.length === 0;
  const accountsFailed = state.accountsStatus === "error" && state.accounts.length === 0;
  const starting = (state.accountsStatus === "idle" || state.accountsStatus === "loading") && state.accounts.length === 0;

  let main;
  if (accountsFailed) {
    main = (
      <EmptyState
        icon={<CalendarDays />}
        headline="Calendars could not be loaded"
        description={state.accountsError ?? "Something went wrong. Try again."}
        action={{ label: "Try again", onClick: () => void store.loadAccounts() }}
      />
    );
  } else if (noAccounts) {
    main = (
      <EmptyState
        icon={<CalendarDays />}
        headline="Connect a calendar"
        description="Connect Google Calendar or Outlook in Settings, Integrations. Your events appear here, and invites go out only after you confirm."
        action={{ label: "Check again", onClick: () => void store.loadAccounts() }}
      />
    );
  } else if (starting) {
    main = <div className="cal-skeleton" aria-busy="true" aria-label="Loading calendar"><Skeleton lines={10} height={18} /></div>;
  } else {
    const common = { state, calendarsById, onOpenEvent: openEvent };
    main = (
      <div className="cal-view" aria-busy={state.eventsStatus === "loading" || undefined}>
        {view === "month" && <MonthView {...common} onCreateAllDay={(day) => store.openAllDayDraft(day)} onPickDay={pickDay} />}
        {view === "agenda" && <AgendaView {...common} onNewEvent={openNew} />}
        {view !== "month" && view !== "agenda" && (
          <TimeGrid
            {...common}
            now={currentTime}
            isEditable={isEditable}
            onCreate={(day, start, end) => {
              setSelectedId(null);
              store.openDraftForGrid(day, start, end);
            }}
            onCreateAllDay={(day) => store.openAllDayDraft(day)}
            onChangeTime={changeTime}
            onProposal={onProposal}
            onPickDay={pickDay}
          />
        )}
        {state.eventsStatus === "loading" && state.events.length === 0 && (
          <div className="cal-view__loading" aria-hidden="true"><Skeleton lines={6} height={16} /></div>
        )}
      </div>
    );
  }

  const rightPanel = state.draft
    ? <EventComposer store={store} state={state} draftState={state.draft} onApplyProposal={onProposal} />
    : agentOpen
      ? <AgentSlot store={store} state={state} onClose={() => setAgentOpen(false)} />
      : undefined;

  return (
    <>
      <AppFrame
        className="cal-app"
        title="Calendar"
        titleIcon={<CalendarDays size={18} />}
        toolbar={(
          <CalendarToolbar
            range={state.range}
            loading={state.eventsStatus === "loading"}
            agentOpen={agentOpen}
            canCreate={canCreate}
            onToday={() => store.goToToday()}
            onShift={(steps) => store.shift(steps)}
            onView={(next) => store.setView(next)}
            onNew={openNew}
            onRefresh={() => void store.refresh()}
            onToggleAgent={() => setAgentOpen((open) => !open)}
          />
        )}
        banner={statusBanners({
          state,
          onRetryEvents: () => void store.loadEvents({ force: true }),
          onRetryAccounts: () => void store.loadAccounts(),
          onDismissMutation: () => store.clearMutationError(),
        })}
        leftRail={<CalendarRail state={state} onPickDay={(day) => store.goToDate(day)} onToggle={(id, visible) => store.setCalendarVisible(id, visible)} />}
        leftRailLabel="Calendars"
        rightPanel={rightPanel}
        rightPanelLabel={state.draft ? "Event composer" : "Agent"}
        statusBar={(
          <>
            <span>Time zone: {state.timeZone} ({formatZoneShort(state.timeZone, currentTime)})</span>
            {state.pendingEventIds.length > 0 && <span role="status">Saving {state.pendingEventIds.length} {state.pendingEventIds.length === 1 ? "change" : "changes"}…</span>}
            {state.proposals.some((proposal) => proposal.source === "agent") && <span>Agent proposals on the grid</span>}
          </>
        )}
      >
        {main}
      </AppFrame>
      {selected && (
        <EventPopover
          event={selected}
          calendar={calendarsById[selected.calendarId]}
          timeZone={state.timeZone}
          anchorRef={popoverAnchor}
          editable={isEditable(selected.id)}
          pending={state.pendingEventIds.includes(selected.id)}
          onClose={() => setSelectedId(null)}
          onEdit={() => {
            setSelectedId(null);
            store.openEditDraft(selected.id);
          }}
          onDelete={deleteSelected}
          onRespond={respond}
        />
      )}
      <ConfirmGuestChange change={guestChange} onNotify={() => finishGuestChange(true)} onSilent={() => finishGuestChange(false)} onCancel={() => setGuestChange(null)} />
    </>
  );
}
