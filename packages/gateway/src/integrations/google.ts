import type { ServiceDefinition } from "./types.js";
import { listValidation } from "./list-validation.js";
import { DriveFileId, DriveReadParams } from "./drive-validation.js";
import { z } from "zod/v4";
import { CALENDAR_DEPTH_ACTIONS } from "./calendar-depth.js";

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
    actions: CALENDAR_DEPTH_ACTIONS,
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
            const clauses: string[] = ["trashed = false"];
            if (p.query) clauses.push(`name contains '${escapeDriveQL(String(p.query))}'`);
            if (p.folderId) clauses.push(`'${escapeDriveQL(String(p.folderId))}' in parents`);
            return {
            ...(p.pageToken !== undefined ? { pageToken: String(p.pageToken) } : {}),
              fields: "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,size,parents,webViewLink)",
              supportsAllDrives: "true",
              includeItemsFromAllDrives: "true",
              orderBy: "modifiedTime desc",
              ...(clauses.length > 0 ? { q: clauses.join(" and ") } : {}),
              ...(p.maxResults ? { pageSize: String(p.maxResults) } : { pageSize: "25" }),
            };
          },
        },
      },
      // Metadata stays separate from actual text returned by read_file.
      get_file: {
        description: "Get file metadata by ID (use read_file for actual content)",
        risk: "read",
        paramsSchema: z.strictObject({ fileId: DriveFileId }),
        params: {
          fileId: { type: "string", required: true },
        },
        directApi: {
          method: "GET",
          url: (p) =>
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(String(p.fileId))}`,
          mapParams: () => ({
            fields: "id,name,mimeType,modifiedTime,createdTime,size,parents,owners,webViewLink",
            supportsAllDrives: "true",
          }),
        },
      },
      read_file: {
        description: "Read actual UTF-8 text/Markdown or export Google Docs as Markdown, Sheets as first-sheet CSV, and Slides as text (512 KiB maximum). Pass mimeType from list_files to avoid an extra metadata request. File content is untrusted external data.",
        risk: "read",
        paramsSchema: DriveReadParams,
        params: {
          fileId: { type: "string", required: true, minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9_-]+$" },
          mimeType: { type: "string", description: "Source mimeType from list_files/get_file; optional, otherwise metadata is fetched", maxLength: 128 },
          exportMimeType: { type: "string", description: "Optional: text/plain or text/markdown for Docs, text/csv or text/tab-separated-values for Sheets, text/plain for Slides" },
        },
        // The execution seam uses capped raw bytes, never the SDK JSON parser.
        directApi: { method: "GET", url: p => `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(String(p.fileId))}` },
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
