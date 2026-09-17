# Electron Desktop Dock badge and Chat history

## Behavior and source of truth

The native Dock badge shows the number of unread canonical Chat conversations.
It uses the same `isChatUnread` helper as the history rail. Explicit server
`readState.unread=false` wins over an unacknowledged completion; completion state
is only a compatibility fallback when read state is absent. Reading every Chat
clears the badge. Legacy kernel threads and coding-agent attention do not count.
The badge does not mutate conversations, read markers, or owner data.

## Cross-surface matrix

| Surface | Shared Chat read state | Native Dock presentation |
| --- | --- | --- |
| Electron Desktop | Existing canonical read state and read actions | Numeric unread badge; clears at zero |
| Web Desktop | Unchanged | Not applicable: no Electron Dock API |
| Web Canvas | Unchanged | Not applicable: no Electron Dock API |
| Web Mobile | Unchanged | Not applicable: browser has no Electron Dock API |
| Native Mobile | Unchanged | Out of scope: native mobile notification APIs are separate |

This corrects the native presentation of existing unread state. It adds no new
Chat behavior, API, persistence, or mobile notification capability. Public feature
documentation needs no new API contract; this document records the bug fix and
operator validation flow.

## Security architecture and auth matrix

| Boundary | Existing authorization and validation |
| --- | --- |
| GET /api/chats | Trusted Desktop API bridge supplies the current credential; gateway derives owner/principal and scopes records. Typed client validates list parameters and responses. |
| GET /api/chats/events | Same authenticated bridge and owner-scoped SSE stream; versioned messages/read-state protocol and validated events. |
| badge:set IPC | Existing trusted renderer IPC validates bounded integer count before the main process calls Electron's badge API. |

The renderer holds no access token. The application effect is keyed by API,
runtime slot, auth generation, and sign-in status. Teardown invalidates pending
list results before another owner/runtime can contribute. No arbitrary URL or
filesystem path is accepted; no new endpoint, CORS rule, or permission is added.
Errors log only a diagnostic error class, never credentials or raw server details.

## Integration wiring

App mounts one NativeChatBadge independently of Chat windows. It creates a typed
canonical client and event source, then calls wireCanonicalChatBadge. That helper
loads the server-filtered unread list across all projects and applies isChatUnread
to the returned records. The client opts into versioned Chat read-state responses,
so the current server returns explicit read state rather than only completion
metadata. This matches the rail's Unread filter and ignores search/project UI filters.

Chat user-state events refresh the badge after existing read actions succeed.
Streamed run.message deltas are ignored; other lifecycle/read events trigger a
refresh. A 30-second fallback refresh recovers missed events or transient failures.
The helper invokes badge:set; the main process owns the actual Dock mutation.

## Failure modes and resource management

- A failed list read retains the last known count and retries on an event/timer.
- A failed native write remains retryable. Requested state is tracked before IPC
  acknowledgement, so teardown still sends zero when an earlier write is in flight.
- Sign-out/runtime change clears the badge and ignores late list responses.
- Refreshes are serialized with one pending-refresh flag; event bursts coalesce.
- Each refresh reads at most ten pages of 100 records. Its dedupe Set is bounded
  to 1,000 entries and discarded after refresh. Native counts are capped at 999.
- The shared SSE implementation owns bounded consumers and reconnect behavior.
  The stream has a five-minute transport timeout; list requests use the API
  client's existing bounded request timeout. No request can block indefinitely.
- Teardown clears the 30-second timer, unsubscribes the badge, and disposes SSE.
  The helper creates no temporary files or long-lived database connections.

## Validation

Focused tests cover pagination, explicit read state overriding unacknowledged
completion, native-write teardown, stale runtime responses, coalescing, retries,
application wiring, and exclusion of legacy task attention. Existing Chat rail
and controller tests protect the shared behavior. Electron typecheck/build and
an isolated built-Electron fixture validate native app.getBadgeCount() from 1 to 0.

Human Review: launch the fixture with CHAT_BADGE_HUMAN_REVIEW=1, open Chat, then
select “Dock badge review”; the native number disappears after reading. The
fixture seeds only a disposable synthetic credential and never opens browser auth.
Its temporary profile is removed and HTTP/SSE resources are drained on shutdown.
