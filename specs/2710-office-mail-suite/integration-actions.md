# 2710: integration actions for Mail and Calendar

Spec: [spec.md](./spec.md). App-side contract: `home/apps/_shared/office-accounts/types/`.

This is the list of integration actions the gateway adds so the Mail and Calendar
adapters can be written at the same time. It fixes ids, risk, parameters with bounds,
the provider request and the reply fields the adapters read.

35 new actions: 22 writes and 13 reads. Two reads are not in the original brief and were
added because the contract cannot be met without them: `gmail/get_label` (unread counts)
and `microsoft_outlook/get_folder` (finding Inbox, Sent and the other standard folders
without matching on translated display names).

## 1. Rules for every action

1. **One proxied HTTP call per action.** Each action is a `directApi` entry.
   `action-execution.ts` and `pipedream*.ts` must not be edited, so there is no custom
   execution path and no gateway-side truncation. Size is bounded by provider-side
   `fields`, `$select` and `$top`, and by the reply caps in section 3.
2. **Risk is `read` or `write`.** Never `destructive`
   (`tests/integrations/registry.test.ts` fails on any). Nothing here deletes mail
   permanently.
3. **Every write is listed in `MANAGED_WRITE_ACTIONS`** in `packages/kernel/src/hooks.ts`.
   `tests/kernel/integration-approval-hook.test.ts` requires the set to equal every
   registry action with `risk: "write"`. The exact strings are in section 8.
4. **Validation.** `paramsSchema` is a `z.strictObject` from `zod/v4`, constraints only
   (no coerce, no transform). Every key the schema accepts also has an entry in `params`
   (`ActionParam`), because the app route rejects a parameter that is missing from the
   action's `params` metadata. Arrays use `type: "array"`, flags `type: "boolean"`.
5. **Path values** go through `segment()` (or an equivalent validate-then-encode step).
   `"../x"`, `"?q"` and `"\n"` must fail both `paramsSchema` and `url()`.
6. **Query strings on `POST`, `PATCH` and `PUT`** are built inside `url()`.
   `executeIntegrationAction` applies `mapParams` only to `GET` and `DELETE`. `mapParams`
   values are single strings, so a repeated query key is also built inside `url()`.
7. **Reply shape.** `MatrixOS.service(service, action, params, label?)` resolves to
   `{ data, service, action, summary? }`. `data` is the provider's JSON, unchanged. A
   provider reply with no body (HTTP 202 or 204) gives an empty `data`; adapters must not
   read fields from it.
8. **Errors.** The app route answers 404 (no account), 409 (several accounts and no
   `label`), 429 (request budget used up), 400, 403, 502 and 503 with a generic message.
   Adapters map the status with `providerErrorCodeForStatus` and never show provider text.
9. **Who approves.** An agent call to a write goes through the approval hook. A
   first-party app is trusted by default and gets no prompt, so the Mail and Calendar apps
   must put every `send_draft`, every invite and every RSVP behind an explicit owner click.

### Where the code goes

Existing files that open pull requests rewrite stay untouched (`gmail.ts`, `routes.ts`,
`action-execution.ts`, `read-call.ts`, `pipedream*.ts`). Suggested layout:

| New file | Holds | Registration (one line each) |
| --- | --- | --- |
| `integrations/gmail-mail-actions.ts`, `gmail-mime.ts` | Gmail reads and writes, MIME builder | writes: a new map in `registry-writes.ts`; reads: spread into the `gmail` entry in `registry.ts` |
| `integrations/outlook-mail-actions.ts` | Outlook mail reads and writes | writes: `registry-writes.ts`; reads: spread into `microsoft_outlook` in `registry-oauth.ts` |
| `integrations/calendar-scheduling-actions.ts` | Google and Outlook calendar actions | writes: `registry-writes.ts`; reads: `google_calendar` and `microsoft_outlook_calendar` definitions |

Tests that constrain this work:

- `tests/integrations/write-action-wiring.test.ts` lists the write maps. Add the new maps;
  every entry must be `risk: "write"` with a `paramsSchema`, so reads cannot live in a
  write map.
- `tests/gateway/integration-catalog-expansion.test.ts` requires every action in
  `CATALOG_SERVICE_REGISTRY.microsoft_outlook_calendar` to be a read. Outlook calendar
  writes therefore go in a write map. `get_schedule` is a read and may live in the catalog.
- `tests/integrations/registry.test.ts` line 284 asserts `google_calendar/delete_event` is
  absent. This spec adds it as a `write` (the event goes to the calendar's trash). Change
  that assertion on purpose, in the same commit.
- `tests/integrations/document-writes.test.ts` asserts Outlook `create_draft` rejects
  `toRecipients`. It stays true: recipients are only accepted by the new `create_html_draft`.
- `tests/gateway/integrations-gmail.test.ts` asserts `modify_message` rejects `TRASH`. It
  stays true: trash is only reachable through the new `batch_modify`.
- The marketplace copy for `microsoft_outlook` ("Read email and mail folders") and
  `microsoft_outlook_calendar` ("Read calendars and events") in
  `packages/contracts/src/integration-marketplace.ts` is asserted by the catalog test and
  stops being true. Update the copy and the assertion together.

## 2. Request size: 64 KiB, end to end

A call from an app passes four limits of 65,536 bytes for the whole JSON request:
`MAX_APP_CAPABILITY_BYTES` in the contracts package (the schema allows 65,024), the shell
bridge, the gateway app route, and `bodyLimit` on `/call` and `/read-call` in files that
must not be edited. No action can accept more in this proof of concept.

Consequences:

- Every compose action adds a schema rule: `Buffer.byteLength(JSON.stringify(params)) <= 60000`.
- `bodyHtml` and `bodyText` are each at most 60,000 characters, and together with
  recipients, subject and attachments they must fit in the 60,000 bytes.
- **Attachment cap.** At most 10 attachments per draft. Their base64 content shares the
  60,000 byte budget, which is roughly 40 KiB of files with a short body. Outlook
  attachments travel one per call, about 42 KiB each.
- Larger attachments need the four limits raised together, which means editing
  `integrations/routes.ts`. That is out of scope here and is the first follow-up.

The app-side mirror of these numbers is `MAX_DRAFT_REQUEST_BYTES`, `MAX_DRAFT_ATTACHMENTS`
and `draftIssues()` in `types/mail.ts`.

## 3. Reply size

Replies to apps are capped by `appIntegrationReplyBytes(service, action)` in
`packages/contracts/src/app-capabilities.ts` (default 256 KiB). The shell and the gateway
both read it. An oversized reply fails as a whole; nothing is truncated. Add these entries:

| Action | Cap | Why |
| --- | --- | --- |
| `gmail/get_thread` | 1.5 MiB (1,572,864) | full message bodies |
| `gmail/get_message` (existing action) | 1.5 MiB | per-message fallback for a thread over the cap |
| `microsoft_outlook/get_message` | 1.5 MiB | HTML body |
| `microsoft_outlook/list_conversation` | 1.5 MiB | HTML bodies of a thread |
| `microsoft_outlook/get_attachment` | 1.5 MiB | 1 MiB decoded file as base64 |
| `google_calendar/list_events`, `microsoft_outlook_calendar/list_events` (existing) | 1 MiB | month view; Outlook returns each event's HTML body |
| `microsoft_outlook_calendar/get_schedule` | 1 MiB | 20 people over six weeks |

Writes are capped at 256 KiB by `MAX_CALL_BYTES` in `bots/integration-client.ts`
(`callAppAction` uses the per-action cap only for reads). Five Outlook writes echo a
whole message: `update_message`, `move_message`, `create_html_draft`, `create_reply_draft`
and `update_draft`. For those, the gateway appends
`$select=id,conversationId,parentFolderId,isRead,isDraft,flag` to the request URL, and
`callAppAction` should use `appIntegrationReplyBytes` for writes too, with 1.5 MiB for
these five, so a large message cannot turn a successful write into an error.

Other budgets the adapters work inside: 120 app requests per minute and 8 in flight for
the whole gateway, 30 seconds per call. A Gmail thread list costs one call plus one per
thread, so the Gmail adapter lists 25 threads per page and fetches summaries at most 6 at
a time.

## 4. Shared parameter definitions

| Name | Definition |
| --- | --- |
| `gmailId` | `/^[A-Za-z0-9_-]+$/`, 1 to 128 characters (message, thread, draft and label ids) |
| `graphId` | existing `GRAPH_ID`: `/^[A-Za-z0-9_+=-]+$/`, 1 to 512 characters |
| `email` | existing `email`: a valid address, at most 254 characters |
| `gmailRecipients` | array of `{ address: email, name?: string }`, `name` 1 to 128 characters without control characters |
| `graphRecipients` | same shape as `gmailRecipients`; sent as `[{ emailAddress: { address, name } }]` |
| `subject` | string, 0 to 255 characters, no control characters |
| `bodyHtml`, `bodyText` | string, 0 to 60,000 characters |
| `messageIdHeader` | `/^<[^<>\s]{1,995}>$/` |
| `attachments` | array, at most 10, of `{ filename, mimeType, contentBase64 }`: `filename` 1 to 255 characters without `/`, `\`, `"` or control characters; `mimeType` `/^[\w.+-]{1,63}\/[\w.+-]{1,63}$/`; `contentBase64` standard base64 with padding |
| `pageToken` | existing rule: 1 to 2048 characters, no whitespace or control characters |
| `offsetTime` | existing `z.iso.datetime({ offset: true })` |
| `utcTime` | existing `utcDateTime`: ISO date-time ending in `Z` |
| `wallTime` | `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/` and a real date and time; no offset |
| `date` | `/^\d{4}-\d{2}-\d{2}$/` and a real date |
| `timeZone` | IANA name: `/^[A-Za-z0-9_+\/-]{1,64}$/` |
| `calendarId` (Google) | existing rule in `calendar-depth.ts`; optional, default `primary` |
| `eventId` (Google) | existing rule in `calendar-depth.ts` |

Across `to`, `cc` and `bcc` (or the three Outlook lists) a draft has at most 100 recipients.

## 5. `gmail`

Base: `https://gmail.googleapis.com/gmail/v1/users/me`. `gmail.ts` is not edited.

| Action | Risk | Parameters | Provider request |
| --- | --- | --- | --- |
| `list_threads_query` | read | `query?` (at most 4096), `labelIds?` (0 to 10 `gmailId`, unique), `maxResults?` (1 to 100, default 25), `pageToken?` | `GET /threads?labelIds=A&labelIds=B&q=&maxResults=&pageToken=`; adds `includeSpamTrash=true` only when `labelIds` contains `TRASH` or `SPAM` |
| `get_thread` | read | `threadId`, `format?` (`full` default, or `summary`) | `GET /threads/{threadId}?format=full&fields=…` (masks below) |
| `get_label` | read | `labelId` | `GET /labels/{labelId}` |
| `list_drafts` | read | `query?`, `maxResults?` (1 to 100, default 25), `pageToken?` | `GET /drafts?q=&maxResults=&pageToken=` |
| `create_html_draft` | write | `to?`, `cc?`, `bcc?` (`gmailRecipients`), `subject`, `bodyHtml`, `bodyText`, `attachments?` | `POST /drafts` with `{ message: { raw } }` |
| `create_reply_draft` | write | as `create_html_draft`, plus `threadId`, `inReplyTo` (`messageIdHeader`), `references?` (at most 20 `messageIdHeader`) | `POST /drafts` with `{ message: { raw, threadId } }` |
| `update_draft` | write | `draftId`, then every field of `create_reply_draft` with `threadId`, `inReplyTo` and `references` optional | `PUT /drafts/{draftId}` with `{ message: { raw, threadId? } }`; replaces the whole draft |
| `delete_draft` | write | `draftId` | `DELETE /drafts/{draftId}` |
| `send_draft` | write | `draftId` | `POST /drafts/send` with `{ id: draftId }` |
| `batch_modify` | write | `messageIds` (1 to 100 `gmailId`, unique), `addLabelIds?`, `removeLabelIds?` (each 0 to 20 `gmailId`, unique) | `POST /messages/batchModify` with `{ ids, addLabelIds?, removeLabelIds? }` |

Field masks for `get_thread`:

- `full`: `fields=id,historyId,messages(id,threadId,labelIds,snippet,internalDate,sizeEstimate,payload)`
- `summary`: the same request with body data left out, so the reply carries headers and
  the part tree only:
  `fields=id,historyId,messages(id,threadId,labelIds,snippet,internalDate,sizeEstimate,payload(mimeType,filename,headers,body(size,attachmentId),parts(mimeType,filename,body(size,attachmentId),parts(mimeType,filename,body(size,attachmentId)))))`

Reply fields the adapter reads:

| Action | `data` |
| --- | --- |
| `list_threads_query` | `{ threads?: [{ id, snippet, historyId }], nextPageToken?, resultSizeEstimate }` |
| `get_thread` | `{ id, historyId, messages: [{ id, threadId, labelIds, snippet, internalDate, sizeEstimate, payload: { mimeType, filename, headers: [{ name, value }], body: { size, data?, attachmentId? }, parts? } }] }`; `data` is base64url |
| `get_label` | `{ id, name, type, messagesTotal, messagesUnread, threadsTotal, threadsUnread }` |
| `list_drafts` | `{ drafts?: [{ id, message: { id, threadId } }], nextPageToken?, resultSizeEstimate }` |
| `create_html_draft`, `create_reply_draft`, `update_draft` | `{ id, message: { id, threadId, labelIds } }`; `id` is the draft id |
| `send_draft` | `{ id, threadId, labelIds }` |
| `delete_draft`, `batch_modify` | empty |

Rules:

- **MIME.** `gmail-mime.ts` builds the message. Without attachments:
  `multipart/alternative` with a `text/plain` part then a `text/html` part, both
  `charset=UTF-8` and base64. With attachments: `multipart/mixed` holding that
  alternative part, then one base64 part per file with
  `Content-Disposition: attachment`. Headers: `To`, `Cc`, `Bcc`, `Subject`,
  `In-Reply-To`, `References` (space separated), `MIME-Version: 1.0`. No `From` and no
  `Date`; the provider sets them. Names and the subject are RFC 2047 encoded when not
  ASCII. Every header value has CR and LF removed. The boundary is random per message.
- **Threading.** A reply needs `threadId`, a subject that matches the thread, and
  `In-Reply-To` plus `References`. The adapter gets them from `replyHeaders()`.
- **`update_draft` replaces everything**, attachments included. The adapter resends the
  content of every attachment it wants to keep.
- **`delete_draft`** removes an unsent draft for good. Draft ids are a separate id space,
  so this endpoint cannot touch received or sent mail.
- **`batch_modify` and trash (decision).** `TRASH` and `SPAM` are allowed in `addLabelIds`:
  moving to trash is recoverable and is a `write`. `DRAFT` and `SENT` are rejected in both
  lists (the provider owns them). At least one label is required, and a label may not be in
  both lists. There is no permanent delete action for messages, and none may be added.
- **`send_draft`** takes only a draft id. There is no action that sends arbitrary content,
  so what is sent is always what the owner saw in the stored draft.

## 6. `microsoft_outlook`

Base: `https://graph.microsoft.com/v1.0/me`. Every action here sends
`Prefer: IdType="ImmutableId"` so a message keeps its id when it moves between folders.
Actions that return a body send
`Prefer: IdType="ImmutableId", outlook.body-content-type="html"`. Folder ids are already
stable and are unaffected. A `folderId` is a `graphId`; the standard names `inbox`,
`drafts`, `sentitems`, `deleteditems`, `junkemail` and `archive` match that pattern and
are valid.

`SUMMARY` stands for
`$select=id,conversationId,internetMessageId,subject,bodyPreview,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,isRead,isDraft,flag,hasAttachments,parentFolderId`.
`FULL` is `SUMMARY` plus `bccRecipients,replyTo,body`.

| Action | Risk | Parameters | Provider request |
| --- | --- | --- | --- |
| `get_folder` | read | `folderId` | `GET /mailFolders/{folderId}?$select=id,displayName,parentFolderId,unreadItemCount,totalItemCount,childFolderCount` |
| `list_folder_messages` | read | `folderId`, `top?` (1 to 50, default 25), `skip?` (0 to 5000), `filter?` (`unread`, `flagged` or `attachments`) | `GET /mailFolders/{folderId}/messages?SUMMARY&$top=&$skip=&$orderby=receivedDateTime desc` plus a fixed `$filter` (below) |
| `search_messages` | read | `query` (1 to 512, no control characters), `folderId?`, `top?` (1 to 50, default 25), `skipToken?` (`pageToken` rule) | `GET /messages` or `/mailFolders/{folderId}/messages` with `SUMMARY&$search="…"&$top=&$skiptoken=` |
| `list_conversation` | read | `conversationId` (`graphId`), `top?` (1 to 50, default 25), `skip?` (0 to 500), `includeBody?` (default true) | `GET /messages?$filter=conversationId eq '{conversationId}'&$top=&$skip=` with `FULL`, or `SUMMARY` when `includeBody` is false |
| `get_message` | read | `messageId` | `GET /messages/{messageId}?FULL` |
| `list_attachments` | read | `messageId` | `GET /messages/{messageId}/attachments?$select=id,name,contentType,size,isInline&$top=50` |
| `get_attachment` | read | `messageId`, `attachmentId` (`graphId`) | `GET /messages/{messageId}/attachments/{attachmentId}` |
| `update_message` | write | `messageId`, `isRead?`, `flagged?` (at least one) | `PATCH /messages/{messageId}` with `{ isRead?, flag?: { flagStatus: "flagged" or "notFlagged" } }` |
| `move_message` | write | `messageId`, `destinationFolderId` | `POST /messages/{messageId}/move` with `{ destinationId }` |
| `create_html_draft` | write | `toRecipients?`, `ccRecipients?`, `bccRecipients?` (`graphRecipients`), `subject`, `bodyHtml` | `POST /messages` with `{ subject, body: { contentType: "HTML", content }, toRecipients, ccRecipients, bccRecipients }` |
| `create_reply_draft` | write | `messageId`, `replyAll` (boolean), `bodyHtml` | `POST /messages/{messageId}/createReply` or `/createReplyAll` with `{ message: { body: { contentType: "HTML", content } } }` |
| `update_draft` | write | `messageId`, and at least one of `subject`, `bodyHtml`, `toRecipients`, `ccRecipients`, `bccRecipients` | `PATCH /messages/{messageId}` with the given fields |
| `delete_draft` | write | `messageId` | `POST /messages/{messageId}/move` with `{ destinationId: "deleteditems" }` |
| `send_draft` | write | `messageId` | `POST /messages/{messageId}/send`, no content |
| `add_attachment` | write | `messageId`, `name` (`filename` rule), `contentType` (`mimeType` rule), `contentBase64` | `POST /messages/{messageId}/attachments` with `{ "@odata.type": "#microsoft.graph.fileAttachment", name, contentType, contentBytes }` |

Reply fields the adapter reads:

| Action | `data` |
| --- | --- |
| `get_folder` | `{ id, displayName, parentFolderId, unreadItemCount, totalItemCount, childFolderCount }` |
| `list_folder_messages`, `search_messages`, `list_conversation` | `{ value: [message], "@odata.nextLink"? }` |
| `get_message` and each `message` | `{ id, conversationId, internetMessageId, subject, bodyPreview, from: { emailAddress: { name, address } }, toRecipients, ccRecipients, bccRecipients, sentDateTime, receivedDateTime, isRead, isDraft, flag: { flagStatus }, hasAttachments, parentFolderId, body?: { contentType, content } }` |
| `list_attachments` | `{ value: [{ id, name, contentType, size, isInline }] }` |
| `get_attachment` | `{ id, name, contentType, size, contentBytes }`; `contentBytes` is standard base64 and is present only for file attachments |
| `update_message`, `move_message`, `create_html_draft`, `create_reply_draft`, `update_draft`, `delete_draft` | the message, reduced to `{ id, conversationId, parentFolderId, isRead, isDraft, flag }` where the provider applies `$select` |
| `add_attachment` | `{ id, name, contentType, size }` |
| `send_draft` | empty |

Rules:

- **`filter` is an enum, never provider filter text.** The provider needs the sort field in
  the filter first, so the fixed strings are:
  `unread` → `receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false`;
  `flagged` → `receivedDateTime ge 1900-01-01T00:00:00Z and flag/flagStatus eq 'flagged'`;
  `attachments` → `receivedDateTime ge 1900-01-01T00:00:00Z and hasAttachments eq true`.
- **`search_messages`.** The gateway wraps the query in double quotes and escapes `\` and
  `"` inside it. Search cannot be combined with `$orderby`, `$filter` or `$skip`. The next
  page is the `$skiptoken` value from `@odata.nextLink`, passed back as `skipToken`.
- **`list_conversation`** cannot be sorted by the provider; the adapter sorts by
  `sentDateTime`. `conversationId` matches `graphId`, so it cannot contain a quote.
- **`create_reply_draft`.** The provider fills in recipients, the `Re:` subject and the
  reply headers. `bodyHtml` is the complete body, quoted original included (the composer
  builds the quote from sanitised content). Change recipients afterwards with `update_draft`.
- **`update_draft`** only works on drafts; the provider refuses these fields on sent or
  received mail.
- **`delete_draft` is a move to Deleted Items (decision).** One proxied call cannot check
  that a message is a draft, and the provider's delete endpoint would remove any message.
  A move is recoverable whatever the id points at.
- **Trash** is `move_message` to `deleteditems`. There is no permanent delete action.
- **`get_attachment`** has no provider-side size limit. The adapter reads `size` from
  `list_attachments` first and refuses files over 1 MiB (`MAX_ATTACHMENT_READ_BYTES`).
- **Removing a stored attachment** from a draft is not an action. The adapter discards the
  draft and creates it again without the file.

## 7. Calendar

### `microsoft_outlook_calendar`

Base: `https://graph.microsoft.com/v1.0/me`. Writes go in a write map (section 1).

| Action | Risk | Parameters | Provider request |
| --- | --- | --- | --- |
| `create_event_with_attendees` | write | `calendarId` (`graphId`), `subject` (1 to 255), `startDateTime`, `endDateTime` (`wallTime`), `timeZone`, `isAllDay?`, `attendees?`, `body?` (plain text, at most 8192), `location?` (at most 255), `isOnlineMeeting?`, `recurrence?`, `reminderMinutesBeforeStart?` (0 to 40320) | `POST /calendars/{calendarId}/events` |
| `update_event` | write | `eventId` (`graphId`) and at least one of the fields above except `calendarId`; `startDateTime`, `endDateTime` and `timeZone` are given together or not at all | `PATCH /events/{eventId}` |
| `delete_event` | write | `eventId` | `DELETE /events/{eventId}` |
| `respond_event` | write | `eventId`, `response` (`accepted`, `declined` or `tentative`), `comment?` (at most 1024), `sendResponse` (boolean) | `POST /events/{eventId}/accept`, `/decline` or `/tentativelyAccept` with `{ comment?, sendResponse }` |
| `get_schedule` | read | `schedules` (1 to 20 `email`, unique), `startDateTime`, `endDateTime` (`utcTime`), `intervalMinutes?` (5 to 1440, default 30) | `POST /calendar/getSchedule` with header `Prefer: outlook.timezone="UTC"` |

- `attendees`: at most 100 of `{ address: email, name?, type?: "required" or "optional" }`,
  sent as `[{ emailAddress: { address, name }, type }]`.
- Times: `start: { dateTime: startDateTime, timeZone }`, same for `end`. End is after start
  and the event is at most 366 days long. With `isAllDay`, both times are `00:00:00`.
- `isOnlineMeeting: true` is sent as given, with no meeting provider named, so the
  calendar's own default applies.
- `recurrence` is validated strictly and passed through:
  `{ pattern: { type: "daily" | "weekly" | "absoluteMonthly" | "absoluteYearly", interval (1 to 99), daysOfWeek? (lower-case day names, unique), dayOfMonth? (1 to 31), month? (1 to 12) }, range: { type: "noEnd" | "endDate" | "numbered", startDate (date), endDate? (date), numberOfOccurrences? (1 to 730) } }`.
  In `update_event`, `recurrence: null` ends a series.
- `reminderMinutesBeforeStart` is sent with `isReminderOn: true`.
- `get_schedule` body:
  `{ schedules, startTime: { dateTime, timeZone: "UTC" }, endTime: { dateTime, timeZone: "UTC" }, availabilityViewInterval }`,
  with the trailing `Z` removed from each `dateTime`. The range is positive and at most 62 days.
- Replies. Create and update: the event
  (`id, subject, start, end, isAllDay, location, bodyPreview, attendees[{ emailAddress, type, status: { response } }], organizer, isOrganizer, responseStatus, onlineMeeting: { joinUrl }, seriesMasterId, type, recurrence, originalStartTimeZone`).
  `delete_event` and `respond_event`: empty. `get_schedule`:
  `{ value: [{ scheduleId, availabilityView, scheduleItems: [{ status, start: { dateTime, timeZone }, end }], error? }] }`
  where `status` is `free`, `tentative`, `busy`, `oof`, `workingElsewhere` or `unknown`.

**This provider notifies people on its own.** Creating or changing an event that has
attendees sends invitations or updates, and an organiser deleting a meeting sends
cancellations. There is no silent variant. The adapter therefore rejects
`createEvent`, `updateEvent` and `deleteEvent` with `not_supported` when the event has
attendees and `sendInvites` is false, and the action descriptions say that invitations
are sent.

### `google_calendar`

Base: `https://www.googleapis.com/calendar/v3`. Events path:
`/calendars/{calendarId or primary}/events`.

| Action | Risk | Parameters | Provider request |
| --- | --- | --- | --- |
| `create_event_with_attendees` | write | `calendarId?`, `summary` (1 to 1024), `start` + `end` (`offsetTime`) or `startDate` + `endDate` (`date`, end exclusive), `timeZone?`, `description?` (at most 8192), `location?` (at most 1024), `attendees?`, `conferenceRequestId?`, `recurrence?`, `reminders?`, `sendUpdates` (`all` or `none`) | `POST …/events?sendUpdates=&conferenceDataVersion=1` |
| `update_event_details` | write | `calendarId?`, `eventId`, `sendUpdates`, and at least one other field of the create action | `PATCH …/events/{eventId}?sendUpdates=&conferenceDataVersion=1` |
| `delete_event` | write | `calendarId?`, `eventId`, `sendUpdates` | `DELETE …/events/{eventId}?sendUpdates=` |
| `respond_event` | write | `calendarId?`, `eventId`, `selfEmail` (`email`), `response` (`accepted`, `declined` or `tentative`), `comment?` (at most 1024), `sendUpdates` | `PATCH …/events/{eventId}?sendUpdates=` with `{ attendeesOmitted: true, attendees: [{ email: selfEmail, responseStatus: response, comment? }] }` |
| `free_busy` | read | `items` (1 to 20 calendar ids or `email`, unique), `timeMin`, `timeMax` (`offsetTime`) | `POST /freeBusy` with `{ timeMin, timeMax, items: [{ id }] }` |

- Exactly one time pair on create: timed (`start: { dateTime, timeZone? }`) or all-day
  (`start: { date }`). End is after start. A timed event with `recurrence` requires `timeZone`.
- `attendees`: at most 100 of `{ email, displayName? (at most 128), optional? }`. In
  `update_event_details` the list replaces the stored one, and each item may carry
  `responseStatus` so existing answers are kept.
- `conferenceRequestId` (`/^[A-Za-z0-9-]{8,64}$/`): when present, the body gets
  `conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } }`.
  The adapter generates the id once per draft, so a retry does not create a second link.
- `recurrence`: 1 to 4 strings, each `/^RRULE:[A-Z0-9=;,]{1,480}$/`. The adapter builds
  them with `recurrenceToRRule()`.
- `reminders`: at most 5 of `{ method: "popup" | "email", minutes (0 to 40320) }`, sent as
  `reminders: { useDefault: false, overrides }`.
- `sendUpdates` is required on every write so that notifying people is always a stated
  choice: `all` when the owner confirmed, otherwise `none`.
- `free_busy`: the range is positive and at most 62 days.
- Replies. Create and update: the event
  (`id, status, summary, description, location, start: { dateTime | date, timeZone }, end, attendees[{ email, displayName, responseStatus, organizer, self, optional }], organizer, hangoutLink, conferenceData: { entryPoints: [{ entryPointType, uri }] }, recurrence, recurringEventId`).
  `delete_event`: empty. `respond_event`: the event. `free_busy`:
  `{ timeMin, timeMax, calendars: { [id]: { busy: [{ start, end }], errors?: [{ reason }] } } }`
  with times in UTC.
- `delete_event` moves the event to the calendar's trash, from which the owner can restore it.

## 8. `MANAGED_WRITE_ACTIONS` additions

Add exactly these 22 strings to the set in `packages/kernel/src/hooks.ts`:

```text
gmail/create_html_draft
gmail/create_reply_draft
gmail/update_draft
gmail/delete_draft
gmail/send_draft
gmail/batch_modify
microsoft_outlook/update_message
microsoft_outlook/move_message
microsoft_outlook/create_html_draft
microsoft_outlook/create_reply_draft
microsoft_outlook/update_draft
microsoft_outlook/delete_draft
microsoft_outlook/send_draft
microsoft_outlook/add_attachment
microsoft_outlook_calendar/create_event_with_attendees
microsoft_outlook_calendar/update_event
microsoft_outlook_calendar/delete_event
microsoft_outlook_calendar/respond_event
google_calendar/create_event_with_attendees
google_calendar/update_event_details
google_calendar/delete_event
google_calendar/respond_event
```

The 13 reads: `gmail/list_threads_query`, `gmail/get_thread`, `gmail/get_label`,
`gmail/list_drafts`, `microsoft_outlook/get_folder`, `microsoft_outlook/list_folder_messages`,
`microsoft_outlook/search_messages`, `microsoft_outlook/list_conversation`,
`microsoft_outlook/get_message`, `microsoft_outlook/list_attachments`,
`microsoft_outlook/get_attachment`, `microsoft_outlook_calendar/get_schedule`,
`google_calendar/free_busy`.

## 9. How the adapters use the actions

Existing actions the adapters keep using: `gmail/get_profile`, `gmail/list_labels`,
`gmail/get_message`, `gmail/get_attachment`, `gmail/search`, `microsoft_outlook/list_folders`,
`google_calendar/list_calendars`, `google_calendar/list_events`,
`microsoft_outlook_calendar/list_calendars`, `microsoft_outlook_calendar/list_events`,
`microsoft_outlook_calendar/get_event`.

| Contract method | Gmail | Outlook |
| --- | --- | --- |
| `listFolders` | `list_labels`, `get_label` for the inbox count; archive is a virtual folder | `list_folders`, `get_folder` for each standard name; starred is a virtual folder |
| `listThreads` | `list_threads_query`, then `get_thread` with `format: "summary"` per thread | `list_folder_messages`, grouped by `conversationId`; `search_messages` with `folderId` when there is a query |
| `getThread` | `get_thread`; over the cap: `summary`, then `get_message` per message | `list_conversation`; over the cap: `includeBody: false`, then `get_message` per message |
| `search` | `list_threads_query` with `query` | `search_messages` |
| `modifyThreads` | `batch_modify` with the message ids from the last thread summary, 100 per call | `update_message` and `move_message` per message |
| `saveDraft` | `create_html_draft`, `create_reply_draft` or `update_draft` | `create_html_draft` or `create_reply_draft`, then `update_draft` and `add_attachment` |
| `deleteDraft` | `delete_draft` | `delete_draft` |
| `sendDraft` | `send_draft` | `send_draft` |
| `getAttachment` | existing `get_attachment` (base64url, converted to base64) | `list_attachments` for the size, then `get_attachment` |
| `listSentTo` | `list_threads_query` with `in:sent to:{address}`, then `get_message` | `search_messages` with `to:{address}`, kept when `from` is the owner |

| Contract method | Google Calendar | Outlook Calendar |
| --- | --- | --- |
| `listCalendars`, `listEvents` | existing `list_calendars`, `list_events` | existing `list_calendars`, `list_events` |
| `createEvent` | `create_event_with_attendees` | `create_event_with_attendees` |
| `updateEvent` | `update_event_details` | `update_event` |
| `deleteEvent` | `delete_event` | `delete_event` |
| `respond` | `respond_event` | `respond_event` |
| `getFreeBusy` | `free_busy` | `get_schedule` |

Time conversions: the contract's instants always carry an offset. Outlook's `wallTime`
parameters are `wallTimeOf(instant)` with the draft's `timeZone`; `utcTime` parameters are
`toUtcInstant(instant)`. Outlook returns `{ dateTime, timeZone: "UTC" }` without an
offset; the adapter appends `Z` after trimming the fraction to milliseconds. All-day
events use `allDayDate()` and `allDayInstant()`.

## 10. To confirm against the live providers

These points come from provider documentation and could not be exercised here. Each
decides a detail above; check them with a connected test account before relying on them.

1. Gmail `batchModify` accepts `TRASH` and `SPAM` in `addLabelIds`.
2. Gmail `threads.list` needs `includeSpamTrash=true` to list by the `TRASH` or `SPAM` label.
3. Outlook applies `$select` to the message returned by `PATCH`, `move`, `POST /messages`
   and `createReply`. If it does not, the raised write reply cap in section 3 is required.
4. The combined `Prefer` header reaches the provider intact through the proxy.
5. `createReply` with `message.body` replaces the body instead of adding the quoted original.
6. `send` accepts the empty JSON body the proxy client sends for a `POST`.
7. `$search` on a folder's messages pages with `$skiptoken`.
8. `getSchedule` and `freeBusy` accept a 62 day range.
9. `attendeesOmitted: true` changes only the caller's own response on Google Calendar.
