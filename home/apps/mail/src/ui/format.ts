/**
 * Display formatting for the Mail views. Inputs are untrusted mailbox data;
 * outputs are plain strings rendered as React text.
 */
import { instantToMs, normalizeMailAddress, type MailAddress } from "../../../_shared/office-accounts/types/mail";

const DAY_MS = 24 * 60 * 60 * 1000;

function partsIn(ms: number, timeZone: string): { year: string; month: string; day: string; weekday: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day"), weekday: get("weekday"), hour: get("hour"), minute: get("minute") };
}

function isoDateIn(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function safeMs(instant: string): number | null {
  try {
    return instantToMs(instant);
  } catch (error: unknown) {
    if (error instanceof RangeError || error instanceof TypeError) return null;
    throw error;
  }
}

/** Compact time for a list row: "09:05" today, "Fri" this week, "Mar 2" this year, else "2025-03-02". */
export function formatListTime(instant: string, now: number, timeZone: string): string {
  const ms = safeMs(instant);
  if (ms === null) return "";
  try {
    const at = partsIn(ms, timeZone);
    if (isoDateIn(ms, timeZone) === isoDateIn(now, timeZone)) return `${at.hour}:${at.minute}`;
    if (now - ms >= 0 && now - ms < 6 * DAY_MS) return at.weekday;
    if (at.year === partsIn(now, timeZone).year) return `${at.month} ${at.day}`;
    return isoDateIn(ms, timeZone);
  } catch (error: unknown) {
    if (error instanceof RangeError) return "";
    throw error;
  }
}

/** Full date and time for a message header. */
export function formatFullTime(instant: string, timeZone: string): string {
  const ms = safeMs(instant);
  if (ms === null) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
  } catch (error: unknown) {
    if (error instanceof RangeError) return "";
    throw error;
  }
}

function shortName(person: MailAddress): string {
  const name = (person.name ?? "").trim();
  if (!name) return person.address;
  return name.split(/\s+/)[0] ?? name;
}

/** The people on a thread for a list row, "me" for the owner's own addresses. */
export function senderLabel(participants: readonly MailAddress[], ownAddresses: readonly string[]): string {
  if (participants.length === 0) return "(no sender)";
  const own = new Set(ownAddresses.map(normalizeMailAddress));
  if (participants.length === 1) {
    const only = participants[0];
    return own.has(normalizeMailAddress(only.address)) ? "me" : (only.name ?? "").trim() || only.address;
  }
  const seen = new Set<string>();
  const names: string[] = [];
  for (const person of participants.slice(0, 8)) {
    const label = own.has(normalizeMailAddress(person.address)) ? "me" : shortName(person);
    if (seen.has(label)) continue;
    seen.add(label);
    names.push(label);
    if (names.length === 3) break;
  }
  return names.join(", ");
}

/** A person as shown in a header: the name, else the address. */
export function displayName(person: MailAddress): string {
  return (person.name ?? "").trim() || person.address;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
