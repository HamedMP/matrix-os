/**
 * Reading availability for the agent: who is meant, when they are busy, and
 * which slots are free. Read-only; it calls `listEvents` and `getFreeBusy` only.
 */
import { isValidMailAddress } from "../../../_shared/office-accounts/types/addresses";
import {
  MAX_EVENT_ATTENDEES,
  type BusyBlock,
  type CalendarEvent,
} from "../../../_shared/office-accounts/types/calendar";
import { findSlots, unknownAvailability } from "../model/slots";
import { slotRef } from "./describe";
import type { PeopleEntry } from "./prompt";
import type { CalendarAgentContext, CalendarAgentDeps, PeopleRef, ResolvedWindow, SlotRef } from "./types";

export interface ResolvedPeople {
  /** Lower-cased, valid, unique, without the owner; at most `MAX_EVENT_ATTENDEES` (the app reads them in batches). */
  addresses: string[];
  /** Names that matched nobody or more than one person. Plain text. */
  unresolved: string[];
}

function addUnique(list: string[], address: string, owner: string | null): void {
  if (address !== owner && !list.includes(address) && list.length < MAX_EVENT_ATTENDEES) list.push(address);
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
  const addresses: string[] = [];
  const unresolved: string[] = [];
  if (ref.attendeesFromEvent) {
    const id = aliases[ref.attendeesFromEvent];
    const event = context.events.find((item) => item.id === id);
    for (const attendee of event?.attendees ?? []) {
      const address = attendee.address.trim().toLowerCase();
      if (isValidMailAddress(address)) addUnique(addresses, address, owner);
    }
  }
  for (const raw of ref.attendees) {
    const text = raw.trim().toLowerCase();
    if (isValidMailAddress(text)) {
      addUnique(addresses, text, owner);
      continue;
    }
    if (["me", "i", "myself", "us", "we", "everyone", "all"].includes(text)) continue;
    const matches = people.filter((person) => {
      const name = person.name.toLowerCase();
      return name === text || name.split(" ")[0] === text || person.address.split("@")[0] === text;
    });
    if (matches.length === 1) addUnique(addresses, matches[0].address, owner);
    else unresolved.push(raw.slice(0, 60));
  }
  return { addresses, unresolved };
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
  const notes: string[] = [];
  let events: CalendarEvent[];
  try {
    events = await deps.listEvents(request.window.start, request.window.end);
  } catch (error: unknown) {
    deps.log?.("agent: list events", error);
    return { slots: [], events: [], notes: ["Could not read your calendar. Try again."], failed: true };
  }
  const busy = ownerBusyBlocks(events, context.ownerAddress, request.excludeEventId);
  if (request.addresses.length > 0) {
    let blocks: BusyBlock[];
    try {
      blocks = await deps.getFreeBusy([...request.addresses], request.window.start, request.window.end);
    } catch (error: unknown) {
      deps.log?.("agent: free-busy", error);
      blocks = request.addresses.map((address) => ({ address, start: request.window.start, end: request.window.end, status: "unknown" as const }));
    }
    const unknown = unknownAvailability(blocks);
    if (unknown.length > 0) notes.push(`Availability is unknown for ${unknown.join(", ")}, so their time counts as busy.`);
    busy.push(...blocks);
  }
  const slots = findSlots({
    busy,
    rangeStart: request.window.start,
    rangeEnd: request.window.end,
    durationMinutes: request.durationMinutes,
    timeZone: context.timeZone,
    workingHours: context.workingHours,
    maxResults: request.count,
    notBefore: context.now,
    distinct: true,
  }).map((slot) => slotRef(slot.start, slot.end));
  return { slots, events, notes, failed: false };
}
