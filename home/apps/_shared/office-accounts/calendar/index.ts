/**
 * Calendar provider adapters. The Calendar app and the agent's calendar tools
 * use `CalendarProvider` from `../types/calendar` and get one from here.
 */
export { createGoogleCalendarProvider } from "./google-provider.js";
export type { CalendarProviderOptions } from "./google-provider.js";
