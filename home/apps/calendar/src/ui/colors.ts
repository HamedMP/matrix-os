/**
 * Colours. Calendar colours come from the provider (data, validated here);
 * everything else uses theme tokens through CSS classes in styles.css.
 */
import type { CSSProperties } from "react";
import type { CalendarInfo } from "../../../_shared/office-accounts/types/calendar";

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Distinct overlay colours for attendees' busy time (classes `cal-person-0` and up). */
export const PERSON_COLOR_COUNT = 6;

/** The calendar's colour when it is a plain hex value, else the accent token. */
export function safeColor(color: string | undefined): string {
  return color && HEX.test(color) ? color : "var(--cal-accent)";
}

/** Inline custom property for an event block or swatch. */
export function calendarColorStyle(calendar: Pick<CalendarInfo, "color"> | undefined): CSSProperties {
  return { "--event-color": safeColor(calendar?.color) } as CSSProperties;
}

/** The overlay colour class for the attendee at `index` in the assistant's list. */
export function personColorClass(index: number): string {
  const slot = ((index % PERSON_COLOR_COUNT) + PERSON_COLOR_COUNT) % PERSON_COLOR_COUNT;
  return `cal-person-${slot}`;
}

/** Calendars indexed by id, for event colouring. */
export function calendarIndex(calendars: readonly CalendarInfo[]): Record<string, CalendarInfo> {
  const result: Record<string, CalendarInfo> = {};
  for (const calendar of calendars) result[calendar.id] = calendar;
  return result;
}
