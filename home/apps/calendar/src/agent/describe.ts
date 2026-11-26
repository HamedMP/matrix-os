/**
 * Plain sentences and labels for agent answers, written by code from the
 * structured result (never copied from the model's reply).
 */
import { allDayDate, instantToMs, type CalendarEvent, type IsoInstant } from "../../../_shared/office-accounts/types/calendar";
import { dayKeyAt, diffDays } from "../model/dates";
import type { EventRef, ResolvedWindow, SlotRef } from "./types";

function format(timeZone: string, options: Intl.DateTimeFormatOptions, ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, ...options }).format(new Date(ms));
}

const DAY: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" };
const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

/** "Tue 24 Nov". */
export function dayLabel(instant: IsoInstant, timeZone: string): string {
  return format(timeZone, DAY, instantToMs(instant));
}

/** "Tue 24 Nov 10:00–11:00"; the end shows its own day when it falls on another one. */
export function rangeLabel(start: IsoInstant, end: IsoInstant, timeZone: string): string {
  const startMs = instantToMs(start);
  const endMs = instantToMs(end);
  const sameDay = dayKeyAt(startMs, timeZone) === dayKeyAt(endMs - 1, timeZone);
  const endText = sameDay ? format(timeZone, CLOCK, endMs) : `${format(timeZone, DAY, endMs)} ${format(timeZone, CLOCK, endMs)}`;
  return `${format(timeZone, DAY, startMs)} ${format(timeZone, CLOCK, startMs)}–${endText}`;
}

/** Label for an event chip; all-day events show their dates only, never shifted into the zone. */
export function eventLabel(event: EventRef, timeZone: string): string {
  if (!event.allDay) return rangeLabel(event.start, event.end, timeZone);
  const first = allDayDate(event.start);
  const days = diffDays(first, allDayDate(event.end));
  const firstText = format("UTC", DAY, Date.parse(`${first}T00:00:00Z`));
  return days > 1 ? `${firstText}, ${days} days` : `${firstText}, all day`;
}

export function slotLabel(slot: SlotRef, timeZone: string): string {
  return rangeLabel(slot.start, slot.end, timeZone);
}

/** "Mon 23 Nov – Sun 29 Nov", or one day. */
export function windowLabel(window: ResolvedWindow, timeZone: string): string {
  const startMs = instantToMs(window.start);
  const lastMs = instantToMs(window.end) - 1;
  const first = format(timeZone, DAY, startMs);
  const last = format(timeZone, DAY, lastMs);
  return first === last ? first : `${first} – ${last}`;
}

export function durationLabel(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
  if (minutes > 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `${minutes} min`;
}

export function eventRef(event: CalendarEvent): EventRef {
  return { id: event.id, title: event.title, start: event.start, end: event.end, allDay: event.allDay };
}

export function slotRef(start: IsoInstant, end: IsoInstant): SlotRef {
  return { id: `slot-${instantToMs(start)}-${instantToMs(end)}`, start, end };
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
