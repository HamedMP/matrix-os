/**
 * Google Calendar source: events of the configured calendars in a rolling window (pastDays back, futureDays ahead,
 * UTC days), read through the integration layer (registry action google_calendar.brain_list_events with
 * singleEvents and showDeleted). One document per event instance with its times, organizer and attendees.
 * Descriptions and locations are stored only when the owner set includeEventBodies; without it a private or
 * confidential event is titled "Private event". Cancelled events become deletions; events that leave the window stay,
 * up to calendarEventsMax documents per source (past it the oldest history is deleted). A config change (calendars,
 * bodies) re-renders every listed event and deletes the stored ones missing from the listing, so turning bodies off
 * leaves no description of a past event or of a removed calendar.
 */
import { z } from "zod/v4";
import type { BrainGoogleCalendarSourceConfig, BrainSourceAdapter, BrainSourceNotice } from "../../contracts.js";
import { callProvider, text, type ConnectorResult, type ProviderCall as Call } from "./provider.js";
import { createSnapshotAdapter, type SnapshotItem, type SnapshotListing } from "./snapshot.js";
import {
  RefSet, canonicalPermalink, clampTitle, composeBody, connectorDocumentId, isoInstant, personKey, shortHash,
} from "./text.js";
import { BRAIN_CONNECTOR_LIMITS } from "./types.js";

const RENDER_VERSION = "1";
const DAY_MS = 86_400_000;
const EventTimeSchema = z.object({
  dateTime: text(64).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).optional();
const EventSchema = z.object({
  id: z.string().min(1).max(1_024), status: text(32).optional(), htmlLink: text(2_048).optional(),
  summary: text(10_000).optional(), description: text(1_000_000).optional(), location: text(10_000).optional(),
  visibility: text(32).optional(), start: EventTimeSchema, end: EventTimeSchema, updated: text(64).optional(),
  organizer: z.object({ email: text(320).optional() }).optional(),
  attendees: z.array(z.object({
    email: text(320).optional(), responseStatus: text(32).optional(), resource: z.boolean().optional(),
  })).max(500).optional(),
});
const EventsSchema = z.object({ items: z.array(EventSchema).max(2_500), nextPageToken: text(2_048).optional() });
type CalendarEvent = z.output<typeof EventSchema>;

interface EventItem extends SnapshotItem { readonly event: CalendarEvent }

const utcDay = (time: number): number => Math.floor(time / DAY_MS) * DAY_MS;

/** Display text and the starts_at ref value (UTC instant; all-day events start at UTC midnight). */
function eventTime(value: CalendarEvent["start"]): { readonly display: string; readonly instant: string | null } {
  if (value?.date !== undefined) return { display: value.date, instant: `${value.date}T00:00:00.000Z` };
  const instant = isoInstant(value?.dateTime);
  return { display: instant ?? "unknown", instant };
}

async function listEvents(
  call: Call, signal: AbortSignal, externalRef: string, config: BrainGoogleCalendarSourceConfig, now: Date,
): Promise<ConnectorResult<SnapshotListing<EventItem>>> {
  const today = utcDay(now.getTime());
  const timeMin = new Date(today - config.pastDays * DAY_MS).toISOString();
  const timeMax = new Date(today + (config.futureDays + 1) * DAY_MS).toISOString();
  const items = new Map<string, EventItem>();
  const gone: string[] = [];
  const notices: BrainSourceNotice[] = [];
  let complete = true;
  let calls = 0;
  calendars: for (const calendarId of config.calendarIds) {
    let pageToken: string | null = null;
    do {
      if (calls >= BRAIN_CONNECTOR_LIMITS.listCallsMax) {
        complete = false;
        notices.push("pages_capped");
        break calendars;
      }
      calls += 1;
      const listed: ConnectorResult<z.output<typeof EventsSchema>> = await callProvider({ ...call, signal }, {
        service: "google_calendar", action: "brain_list_events",
        ...(config.accountLabel === undefined ? {} : { label: config.accountLabel }),
        params: {
          calendarId, timeMin, timeMax, maxResults: BRAIN_CONNECTOR_LIMITS.calendarPageSize,
          ...(pageToken === null ? {} : { pageToken }),
        },
      }, EventsSchema);
      if (!listed.ok) return listed;
      for (const event of listed.value.items) {
        const documentId = connectorDocumentId("google_calendar", externalRef, ["event", calendarId, event.id]);
        if (items.size + gone.length >= BRAIN_CONNECTOR_LIMITS.calendarEventsMax) {
          complete = false;
          notices.push("items_truncated");
          break calendars;
        }
        const stamp = isoInstant(event.updated);
        if (event.status === "cancelled") gone.push(documentId);
        else if (stamp !== null) items.set(documentId, { documentId, stamp, event });
      }
      pageToken = listed.value.nextPageToken ?? null;
    } while (pageToken !== null);
  }
  return { ok: true, value: { items: [...items.values()], complete, gone, notices } };
}

export function buildEventDocument(item: EventItem, config: BrainGoogleCalendarSourceConfig) {
  const { event } = item;
  const bodies = config.includeEventBodies;
  const isPrivate = event.visibility === "private" || event.visibility === "confidential";
  const title = clampTitle(isPrivate && !bodies ? "Private event" : event.summary, "(No title)");
  const starts = eventTime(event.start);
  const ends = eventTime(event.end);
  const organizer = personKey("email", event.organizer?.email);
  const attendees = (event.attendees ?? []).filter((attendee) => attendee.resource !== true)
    .slice(0, BRAIN_CONNECTOR_LIMITS.attendeesMax);
  const refs = new RefSet().add("starts_at", starts.instant).add("author", organizer)
    .add("status", /^[a-z]{1,32}$/.test(event.status ?? "") ? event.status : null);
  const shown: string[] = [];
  for (const attendee of attendees) {
    const key = personKey("email", attendee.email);
    if (key === null) continue;
    refs.add("attendee", key);
    shown.push(`${key.slice("email:".length)}${attendee.responseStatus ? ` (${attendee.responseStatus})` : ""}`);
  }
  const footer = [
    `Starts: ${starts.display}`, `Ends: ${ends.display}`,
    ...(organizer === null ? [] : [`Organizer: ${organizer.slice("email:".length)}`]),
    ...(shown.length > 0 ? [`Attendees: ${shown.join(", ")}`] : []),
  ];
  const hidden = (event.description ?? "") !== "" || (event.location ?? "") !== "";
  const main = bodies
    ? [event.description ?? "", event.location ? `Location: ${event.location}` : ""].filter((part) => part !== "").join("\n\n")
    : "";
  const composed = composeBody(title, main, footer);
  const notices: BrainSourceNotice[] = [];
  if (!bodies && hidden) notices.push("private_body_omitted");
  if (composed.truncated) notices.push("body_truncated");
  return {
    upsert: {
      documentId: item.documentId, title, body: composed.body, permalink: canonicalPermalink(event.htmlLink),
      sourceUpdatedAt: item.stamp, provenance: "calendar_event", refs: refs.list(),
    },
    notices,
  };
}

export function calendarFingerprint(config: BrainGoogleCalendarSourceConfig): string {
  return shortHash([
    "google_calendar", RENDER_VERSION, String(config.includeEventBodies), ...[...config.calendarIds].sort(),
  ]);
}

export function createGoogleCalendarAdapter(
  call: Call, config: BrainGoogleCalendarSourceConfig,
): BrainSourceAdapter<BrainGoogleCalendarSourceConfig> {
  return createSnapshotAdapter<BrainGoogleCalendarSourceConfig, EventItem>({
    kind: "google_calendar", cursorPrefix: "gc1", fingerprint: calendarFingerprint(config),
    buildsPerPage: BRAIN_CONNECTOR_LIMITS.calendarPageSize, sweep: false, retain: BRAIN_CONNECTOR_LIMITS.calendarEventsMax,
    sweepOnMigrate: true,
    list: (context) => listEvents(call, context.signal, context.externalRef, context.config, context.now()),
    build: async (item, context) => ({ ok: true, value: buildEventDocument(item, context.config) }),
  });
}
