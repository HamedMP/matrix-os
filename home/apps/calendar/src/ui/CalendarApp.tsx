/**
 * The Calendar app: toolbar, calendars rail, the active view, the event
 * popover, the composer or agent panel, and the confirmations that guard
 * anything that notifies other people.
 */
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { AppFrame } from "../../../_shared/office-ui";
import { instantToMs, type EventResponse } from "../../../_shared/office-accounts/types/calendar";
import { dayKeyAt, defaultCalendar, type CalendarStore } from "../model";
import { AgentSlot } from "./AgentSlot";
import type { AgentHighlight, AgentSlotPanelProps } from "./agentSlotTypes";
import { CalendarMain } from "./CalendarMain";
import { CalendarRail } from "./CalendarRail";
import { CalendarToolbar } from "./CalendarToolbar";
import { calendarIndex } from "./colors";
import { ConfirmGuestChange } from "./ConfirmGuestChange";
import { canEdit } from "./eventActions";
import { EventComposer } from "./EventComposer";
import { EventPopover } from "./EventPopover";
import { formatZoneShort, wallInputValue } from "./format";
import { isEditableTarget, keyCommand } from "./gridMath";
import { useCalendarState, useNow } from "./hooks";
import { statusBanners } from "./StatusBanners";
import { useEventChanges } from "./useEventChanges";

export interface CalendarAppProps {
  store: CalendarStore;
  /** Clock for the current-time line; tests pass a fixed one. */
  now?: () => number;
  /** Provider free-busy for the agent panel, so its lookups do not repaint the grid's overlays. */
  getFreeBusy?: AgentSlotPanelProps["getFreeBusy"];
}

/** The element drawn for an event or proposal id, if it is on screen. */
function findDrawn(id: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>("[data-event-id], [data-proposal-id]")]
    .find((item) => item.dataset.eventId === id || item.dataset.proposalId === id);
}

export function CalendarApp({ store, now = Date.now, getFreeBusy }: CalendarAppProps) {
  const state = useCalendarState(store);
  const currentTime = useNow(now);
  const calendarsById = useMemo(() => calendarIndex(state.calendars), [state.calendars]);
  const pendingIds = useMemo(() => new Set(state.pendingEventIds), [state.pendingEventIds]);
  const popoverAnchor = useRef<HTMLElement | null>(null);
  const highlightRef = useRef<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const changes = useEventChanges(store, state);
  const selected = selectedId ? state.events.find((event) => event.id === selectedId) ?? null : null;

  function isEditable(eventId: string): boolean {
    const event = state.events.find((item) => item.id === eventId);
    return Boolean(event && canEdit(event, calendarsById[event.calendarId], state.pendingEventIds));
  }

  function openNew() {
    setSelectedId(null);
    store.openNewDraft();
  }

  /** Escape closes the topmost side panel: the composer (discarding it, like Cancel), then the agent panel. */
  function closeTopPanel(): boolean {
    if (state.draft) {
      if (state.draft.status === "saving") return false;
      store.closeDraft();
      return true;
    }
    if (!agentOpen) return false;
    setAgentOpen(false);
    return true;
  }

  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (event.target instanceof Element && event.target.closest("[role='dialog'], [role='alertdialog']")) return;
    if (event.key === "Escape") {
      if (closeTopPanel()) event.preventDefault();
      return;
    }
    if (isEditableTarget(event.target)) return;
    const command = keyCommand({ key: event.key, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
    if (!command) return;
    event.preventDefault();
    if (command.type === "today") store.goToToday();
    else if (command.type === "shift") store.shift(command.steps);
    else if (command.type === "view") store.setView(command.view);
    else openNew();
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onShortcut(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // A time chip in the agent panel: go to its day, then focus the event or proposal once it is drawn.
  function highlight(target: AgentHighlight) {
    highlightRef.current = target.id;
    store.goToDate(dayKeyAt(instantToMs(target.start), state.timeZone));
  }

  useEffect(() => {
    const id = highlightRef.current;
    const element = id ? findDrawn(id) : undefined;
    if (!element) return;
    highlightRef.current = null;
    element.focus();
  }, [state.events, state.proposals, state.range]);

  function openEvent(eventId: string, anchor: HTMLElement) {
    popoverAnchor.current = anchor;
    setSelectedId(eventId);
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

  // The agent panel stays mounted (hidden) while the composer covers it, so
  // its answers are still there to pick another time from after Cancel.
  const rightPanel = state.draft || agentOpen
    ? (
      <>
        {state.draft && <EventComposer store={store} state={state} draftState={state.draft} onApplyProposal={onProposal} />}
        {agentOpen && (
          <div className="cal-agent-holder" hidden={Boolean(state.draft)}>
            <AgentSlot store={store} now={now} getFreeBusy={getFreeBusy} onHighlight={highlight} onClose={() => setAgentOpen(false)} />
          </div>
        )}
      </>
    )
    : undefined;
  const pendingCount = state.pendingEventIds.length;

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
            canCreate={defaultCalendar(state.calendars) !== null}
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
            {pendingCount > 0 && <span role="status">Saving {pendingCount} {pendingCount === 1 ? "change" : "changes"}…</span>}
            {state.proposals.some((proposal) => proposal.source === "agent") && <span>Agent proposals on the grid</span>}
          </>
        )}
      >
        <CalendarMain
          store={store}
          state={state}
          now={currentTime}
          calendarsById={calendarsById}
          isEditable={isEditable}
          onOpenEvent={openEvent}
          onCreate={(day, start, end) => {
            setSelectedId(null);
            store.openDraftForGrid(day, start, end);
          }}
          onChangeTime={changes.changeTime}
          onProposal={onProposal}
          onPickDay={pickDay}
          onNewEvent={openNew}
        />
      </AppFrame>
      {selected && (
        <EventPopover
          event={selected}
          calendar={calendarsById[selected.calendarId]}
          timeZone={state.timeZone}
          anchorRef={popoverAnchor}
          editable={isEditable(selected.id)}
          pending={pendingIds.has(selected.id)}
          onClose={() => setSelectedId(null)}
          onEdit={() => {
            setSelectedId(null);
            store.openEditDraft(selected.id);
          }}
          onDelete={() => {
            setSelectedId(null);
            changes.remove(selected.id);
          }}
          onRespond={respond}
        />
      )}
      <ConfirmGuestChange change={changes.pending} onNotify={() => changes.finish(true)} onSilent={() => changes.finish(false)} onCancel={changes.cancel} />
    </>
  );
}
