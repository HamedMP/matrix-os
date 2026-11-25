/**
 * Calendar app model: everything the UI needs, with no React in it.
 *
 * Start here
 * ----------
 *   const store = createCalendarStore({
 *     connect: async () => [{ account, provider }],          // one CalendarProvider per account
 *     persistence: createDbPersistence(window.MatrixOS.db),  // tables declared in matrix.json
 *   });
 *   await store.init();
 *   const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
 *
 * State (`CalendarState`, serialisable, no Map/Set): `range` (the view's days
 * and instants), `calendars` (effective `visible`), `events` (visible
 * calendars, current range), `eventsStatus`/`eventsError`, `pendingEventIds`
 * (unconfirmed writes), `mutationError`, `draft`, `assistant` (attendees,
 * busy blocks, `overlays` per day) and `proposals`. Error fields only ever
 * hold fixed sentences, never provider text.
 *
 * Drawing a view from the state
 * -----------------------------
 * - Time grid (day, work week, week):
 *     const days = daySlices(state.range.days, state.timeZone);
 *     layoutTimedGrid(state.events, days, state.timeZone)   // columns per day
 *     layoutBars(state.events, state.range.days, state.timeZone) // all-day / multi-day row
 *     proposalSegments(state.proposals, days, state.timeZone)    // highlighted candidates
 *     state.assistant.overlays[dayKey]                           // attendees' busy bands
 *   Minutes are wall-clock minutes in the day (0 to 1440); a day can be 23 or
 *   25 hours long (`DaySlice.lengthMinutes`).
 * - Month: `buildMonthGrid(state.range, state.events, { timeZone, today: state.today })`
 *   gives weeks, bars in visible rows and "+N more" counts per cell.
 * - Agenda: `groupAgenda(state.events, state.range.days, state.timeZone)`.
 *
 * Owner actions
 * -------------
 * Navigation: `setView`, `shift(±1)`, `goToDate`, `goToToday`, `setPreferences`.
 * Calendars: `setCalendarVisible(id, visible)` (remembered across sessions).
 * Drafts: `openDraftForGrid`, `openAllDayDraft`, `openNewDraft`, `openEditDraft`,
 * `openDraftFromProposal`, then `patchDraft`, `setDraftTimes`, `setDraftAllDay`,
 * `addDraftAttendee`, `removeDraftAttendee`, `setDraftOnlineMeeting`,
 * `setDraftRecurrence`, `setDraftReminders`, `closeDraft`.
 * Writes (optimistic, rolled back on failure): `saveDraft({ sendInvites })`,
 * `updateEvent`, `moveEvent`, `deleteEvent`, `respond`. Call them only from an
 * explicit click; `sendInvites` must be what the owner confirmed.
 * Assistant: `setAssistantAttendees`, `setAssistantDuration`, `loadBusy`,
 * `findSlots` (adds "assistant" proposals). Read-only lookups for any window,
 * without moving the grid: `readEvents`, `readFreeBusy`. Agent proposals: `receiveProposals`,
 * `loadAgentProposals` (rows of the `calendar_proposals` table),
 * `dismissProposal`, `clearProposals`.
 *
 * Untrusted text: event titles, descriptions, locations, names and proposal
 * titles and notes come from other people or the agent. Render them as text.
 */
export * from "./dates";
export * from "./ranges";
export * from "./layout";
export * from "./month";
export * from "./agenda";
export * from "./slots";
export * from "./proposals";
export * from "./drafts";
export * from "./cache";
export * from "./preferences";
export * from "./store-state";
export { createScheduleActions, defaultCalendar, normalizeAttendeeAddresses, ownerBusy, NO_CALENDAR_MESSAGE } from "./store-schedule";
export type { FindSlotsRequest, ScheduleActions } from "./store-schedule";
export { NOT_FOUND_MESSAGE, READ_ONLY_MESSAGE } from "./store-writes";
export type { WriteActions } from "./store-writes";
export { createCalendarStore, MAX_SUBSCRIBERS } from "./store";
export type { CalendarStore, CalendarStoreOptions, PreferenceChanges } from "./store";
