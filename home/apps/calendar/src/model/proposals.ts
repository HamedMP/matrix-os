/**
 * Proposals: candidate slots highlighted on the grid that the owner can turn
 * into an event draft with one click. They come from the agent (untrusted
 * input, validated here) or from the scheduling assistant (`findSlots`).
 * A proposal never creates an event or sends an invite by itself.
 */
import { isValidMailAddress } from "../../../_shared/office-accounts/types/addresses";
import {
  MAX_EVENT_ATTENDEES,
  instantToMs,
  isIsoInstant,
  type EventDraftAttendee,
  type IsoInstant,
} from "../../../_shared/office-accounts/types/calendar";
import { MINUTES_PER_DAY, MS_PER_MINUTE, wallMinutesAt, type DayKey, type DaySlice } from "./dates";
import type { TimeSlot } from "./slots";

export const PROPOSAL_SOURCES = ["agent", "assistant"] as const;
export type ProposalSource = (typeof PROPOSAL_SOURCES)[number];

export const MAX_PROPOSALS = 50;
export const MAX_PROPOSAL_TITLE = 200;
export const MAX_PROPOSAL_NOTE = 500;
/** A proposal longer than this is not a meeting slot and is dropped. */
const MAX_PROPOSAL_MS = 14 * 24 * 60 * MS_PER_MINUTE;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

export interface Proposal {
  /** `<source>:<id>`; stable for the same slot from the same source. */
  id: string;
  source: ProposalSource;
  start: IsoInstant;
  /** Exclusive. */
  end: IsoInstant;
  /** Plain text, may be empty. Untrusted when the source is the agent. */
  title: string;
  attendees: EventDraftAttendee[];
  /** Why this slot was suggested; plain text, may be empty. */
  note: string;
  /** Calendar the event should go on, when the source named one. */
  calendarId?: string;
  /** IANA zone the source scheduled in, when it named one. */
  timeZone?: string;
  /** Database row the proposal came from, so dismissing it can delete the row. */
  rowId?: string;
}

/** Strips control and direction characters, collapses whitespace and caps the length. */
export function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanAttendees(value: unknown): EventDraftAttendee[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const attendees: EventDraftAttendee[] = [];
  for (const item of value) {
    if (attendees.length >= MAX_EVENT_ATTENDEES) break;
    const raw = typeof item === "string" ? { address: item } : item;
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const address = typeof record.address === "string" ? record.address.trim().toLowerCase() : "";
    if (!address || !isValidMailAddress(address) || seen.has(address)) continue;
    seen.add(address);
    const attendee: EventDraftAttendee = { address };
    const name = cleanText(record.name, 120);
    if (name) attendee.name = name;
    if (record.optional === true) attendee.optional = true;
    attendees.push(attendee);
  }
  return attendees;
}

function validZone(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch (error: unknown) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

function parseOne(item: unknown, source: ProposalSource): Proposal | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const start = record.start ?? record.start_at;
  const end = record.end ?? record.end_at;
  if (!isIsoInstant(start) || !isIsoInstant(end)) return null;
  const startMs = instantToMs(start);
  const endMs = instantToMs(end);
  if (endMs <= startMs || endMs - startMs > MAX_PROPOSAL_MS) return null;
  const ownId = typeof record.id === "string" && SAFE_ID.test(record.id) ? record.id : null;
  const proposal: Proposal = {
    id: `${source}:${ownId ?? `${startMs}-${endMs}`}`,
    source,
    start,
    end,
    title: cleanText(record.title, MAX_PROPOSAL_TITLE),
    attendees: cleanAttendees(record.attendees),
    note: cleanText(record.note ?? record.reason, MAX_PROPOSAL_NOTE),
  };
  if (typeof record.calendarId === "string" && record.calendarId.length > 0 && record.calendarId.length <= 512) {
    proposal.calendarId = record.calendarId;
  }
  const timeZone = validZone(record.timeZone ?? record.time_zone);
  if (timeZone) proposal.timeZone = timeZone;
  if (ownId) proposal.rowId = ownId;
  return proposal;
}

/**
 * Validates candidate slots from an untrusted source. Accepts an array or
 * `{ proposals: [...] }`; drops malformed items, invalid attendees and
 * duplicates of the same slot; keeps at most `MAX_PROPOSALS`, earliest first.
 */
export function parseProposals(raw: unknown, source: ProposalSource): Proposal[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { proposals?: unknown }).proposals)
      ? (raw as { proposals: unknown[] }).proposals
      : [];
  const seenIds = new Set<string>();
  const seenSlots = new Set<string>();
  const proposals: Proposal[] = [];
  for (const item of list.slice(0, MAX_PROPOSALS * 4)) {
    const proposal = parseOne(item, source);
    if (!proposal) continue;
    const slotKey = `${instantToMs(proposal.start)}-${instantToMs(proposal.end)}`;
    if (seenIds.has(proposal.id) || seenSlots.has(slotKey)) continue;
    seenIds.add(proposal.id);
    seenSlots.add(slotKey);
    proposals.push(proposal);
  }
  return sortProposals(proposals).slice(0, MAX_PROPOSALS);
}

export function sortProposals(proposals: readonly Proposal[]): Proposal[] {
  return [...proposals].sort((a, b) => instantToMs(a.start) - instantToMs(b.start) || a.id.localeCompare(b.id));
}

/** Assistant proposals for slots found by `findSlots`. */
export function proposalsFromSlots(
  slots: readonly TimeSlot[],
  details: { title?: string; attendees?: readonly EventDraftAttendee[]; note?: string } = {},
): Proposal[] {
  return parseProposals(
    slots.map((slot) => ({ start: slot.start, end: slot.end, title: details.title, attendees: details.attendees, note: details.note })),
    "assistant",
  );
}

/**
 * Replaces every proposal from `source` with `incoming`, keeps the other
 * source's, and caps the total (the newest source's proposals win).
 */
export function mergeProposals(current: readonly Proposal[], incoming: readonly Proposal[], source: ProposalSource): Proposal[] {
  const kept = current.filter((proposal) => proposal.source !== source);
  const room = Math.max(0, MAX_PROPOSALS - incoming.length);
  return sortProposals([...incoming.slice(0, MAX_PROPOSALS), ...kept.slice(0, room)]);
}

export interface ProposalSegment {
  proposal: Proposal;
  dayKey: DayKey;
  startMinute: number;
  endMinute: number;
}

/** Where proposals sit on each day of a time grid. Every day in `days` has an entry. */
export function proposalSegments(
  proposals: readonly Proposal[],
  days: readonly DaySlice[],
  timeZone: string,
): Record<DayKey, ProposalSegment[]> {
  const result: Record<DayKey, ProposalSegment[]> = {};
  for (const day of days) result[day.key] = [];
  for (const proposal of proposals) {
    const startMs = instantToMs(proposal.start);
    const endMs = instantToMs(proposal.end);
    for (const day of days) {
      if (!(startMs < day.endMs && endMs > day.startMs)) continue;
      const startMinute = startMs <= day.startMs ? 0 : wallMinutesAt(startMs, timeZone);
      let endMinute = endMs >= day.endMs ? MINUTES_PER_DAY : wallMinutesAt(endMs, timeZone);
      if (endMinute <= startMinute) {
        endMinute = Math.min(MINUTES_PER_DAY, startMinute + Math.round((Math.min(endMs, day.endMs) - Math.max(startMs, day.startMs)) / MS_PER_MINUTE));
      }
      result[day.key].push({ proposal, dayKey: day.key, startMinute, endMinute });
    }
  }
  return result;
}
