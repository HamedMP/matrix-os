# Client Data Access

Browser and Electron renderer HTTP calls follow one layered convention:

```text
UI call site -> useQuery/useMutation -> feature-domain fetcher -> renderer transport
```

Use TanStack Query for cacheable gateway state. Keep Zustand for UI state,
runtime orchestration, and streaming transports. Do not force WebSockets,
streaming chat or terminal traffic, progress-sensitive transfers, redirects,
service-worker traffic, server-side calls, or Electron IPC through Query.

## Transports

- Desktop renderer HTTP uses `desktop/src/renderer/src/lib/api.ts`. It owns
  trusted-core authentication, runtime-slot routing, safe error mapping,
  bounded bodies, timeouts, and caller cancellation composition.
- Web shell HTTP uses `shell/src/api/http.ts`. It resolves the gateway URL at
  request time and provides the same timeout, cancellation, and safe-error
  guarantees.

Every Query fetcher passes its supplied `signal` to the transport. The
transport combines that signal with a mandatory timeout; cancellation must
never remove the timeout bound.

## Domain modules

Place fetchers, response parsing, and key factories in the owning domain.
Examples include `shell/src/api/plugins.ts` and
`desktop/src/renderer/src/features/settings/cron.api.ts`.

- Fetchers accept explicit inputs and optional request options; they do not
  read global component or Zustand state to infer cache identity.
- Keys must include all owner/runtime selectors. Desktop keys include platform
  host, authentication generation, and runtime slot.
- Mutations explicitly update or invalidate only affected keys after success.
  Optimistic writes require a rollback test.

## Runtime transitions

The desktop QueryClient is memory-only. It is cancelled and cleared before an
identity or runtime transition publishes the replacement scope. Query keys
still carry the same scope so a future ordering regression cannot display a
previous runtime's data.

## Tests

Write a focused failing test before adding a transport or domain operation.
Cover successful parsing, safe failures, cancellation propagation, key scope,
and mutation follow-up. Run the focused test suite plus renderer typechecks.
