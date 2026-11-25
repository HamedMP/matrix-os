/**
 * The event cache: one entry per calendar and loaded range, kept as plain
 * records so the store stays serialisable. Size-capped with least-recently-used
 * eviction. Every function returns a new cache and never mutates its input.
 */
import { instantToMs, type CalendarEvent, type IsoInstant } from "../../../_shared/office-accounts/types/calendar";

export const MAX_CACHE_ENTRIES = 120;
export const MAX_EVENTS_PER_ENTRY = 2_000;
/** Entries older than this are refetched when shown again. */
export const CACHE_TTL_MS = 5 * 60_000;
/** All-day events sit on midnight UTC; widen their overlap test by the largest zone offset. */
const ALL_DAY_SLACK_MS = 14 * 60 * 60_000;

export interface EventCacheEntry {
  calendarId: string;
  start: IsoInstant;
  /** Exclusive. */
  end: IsoInstant;
  events: CalendarEvent[];
  /** Epoch ms the reply was asked for; the later of two overlapping replies wins where they overlap. */
  fetchedAt: number;
  /** Set when a newer reply showed that this entry may miss an event; it is fetched again when shown. */
  stale?: true;
}

export interface EventCache {
  entries: Record<string, EventCacheEntry>;
  /** Keys, least recently used first. */
  order: string[];
}

export function emptyCache(): EventCache {
  return { entries: {}, order: [] };
}

export function cacheKey(calendarId: string, start: IsoInstant, end: IsoInstant): string {
  return `${calendarId}\u0000${instantToMs(start)}\u0000${instantToMs(end)}`;
}

function entryKey(entry: EventCacheEntry): string {
  return cacheKey(entry.calendarId, entry.start, entry.end);
}

/** True when the event shows anywhere in the half-open range. */
export function eventOverlaps(event: CalendarEvent, startMs: number, endMs: number): boolean {
  const slack = event.allDay ? ALL_DAY_SLACK_MS : 0;
  const eventStart = instantToMs(event.start) - slack;
  const eventEnd = Math.max(instantToMs(event.end), instantToMs(event.start) + 1) + slack;
  return eventStart < endMs && eventEnd > startMs;
}

function sortEvents(events: CalendarEvent[]): CalendarEvent[] {
  return events.sort((a, b) => instantToMs(a.start) - instantToMs(b.start) || a.id.localeCompare(b.id));
}

/** True when the event shows in the half-open range in every zone, so a complete reply for it must list it. */
function certainlyOverlaps(event: CalendarEvent, startMs: number, endMs: number): boolean {
  const slack = event.allDay ? ALL_DAY_SLACK_MS : 0;
  const eventStart = instantToMs(event.start) + slack;
  const eventEnd = Math.max(instantToMs(event.end), instantToMs(event.start) + 1) - slack;
  return eventStart < endMs && eventEnd > startMs;
}

/**
 * `target` corrected by `source`, the newer reply for an overlapping range of
 * the same calendar: inside the source's range the source is the truth, so
 * its events replace the target's copies and events it no longer lists are
 * dropped (deleted, or moved away). A target whose range reaches past the
 * source's and lost such an event is marked stale, because the event may now
 * sit in the part the source did not cover; it is fetched again when shown.
 */
function reconcile(target: EventCacheEntry, source: EventCacheEntry, sourceComplete: boolean): EventCacheEntry {
  const sourceStart = instantToMs(source.start);
  const sourceEnd = instantToMs(source.end);
  const targetStart = instantToMs(target.start);
  const targetEnd = instantToMs(target.end);
  const listed = new Set(source.events.map((event) => event.id));
  let lost = false;
  let changed = false;
  const events = target.events.filter((event) => {
    if (listed.has(event.id)) {
      changed = true;
      return false;
    }
    if (sourceComplete && certainlyOverlaps(event, sourceStart, sourceEnd)) {
      changed = true;
      lost = true;
      return false;
    }
    return true;
  });
  for (const event of source.events) {
    if (events.length >= MAX_EVENTS_PER_ENTRY) break;
    if (eventOverlaps(event, targetStart, targetEnd)) {
      events.push(event);
      changed = true;
    }
  }
  if (!changed) return target;
  const covered = sourceStart <= targetStart && sourceEnd >= targetEnd;
  const next: EventCacheEntry = { ...target, events: sortEvents(events) };
  if (lost && !covered) next.stale = true;
  return next;
}

function rangesOverlap(a: EventCacheEntry, b: EventCacheEntry): boolean {
  return a.calendarId === b.calendarId
    && instantToMs(a.start) < instantToMs(b.end) && instantToMs(a.end) > instantToMs(b.start);
}

/**
 * Adds or replaces an entry, marks it most recently used and evicts the
 * oldest beyond `limit`. Overlapping entries of the same calendar are
 * reconciled so that, where two ranges overlap, the reply asked for later
 * wins: a meeting deleted or moved since an older reply does not come back
 * from it. A reply asked for before the entry already stored for the same
 * range is dropped.
 */
export function putEntry(cache: EventCache, entry: EventCacheEntry, limit = MAX_CACHE_ENTRIES): EventCache {
  const key = entryKey(entry);
  const existing = cache.entries[key];
  if (existing && existing.fetchedAt > entry.fetchedAt) return touchEntries(cache, [key]);
  const complete = entry.events.length <= MAX_EVENTS_PER_ENTRY;
  let incoming: EventCacheEntry = { ...entry, events: sortEvents(entry.events.slice(0, MAX_EVENTS_PER_ENTRY)) };
  const overlapping = cache.order.filter((other) => other !== key && cache.entries[other] && rangesOverlap(cache.entries[other], incoming));
  // First the newer replies correct this one, then this one corrects the older replies.
  for (const other of overlapping) {
    const stored = cache.entries[other];
    if (stored.fetchedAt > entry.fetchedAt) incoming = reconcile(incoming, stored, stored.events.length < MAX_EVENTS_PER_ENTRY);
  }
  const entries: Record<string, EventCacheEntry> = { ...cache.entries };
  for (const other of overlapping) {
    const stored = cache.entries[other];
    if (stored.fetchedAt <= entry.fetchedAt) entries[other] = reconcile(stored, incoming, complete);
  }
  entries[key] = incoming;
  const order = [...cache.order.filter((item) => item !== key), key];
  while (order.length > Math.max(1, limit)) {
    const evicted = order.shift();
    if (evicted !== undefined) delete entries[evicted];
  }
  return { entries, order };
}

/** Marks entries as recently used. Unknown keys are ignored. */
export function touchEntries(cache: EventCache, keys: readonly string[]): EventCache {
  const present = keys.filter((key) => key in cache.entries);
  if (present.length === 0) return cache;
  const moved = new Set(present);
  return { entries: cache.entries, order: [...cache.order.filter((key) => !moved.has(key)), ...present] };
}

/** The entry when it exists, is younger than `ttlMs` and no newer reply marked it stale. */
export function freshEntry(cache: EventCache, key: string, now: number, ttlMs = CACHE_TTL_MS): EventCacheEntry | null {
  const entry = cache.entries[key];
  return entry && !entry.stale && now - entry.fetchedAt < ttlMs ? entry : null;
}

/** Drops every entry, or only those of the given calendars. */
export function invalidate(cache: EventCache, calendarIds?: readonly string[]): EventCache {
  if (!calendarIds) return emptyCache();
  const drop = new Set(calendarIds);
  const entries: Record<string, EventCacheEntry> = {};
  for (const key of cache.order) {
    const entry = cache.entries[key];
    if (entry && !drop.has(entry.calendarId)) entries[key] = entry;
  }
  return { entries, order: cache.order.filter((key) => key in entries) };
}

/**
 * Events of the given calendars that show in the range, from every cached
 * entry, once each, ordered by start.
 */
export function eventsInRange(cache: EventCache, calendarIds: readonly string[], start: IsoInstant, end: IsoInstant): CalendarEvent[] {
  const wanted = new Set(calendarIds);
  const startMs = instantToMs(start);
  const endMs = instantToMs(end);
  const byId: Record<string, CalendarEvent> = {};
  for (const key of cache.order) {
    const entry = cache.entries[key];
    if (!entry || !wanted.has(entry.calendarId)) continue;
    if (!(instantToMs(entry.start) < endMs && instantToMs(entry.end) > startMs)) continue;
    // Later (more recently used) entries win for the same id.
    for (const event of entry.events) if (eventOverlaps(event, startMs, endMs)) byId[event.id] = event;
  }
  return sortEvents(Object.values(byId));
}

export function findCachedEvent(cache: EventCache, eventId: string): CalendarEvent | null {
  for (let index = cache.order.length - 1; index >= 0; index -= 1) {
    const found = cache.entries[cache.order[index]]?.events.find((event) => event.id === eventId);
    if (found) return found;
  }
  return null;
}

/**
 * Removes `eventId` from every entry, then puts `next` (when given) into
 * every entry of its calendar whose range it touches. This one operation
 * covers optimistic create, update, delete and their rollback.
 */
export function replaceEvent(cache: EventCache, eventId: string, next: CalendarEvent | null): EventCache {
  const entries: Record<string, EventCacheEntry> = {};
  let changed = false;
  for (const key of cache.order) {
    const entry = cache.entries[key];
    if (!entry) continue;
    const had = entry.events.some((event) => event.id === eventId || (next !== null && event.id === next.id));
    const belongs = next !== null && next.calendarId === entry.calendarId
      && eventOverlaps(next, instantToMs(entry.start), instantToMs(entry.end));
    if (!had && !belongs) {
      entries[key] = entry;
      continue;
    }
    changed = true;
    const events = entry.events.filter((event) => event.id !== eventId && (next === null || event.id !== next.id));
    if (belongs && next && events.length < MAX_EVENTS_PER_ENTRY) events.push(next);
    entries[key] = { ...entry, events: sortEvents(events) };
  }
  return changed ? { entries, order: cache.order } : cache;
}
