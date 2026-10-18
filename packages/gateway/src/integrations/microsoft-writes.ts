import { z } from "zod/v4";
import { GRAPH_ID, UUID, optional, segment, strictFields, type CatalogField } from "./catalog-fields.js";
import { boundedWrite, folderName, nonblank, utcDateTime } from "./bounded-writes.js";
import type { ServiceAction } from "./types.js";

// Official Graph v1.0 contracts:
// https://learn.microsoft.com/graph/api/user-post-messages
// https://learn.microsoft.com/graph/api/user-post-events
// https://learn.microsoft.com/graph/api/driveitem-post-children
// https://learn.microsoft.com/graph/api/channel-post
const graph = "https://graph.microsoft.com/v1.0";
// Match the OneDrive read catalog's bounded item-ID alphabet, including
// personal-drive IDs such as A1B2C3!123. Require the actual end of input.
const oneDriveItemId: CatalogField = {
  schema: z.string().min(1).max(128).regex(/^[A-Za-z0-9_!:-]+(?![\s\S])/),
  param: { type: "string", required: true, minLength: 1, maxLength: 128 },
};
const eventFields = { calendarId: GRAPH_ID, subject: nonblank(255), startDateTime: utcDateTime, endDateTime: utcDateTime };
const eventSchema = strictFields(eventFields).refine(p => {
  const duration = Date.parse(String(p.endDateTime)) - Date.parse(String(p.startDateTime));
  return duration > 0 && duration <= 366 * 24 * 60 * 60 * 1000;
});
const channelName: CatalogField = {
  schema: z.string().min(1).max(50).regex(/^[^~#%&*{}+\\/:<>?|'"\x00-\x1f\x7f]+$/)
    .refine(value => value.trim() === value && !value.endsWith(".")),
  param: { type: "string", required: true, minLength: 1, maxLength: 50 },
};
export const MICROSOFT_WRITE_ACTIONS: Record<string, Record<string, ServiceAction>> = {
  microsoft_outlook: {
    // No recipients or send endpoint: saving a draft cannot send mail.
    create_draft: boundedWrite("Save a plain-text email draft without recipients after approval", { subject: nonblank(255), body: nonblank(10000) },
      { method: "POST", url: `${graph}/me/messages`, mapBody: p => ({ subject: p.subject, body: { contentType: "Text", content: p.body } }) }),
  },
  microsoft_outlook_calendar: {
    // Attendees are deliberately excluded: Graph sends invitations when provided.
    create_event: boundedWrite("Create a calendar event without attendees after approval", eventFields, {
      method: "POST", url: p => `${graph}/me/calendars/${segment(p, "calendarId", GRAPH_ID)}/events`,
      mapBody: p => ({ subject: p.subject,
        start: { dateTime: String(p.startDateTime).slice(0, -1), timeZone: "UTC" },
        end: { dateTime: String(p.endDateTime).slice(0, -1), timeZone: "UTC" },
      }),
    }, eventSchema),
  },
  microsoft_onedrive: {
    create_folder: boundedWrite("Create a folder under one selected parent after approval; fail on name conflict", { parentFolderId: oneDriveItemId, name: folderName }, {
      method: "POST", url: p => `${graph}/me/drive/items/${segment(p, "parentFolderId", oneDriveItemId)}/children`,
      mapBody: p => ({ name: p.name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    }),
  },
  microsoft_teams: {
    create_channel: boundedWrite("Create a standard channel in one selected team after approval", { teamId: UUID, displayName: channelName, description: optional(nonblank(1024)) }, {
      method: "POST", url: p => `${graph}/teams/${segment(p, "teamId", UUID)}/channels`,
      mapBody: p => ({ displayName: p.displayName, ...(p.description !== undefined ? { description: p.description } : {}), membershipType: "standard" }),
    }),
  },
};
