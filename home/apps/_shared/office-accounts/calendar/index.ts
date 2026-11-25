/**
 * Calendar provider adapters. The Calendar app and the agent's calendar tools
 * use `CalendarProvider` from `../types/calendar` and get one from here:
 *
 *   const accounts = await listCalendarAccounts();
 *   const provider = createCalendarProvider(accounts[0]);
 */
export { createGoogleCalendarProvider } from "./google-provider.js";
export { createCalendarProvider, defaultCalendarBridge, listCalendarAccounts, MAX_CALENDAR_ACCOUNTS } from "./accounts.js";
export type { CalendarAccountsBridge, ConnectedCalendarAccount } from "./accounts.js";
export type { CalendarProviderOptions, CalendarServiceBridge } from "./service.js";
export { mergeBusyIntervals } from "./busy.js";
export type { BusyInterval } from "./busy.js";
export { htmlToText, descriptionToText } from "./description.js";
export { ianaZone } from "./zones.js";
