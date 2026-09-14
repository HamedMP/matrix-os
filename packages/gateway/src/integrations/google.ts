import type { ServiceDefinition } from "./types.js";
import { listValidation } from "./list-validation.js";

const LOGO_BASE = "https://pipedream.com/s.v0";

// Drive Query Language string-literal escape. Drive QL treats `\\` as a
// literal backslash and `\'` as a literal single quote -- so a naive
// quote-only escape like .replace(/'/g, "\\'") is bypassable with a trailing
// backslash (input "test\'" becomes `'test\\''`, and Drive parses `\\` as a
// literal \, terminates the string at the next `'`, then interprets the rest
// as QL operators). Classic SQL-string escape rule: backslashes FIRST, then
// quotes. Used for both the free-text `query` filter and the `folderId`
// containment clause in google_drive.list_files.
const escapeDriveQL = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");


export const GOOGLE_SERVICES: Record<string, ServiceDefinition> = {
  google_calendar: {
    connectorKind: "pipedream",
    id: "google_calendar",
    name: "Google Calendar",
    category: "google",
    pipedreamApp: "google_calendar",
    icon: "calendar",
    logoUrl: `${LOGO_BASE}/google_calendar/logo/48`,
    actions: {
      // GCal API: events.list. We always target the user's primary calendar
      // -- multi-calendar support would require a separate `calendarId` param
      // and a /calendars/list call to enumerate.
      list_events: {
        description: "List a page of calendar events; continue with nextPageToken",
        risk: "read",
        paramsSchema: listValidation.calendar,
        params: {
          pageToken: { type: "string" },
          timeMin: { type: "string" },
          timeMax: { type: "string" },
          maxResults: { type: "number" },
        },
        directApi: {
          method: "GET",
          url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
          mapParams: (p) => ({
            ...(p.pageToken !== undefined ? { pageToken: String(p.pageToken) } : {}),
            singleEvents: "true",
            orderBy: "startTime",
            ...(p.timeMin ? { timeMin: String(p.timeMin) } : {}),
            ...(p.timeMax ? { timeMax: String(p.timeMax) } : {}),
            ...(p.maxResults ? { maxResults: String(p.maxResults) } : {}),
          }),
        },
      },
      // GCal API: events.insert. `start`/`end` are RFC3339 strings; we wrap
      // them in dateTime fields. Callers passing a date-only string will get
      // a Google-side validation error -- by design, we don't try to detect
      // and remap to {date: ...} all-day events here.
      create_event: {
        description: "Create a new calendar event",
        risk: "write",
        params: {
          summary: { type: "string", required: true },
          start: { type: "string", required: true },
          end: { type: "string", required: true },
          description: { type: "string" },
          location: { type: "string" },
        },
        directApi: {
          method: "POST",
          url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
          mapBody: (p) => ({
            summary: String(p.summary),
            start: { dateTime: String(p.start) },
            end: { dateTime: String(p.end) },
            ...(p.description ? { description: String(p.description) } : {}),
            ...(p.location ? { location: String(p.location) } : {}),
          }),
        },
      },
      // GCal API: events.patch (PATCH, not PUT, so we don't have to send the
      // whole event object). Only fields the caller actually provided are
      // forwarded.
      update_event: {
        description: "Update an existing calendar event",
        risk: "write",
        params: {
          eventId: { type: "string", required: true },
          summary: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
        },
        directApi: {
          method: "PATCH",
          url: (p) =>
            `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(String(p.eventId))}`,
          mapBody: (p) => ({
            ...(p.summary !== undefined ? { summary: String(p.summary) } : {}),
            ...(p.start !== undefined ? { start: { dateTime: String(p.start) } } : {}),
            ...(p.end !== undefined ? { end: { dateTime: String(p.end) } } : {}),
          }),
        },
      },
    },
  },

  google_drive: {
    connectorKind: "pipedream",
    id: "google_drive",
    name: "Google Drive",
    category: "google",
    pipedreamApp: "google_drive",
    icon: "hard-drive",
    logoUrl: `${LOGO_BASE}/google_drive/logo/48`,
    actions: {
      // Drive API v3: files.list. Combines optional `query` (free-text name
      // search) and `folderId` (parents containment) into Drive's `q` filter
      // language. If both are absent, returns the user's recent files.
      list_files: {
        description: "List a page of Drive files; continue with nextPageToken and check incompleteSearch",
        risk: "read",
        paramsSchema: listValidation.drive,
        params: {
          pageToken: { type: "string" },
          query: { type: "string" },
          maxResults: { type: "number" },
          folderId: { type: "string" },
        },
        directApi: {
          method: "GET",
          url: "https://www.googleapis.com/drive/v3/files",
          mapParams: (p) => {
            const clauses: string[] = [];
            if (p.query) clauses.push(`name contains '${escapeDriveQL(String(p.query))}'`);
            if (p.folderId) clauses.push(`'${escapeDriveQL(String(p.folderId))}' in parents`);
            return {
            ...(p.pageToken !== undefined ? { pageToken: String(p.pageToken) } : {}),
              fields: "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,size,parents,webViewLink)",
              ...(clauses.length > 0 ? { q: clauses.join(" and ") } : {}),
              ...(p.maxResults ? { pageSize: String(p.maxResults) } : { pageSize: "25" }),
            };
          },
        },
      },
      // Drive API v3: files.get (metadata only -- no alt=media). Returns the
      // standard file metadata fields. For the binary content, the agent
      // would need a separate `download_file` action we haven't shipped.
      get_file: {
        description: "Get file metadata by ID",
        risk: "read",
        params: {
          fileId: { type: "string", required: true },
        },
        directApi: {
          method: "GET",
          url: (p) =>
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(String(p.fileId))}`,
          mapParams: () => ({
            fields: "id,name,mimeType,modifiedTime,createdTime,size,parents,owners,webViewLink",
          }),
        },
      },
      // upload_file deliberately has NO directApi block. Drive's single-
      // request media upload (POST /upload/drive/v3/files?uploadType=multipart)
      // requires a hand-built multipart/related body with boundary framing,
      // a metadata JSON part, and a content part with correct
      // Content-Transfer-Encoding. That's ~25 lines of careful code that only
      // handles text content cleanly -- binary uploads need base64 plus
      // re-encoding. Not worth the complexity here. upload_file falls through
      // to the google_drive-upload-file Pipedream component, which requires
      // a paid Pipedream plan. On a free plan, agents should fall back to
      // get_file + share_file workflows instead. Documented in the
      // integrations skill at home/.agents/skills/matrix-integrations/SKILL.md.
      upload_file: {
        description: "Upload a file to Google Drive (requires paid Pipedream plan)",
        risk: "write",
        params: {
          name: { type: "string", required: true },
          content: { type: "string", required: true },
          mimeType: { type: "string" },
          folderId: { type: "string" },
        },
      },
      // Drive API v3: permissions.create. Defaults to role=reader for least
      // privilege; caller can override with `role` (writer, commenter, owner).
      // sendNotificationEmail=false avoids spamming the recipient -- if they
      // want a notification, they can paste the link manually.
      share_file: {
        description: "Share a file with another user",
        risk: "write",
        params: {
          fileId: { type: "string", required: true },
          email: { type: "string", required: true },
          role: { type: "string" },
        },
        directApi: {
          method: "POST",
          url: (p) =>
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(String(p.fileId))}/permissions?sendNotificationEmail=false`,
          mapBody: (p) => ({
            type: "user",
            role: p.role ? String(p.role) : "reader",
            emailAddress: String(p.email),
          }),
        },
      },
    },
  },

};
