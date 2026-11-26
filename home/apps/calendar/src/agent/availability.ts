/**
 * Reading availability for the agent: who is meant, when they are busy, and
 * which slots are free. Read-only; it calls `listEvents` and `getFreeBusy` only.
 */
import { isValidMailAddress } from "../../../_shared/office-accounts/types/addresses";
import {
  MAX_EVENT_ATTENDEES,
  MAX_EVENT_RANGE_DAYS,
  instantToMs,
  type BusyBlock,
  type CalendarEvent,
} from "../../../_shared/office-accounts/types/calendar";
import { MINUTES_PER_DAY, MS_PER_MINUTE, addDays, compareDayKeys, dayKeyAt, weekdayOf, zonedInstant } from "../model/dates";
import { findSlots, unknownAvailability } from "../model/slots";
import { slotRef } from "./describe";
import type { PeopleEntry } from "./prompt";
import { MAX_WINDOW_DAYS, instantOnDay } from "./relative-dates";
import type { CalendarAgentContext, CalendarAgentDeps, PeopleRef, ResolvedWindow, SlotRef } from "./types";

export interface ResolvedPeople {
  /** Lower-cased, valid, unique, without the owner; at most `MAX_EVENT_ATTENDEES` (the app reads them in batches). */
  addresses: string[];
  /** Names that matched nobody or more than one person. Plain text. */
  unresolved: string[];
  /** How many valid people were left out because an event holds at most `MAX_EVENT_ATTENDEES`. */
  leftOut: number;
}

/** Unique addresses without the owner, at most `MAX_EVENT_ATTENDEES`, and how many more there were. */
export function cappedAddresses(addresses: Iterable<string>, owner: string | null): { addresses: string[]; leftOut: number } {
  const unique = new Set<string>();
  for (const address of addresses) if (address !== owner) unique.add(address);
  const all = [...unique];
  return { addresses: all.slice(0, MAX_EVENT_ATTENDEES), leftOut: Math.max(0, all.length - MAX_EVENT_ATTENDEES) };
}

/**
 * Turns the people a request named into addresses. An address is used as is
 * when valid; a name must match exactly one known person (by full name, first
 * name or the part of the address before `@`). `attendeesFromEvent` adds that
 * event's attendees.
 */
export function resolvePeople(
  ref: PeopleRef,
  context: CalendarAgentContext,
  people: readonly PeopleEntry[],
  aliases: Readonly<Record<string, string>>,
): ResolvedPeople {
  const owner = context.ownerAddress?.toLowerCase() ?? null;
  const found: string[] = [];
  const unresolved: string[] = [];
  if (ref.attendeesFromEvent) {
    const id = aliases[ref.attendeesFromEvent];
    const event = context.events.find((item) => item.id === id);
    for (const attendee of event?.attendees ?? []) {
      const address = attendee.address.trim().toLowerCase();
      if (isValidMailAddress(address)) found.push(address);
    }
  }
  for (const raw of ref.attendees) {
    const text = raw.trim().toLowerCase();
    if (isValidMailAddress(text)) {
      found.push(text);
      continue;
    }
    if (["me", "i", "myself", "us", "we", "everyone", "all"].includes(text)) continue;
    const matches = people.filter((person) => {
      const name = person.name.toLowerCase();
      return name === text || name.split(" ")[0] === text || person.address.split("@")[0] === text;
    });
    if (matches.length === 1) found.push(matches[0].address);
    else unresolved.push(raw.slice(0, 60));
  }
  return { ...cappedAddresses(found, owner), unresolved };
}

/** The owner's timed events as busy time; declined events, all-day events and `excludeEventId` do not block. */
export function ownerBusyBlocks(events: readonly CalendarEvent[], owner: string | null, excludeEventId?: string): BusyBlock[] {
  return events
    .filter((event) => !event.allDay && event.myResponse !== "declined" && event.id !== excludeEventId)
    .map((event) => ({
      address: owner ?? "me",
      start: event.start,
      end: event.end,
      status: event.myResponse === "tentative" ? "tentative" as const : "busy" as const,
    }));
}

export interface AvailabilityResult {
  slots: SlotRef[];
  events: CalendarEvent[];
  notes: string[];
  /** True when the owner's own calendar could not be read; slots are then empty. */
  failed: boolean;
}

export interface AvailabilityRequest {
  addresses: readonly string[];
  window: ResolvedWindow;
  durationMinutes: number;
  count: number;
  /** An event that should not count as busy (the one being moved). */
  excludeEventId?: string;
}

interface BusyRead {
  busy: BusyBlock[];
  events: CalendarEvent[];
  notes: string[];
}

/** The owner's busy time and that of `addresses` in `[start, end)`; null when the owner's calendar cannot be read. */
async function readBusy(
  addresses: readonly string[],
  start: string,
  end: string,
  context: CalendarAgentContext,
  deps: CalendarAgentDeps,
  excludeEventId?: string,
): Promise<BusyRead | null> {
  let events: CalendarEvent[];
  try {
    events = await deps.listEvents(start, end);
  } catch (error: unknown) {
    deps.log?.("agent: list events", error);
    return null;
  }
  const notes: string[] = [];
  const busy = ownerBusyBlocks(events, context.ownerAddress, excludeEventId);
  if (addresses.length > 0) {
    let blocks: BusyBlock[];
    try {
      blocks = await deps.getFreeBusy([...addresses], start, end);
    } catch (error: unknown) {
      deps.log?.("agent: free-busy", error);
      blocks = addresses.map((address) => ({ address, start, end, status: "unknown" as const }));
    }
    const unknown = unknownAvailability(blocks);
    if (unknown.length > 0) notes.push(`Availability is unknown for ${unknown.join(", ")}, so their time counts as busy.`);
    busy.push(...blocks);
  }
  return { busy, events, notes };
}

const READ_FAILED: AvailabilityResult = { slots: [], events: [], notes: ["Could not read your calendar. Try again."], failed: true };

/**
 * Free slots for the owner and `addresses` inside working hours in `window`.
 * People whose availability cannot be read count as busy for the whole window
 * (unknown is never free), and a note says so.
 */
export async function searchAvailability(
  request: AvailabilityRequest,
  context: CalendarAgentContext,
  deps: CalendarAgentDeps,
): Promise<AvailabilityResult> {
  const read = await readBusy(request.addresses, request.window.start, request.window.end, context, deps, request.excludeEventId);
  if (!read) return { ...READ_FAILED, notes: [...READ_FAILED.notes] };
  const slots = findSlots({
    busy: read.busy,
    rangeStart: request.window.start,
    rangeEnd: request.window.end,
    durationMinutes: request.durationMinutes,
    timeZone: context.timeZone,
    workingHours: context.workingHours,
    maxResults: request.count,
    notBefore: context.now,
    distinct: true,
  }).map((slot) => slotRef(slot.start, slot.end));
  return { slots, events: read.events, notes: read.notes, failed: false };
}

export interface StartsAtTimeOptions {
  /** How long the meeting lasts; a start whose end falls after `window.end` is left out. Default 0. */
  lengthMs?: number;
  /** A start that is not a new time (the time an event already has); left out. */
  skipStartMs?: number;
}

/**
 * Epoch-ms starts at exactly `minuteOfDay` on each day of `window` from now on,
 * earliest first: the working days, or every day when the window holds none.
 * Each start, and its end `lengthMs` later, lies inside the window.
 */
export function startsAtTime(window: ResolvedWindow, minuteOfDay: number, context: CalendarAgentContext, options: StartsAtTimeOptions = {}): number[] {
  const lengthMs = Math.max(0, options.lengthMs ?? 0);
  const startMs = instantToMs(window.start);
  const endMs = instantToMs(window.end);
  const floorMs = Math.max(startMs, context.now);
  const days: string[] = [];
  const last = dayKeyAt(endMs - 1, context.timeZone);
  for (let day = dayKeyAt(startMs, context.timeZone), guard = 0; guard <= MAX_WINDOW_DAYS && compareDayKeys(day, last) <= 0; day = addDays(day, 1), guard += 1) {
    days.push(day);
  }
  const workDays = new Set(context.workingHours.days);
  const working = days.filter((day) => workDays.has(weekdayOf(day)));
  const starts = (working.length > 0 ? working : days)
    .map((day) => instantToMs(instantOnDay(day, minuteOfDay, context)))
    .filter((ms) => ms >= floorMs && ms < endMs && ms + lengthMs <= endMs && ms !== options.skipStartMs);
  return [...new Set(starts)].sort((a, b) => a - b);
}

function overlapsBusy(startMs: number, endMs: number, busy: readonly BusyBlock[]): boolean {
  return busy.some((block) => {
    let blockStart: number;
    let blockEnd: number;
    try {
      blockStart = instantToMs(block.start);
      blockEnd = instantToMs(block.end);
    } catch (error: unknown) {
      if (error instanceof RangeError) return false;
      throw error;
    }
    return blockEnd > blockStart && blockStart < endMs && blockEnd > startMs;
  });
}

export interface AtTimeRequest {
  addresses: readonly string[];
  window: ResolvedWindow;
  /** Wall-clock minute of the day, in the owner's zone. */
  minuteOfDay: number;
  lengthMs: number;
  count: number;
  excludeEventId?: string;
  /** A start that is not a new time (the moved event's current one). */
  skipStartMs?: number;
}

/**
 * Times at exactly `minuteOfDay` (see `startsAtTime`) when the owner and
 * `addresses` are free for `lengthMs`; never another time of day. Every
 * meeting starts and ends inside `request.window`. Busy, tentative and unknown
 * time all block, and a time whose end falls past what one read can cover is
 * left out rather than guessed.
 */
export async function searchAtTime(request: AtTimeRequest, context: CalendarAgentContext, deps: CalendarAgentDeps): Promise<AvailabilityResult> {
  const starts = startsAtTime(request.window, request.minuteOfDay, context, { lengthMs: request.lengthMs, skipStartMs: request.skipStartMs });
  if (starts.length === 0) return { slots: [], events: [], notes: [], failed: false };
  const readStart = starts[0];
  const readEnd = Math.min(starts[starts.length - 1] + Math.max(request.lengthMs, MS_PER_MINUTE), readStart + MAX_EVENT_RANGE_DAYS * MINUTES_PER_DAY * MS_PER_MINUTE);
  const read = await readBusy(request.addresses, zonedInstant(readStart, context.timeZone), zonedInstant(readEnd, context.timeZone), context, deps, request.excludeEventId);
  if (!read) return { ...READ_FAILED, notes: [...READ_FAILED.notes] };
  const slots: SlotRef[] = [];
  for (const startMs of starts) {
    const endMs = startMs + request.lengthMs;
    if (Math.max(endMs, startMs + MS_PER_MINUTE) > readEnd || overlapsBusy(startMs, endMs, read.busy)) continue;
    slots.push(slotRef(zonedInstant(startMs, context.timeZone), zonedInstant(endMs, context.timeZone)));
    if (slots.length >= request.count) break;
  }
  return { slots, events: read.events, notes: read.notes, failed: false };
}
