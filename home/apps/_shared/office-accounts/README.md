# office-accounts

Shared account and provider layer for the Calendar app
(spec: `specs/2710-office-mail-suite/spec.md`).

The app never calls an integration action directly. It calls a `CalendarProvider`, and
one adapter per provider turns that into `window.MatrixOS.service(...)` calls. The
contracts live in `types/`; the adapter in `calendar/` calls the `google_calendar`
actions defined in `packages/gateway/src/integrations`.

Google Calendar is the only provider today. A connected account of any other calendar
service is ignored by `listCalendarAccounts`, so the app shows its "connect a calendar"
state for it.

## `types/`

| File | Contents |
| --- | --- |
| `calendar.ts` | `CalendarAccount`, `CalendarInfo`, `CalendarEvent`, `EventDraft`, `Recurrence`, `BusyBlock`, `CalendarProvider`, plus helpers |
| `time.ts` | `IsoInstant` and the time rule |
| `errors.ts` | `ProviderError` and its codes |
| `addresses.ts` | `isValidMailAddress`, `normalizeMailAddress`, `sameMailAddress` |
| `index.ts` | re-exports all four |

`calendar.ts` also re-exports `time.ts` and `errors.ts`, so one import is enough:

```ts
import { ProviderError, type CalendarProvider, type CalendarEvent } from "../../_shared/office-accounts/types/calendar";
```

The files have no runtime dependencies and import nothing outside this folder.
Tests: `tests/default-apps/office-accounts-types.test.ts`.

## `calendar/`

```ts
const accounts = await listCalendarAccounts();
const provider = createCalendarProvider(accounts[0]);
```

Tests: `tests/default-apps/office-accounts/calendar/`.

## Rules the contracts encode

1. **Time.** Every instant is an ISO 8601 date-time with seconds and an offset (`Z` or
   `±HH:MM`). Compare by the moment, not by the text. A time the owner picked becomes an
   instant through `instantFromWallTime(wallTime, timeZone)`. All-day events are calendar
   dates: midnight UTC, exclusive end, read with `allDayDate`. The full rule is at the top
   of `types/time.ts`.
2. **Untrusted content.** Everything from a calendar is untrusted: titles, descriptions,
   locations, names and join links. Render text as text and open a join link only when it
   is `https:`.
3. **Owner control.** Every `CalendarProvider` write runs only from an explicit owner
   click or an owner-approved agent tool call. Adapters never retry a write on their own.
   Calendar writes take `{ sendInvites }`; when it is false and the provider cannot stay
   silent, the adapter rejects with `not_supported`.
4. **Errors.** Adapters throw `ProviderError` with one of five codes: `not_connected`,
   `multiple_accounts`, `rate_limited`, `not_supported`, `failed`. Messages are fixed
   sentences; provider and gateway error text is never shown. Use `toProviderError` in a
   `catch` and `providerErrorCodeForStatus` for a failed bridge call.

## Things an adapter must get right

- **Ids.** Account ids come from `calendarAccountId`. A `CalendarEvent.id` is built with
  `composeEventId(calendarId, providerEventId)` so no method needs a separate calendar id.
- **Free-busy.** A person whose availability cannot be read, or whose reply is larger
  than the adapter reads, gets one block with `status: "unknown"` covering the whole
  range, so it never looks like free time. A list longer than the adapter reads is
  refused, never returned in part.
- **Cached events.** The event cache is bounded and evicts. A write that needs the
  stored event (a guest list that must keep booked rooms, a repeat rule, a partial time
  change) reads it with `get_event` when the cache no longer holds it.
- **Owner address.** `CalendarAccount.address` is the real address or empty, never an
  account label. A reply uses the attendee entry Google marks as the owner's.
- **Limits.** `MAX_EVENT_ATTENDEES` (100), `MAX_FREE_BUSY_ADDRESSES` (20),
  `MAX_EVENT_RANGE_DAYS` (62).
