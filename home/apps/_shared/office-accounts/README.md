# office-accounts

Shared account and provider layer for the Mail and Calendar apps
(spec: `specs/2710-office-mail-suite/spec.md`).

The apps never call an integration action directly. They call a `MailProvider` or a
`CalendarProvider`, and one adapter per provider turns that into
`window.MatrixOS.service(...)` calls. The contracts live in `types/`; the actions the
adapters call are listed in `specs/2710-office-mail-suite/integration-actions.md`.

## `types/`

| File | Contents |
| --- | --- |
| `mail.ts` | `MailAccount`, `MailFolder`, `MailAddress`, `ThreadSummary`, `MailMessage`, `MailThread`, `Draft`, `Page<T>`, `ThreadChange`, `MailProvider`, plus helpers |
| `calendar.ts` | `CalendarAccount`, `CalendarInfo`, `CalendarEvent`, `EventDraft`, `Recurrence`, `BusyBlock`, `CalendarProvider`, plus helpers |
| `time.ts` | `IsoInstant` and the time rule |
| `errors.ts` | `ProviderError` and its codes |
| `index.ts` | re-exports all four |

`mail.ts` and `calendar.ts` also re-export `time.ts` and `errors.ts`, so one import is enough:

```ts
import { ProviderError, type MailProvider, type ThreadSummary } from "../../_shared/office-accounts/types/mail";
```

The files have no runtime dependencies and import nothing outside this folder.
Tests: `tests/default-apps/office-accounts-types.test.ts`.

## Rules the contracts encode

1. **Time.** Every instant is an ISO 8601 date-time with seconds and an offset (`Z` or
   `±HH:MM`). Compare by the moment, not by the text. A time the owner picked becomes an
   instant through `instantFromWallTime(wallTime, timeZone)`. All-day events are calendar
   dates: midnight UTC, exclusive end, read with `allDayDate`. The full rule is at the top
   of `types/time.ts`.
2. **Untrusted content.** Everything from a mailbox or a calendar is untrusted.
   `MailMessage.bodyHtml` has the type `UntrustedHtml`: only the mail HTML sanitiser may
   consume it. A `Draft.bodyHtml` is owner-authored; quoted provider content is sanitised
   before it goes in.
3. **Owner control.** `MailProvider.sendDraft` and every `CalendarProvider` write run only
   from an explicit owner click or an owner-approved agent tool call. Adapters never retry
   a write on their own. Calendar writes take `{ sendInvites }`; when it is false and the
   provider cannot stay silent, the adapter rejects with `not_supported`.
4. **Errors.** Adapters throw `ProviderError` with one of five codes: `not_connected`,
   `multiple_accounts`, `rate_limited`, `not_supported`, `failed`. Messages are fixed
   sentences; provider and gateway error text is never shown. Use `toProviderError` in a
   `catch` and `providerErrorCodeForStatus` for a failed bridge call.
5. **Nothing is deleted for good.** Trash is a move (`trashChange`). No contract method
   deletes mail permanently.

## Things an adapter must get right

- **Folders.** Return at most one folder per role (`inbox`, `sent`, `drafts`, `archive`,
  `trash`, `spam`, `starred`); everything else is `custom`. Mark a folder the adapter
  computes as `virtual` (Gmail archive, Outlook starred). Virtual ids are never accepted in
  a `ThreadChange`.
- **Thread changes.** Gmail applies `addFolders` and `removeFolders` as label changes.
  Outlook moves the thread to `addFolders[0]`. Flagging is `flagged`, reading is `read`.
- **Ids.** Account ids come from `mailAccountId` and `calendarAccountId`. A
  `CalendarEvent.id` is built with `composeEventId(calendarId, providerEventId)` so no
  method needs a separate calendar id.
- **Drafts.** `saveDraft` creates when `id` is absent and replaces otherwise. New
  attachments carry `contentBase64` (standard base64); stored ones carry `id`. Check
  `draftIssues(draft)` before saving: a draft must fit in `MAX_DRAFT_REQUEST_BYTES`
  (60,000 bytes, counted as the shell bridge counts its escaped request frame,
  with room kept for reply threading) because a request is limited to 64 KiB.
- **Free-busy.** A person whose availability cannot be read gets one block with
  `status: "unknown"` covering the whole range, so it never looks like free time.
- **Limits.** `MAIL_PAGE_MAX` (50), `MAX_MODIFY_THREADS` (100), `MAX_SENT_SAMPLES` (20),
  `MAX_EVENT_ATTENDEES` (100), `MAX_FREE_BUSY_ADDRESSES` (20), `MAX_EVENT_RANGE_DAYS` (62).
