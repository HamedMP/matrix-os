# Company Brain integration caller

`createBrainIntegrationCaller` implements `BrainIntegrationCaller`, the one way brain source adapters call the
gateway's integration layer for an owner. Spec: `specs/558-company-brain-github-source/spec.md`.

## Scope

- Read actions only: the registry action must exist, have risk `read`, belong to a Pipedream service in
  `BRAIN_INTEGRATION_SERVICES`, and pass the registry's own parameter checks before any call. A missing action is
  `unavailable` (a gap in this server), never `invalid`; a call without a label needs the owner's only account.
- Two transports, chosen at construction. Remote (preferred when the internal URL and machine token are set): a
  customer gateway posts to the platform's internal `/read-call` route with its machine bearer, signed owner
  delegation and the read scope header. Local: the gateway holds the platform database and Pipedream client and runs
  `executeIntegrationAction` itself for the platform user whose Clerk id (or platform UUID) is the owner id (by the
  Settings connect flow's rule, `integrations/principal-identity.ts`: outside production the dev principal `default`
  reads the user stored under `MATRIX_CLERK_USER_ID`, else `MATRIX_HANDLE`; deps `env`), as a
  raw Pipedream proxy read (`pipedream.boundedProxy`): capped at 4 MiB while it is read, and cancelled by the call's
  signal. An action that cannot be read that way (no directApi GET or POST) is `unavailable`.
- Owns no tables. Its only state is a label cache (at most 256 entries, 5 minute lifetime) for remote calls that
  name no account label.

## Source of truth

- The owner's connections live in the platform (`listConnectedServices`, or the remote route's connection list);
  this folder never stores or caches a credential.
- The integration registry (`integrations/registry.ts`) decides which actions exist, their risk and their parameter
  rules; this folder only reads it (a test may pass its own registry).

## Public API

`index.ts`: `createBrainIntegrationCaller(deps)` with `BrainIntegrationCallerDeps` (`internalBaseUrl`,
`machineToken`, `db`, `pipedream`, and the test seams `fetch`, `timeoutMs`, `registry`, `now`); the constants
`BRAIN_INTEGRATION_CALL_TIMEOUT_MS`, `BRAIN_INTEGRATION_LABEL_CACHE_MAX`, `BRAIN_INTEGRATION_LABEL_CACHE_TTL_MS` and
`BRAIN_INTEGRATION_REMOTE_REPLY_MAX_BYTES`;
and the body readers `readBoundedJson`, `readJsonField` and `discardBody`, which the GitHub REST client shares.
`createBrainIntegrationAccounts(deps)` (`accounts.ts`): `configured` (whether either transport exists), `isConnected`
and `accounts`, the labels of the owner's active connections of one service read from the platform over the same two
transports (never a provider call; one bounded read, 10 s; an outage rejects with `BrainIntegrationAccountsError`,
never "not connected").
`createBrainLateBoundIntegrations()` (`late-bound.ts`): the caller and account lookup the brain gets at start, which
answer `unavailable` and "no account" until the gateway calls `bind(deps)` once platform integrations exist.
`configured()` is false before the bind and after a bind with no transport, so the integration kinds then read
`not_configured` (nothing the owner can fix in Settings), never `not_connected`.

## Auth and trust boundaries

- The owner id is the authenticated principal the caller passes in; it is checked against the delegation id rule
  before use. Locally it is mapped to its platform user first; an owner with no platform user is `not_connected`.
  Account labels are 1..100 characters with no control characters. The machine token goes only into the
  Authorization header and the delegation proof.
- Provider data is capped at 4 MiB of raw bytes on both transports (remotely by the `/read-call` route, before it
  JSON-encodes them); the remote reply may be up to `BRAIN_INTEGRATION_REMOTE_REPLY_MAX_BYTES` (six times that plus
  64 KiB, for JSON escaping and the wrapper), so a read that works locally also works remotely. Every call has a
  per-call timeout (15 s, bounded by the caller's signal); redirects are refused. Provider data is returned as
  untrusted JSON (a string for a `text/*` body) for the adapter's own schema.
- The platform's `/read-call` route runs the brain's registry reads (`isBrainReadAction` in
  `integrations/registry-brain.ts`) as byte-capped raw reads (`BRAIN_INTEGRATION_RESPONSE_MAX_BYTES`) that the
  calling gateway's disconnect cancels, so an oversized answer is refused there (502) instead of being buffered and
  sent on; other reads keep the SDK path.
- Outcomes are values (`ok`, `not_connected`, `unauthorized`, `rate_limited`, `not_found`, `invalid`,
  `unavailable`); provider and platform text never leaves this folder, and failures are logged by error name only.
  The call rejects only when the caller's signal aborts.
- Remote: a 401 from the platform route means it refused this gateway's machine credentials, so it is `unavailable`
  (logged as `remote auth rejected`), never `unauthorized`; the provider's own answer comes only as a 502 naming it
  (`upstream`: `unauthorized` or `not_found`). Local: GitHub's 403 is a rate limit when it says so (headers, or a
  message naming a rate limit), else `unauthorized`.

## Concurrency and recovery

- Stateless apart from the bounded label cache (oldest entry evicted at the cap, entries expire after 5 minutes).
- Every call is bounded by `boundedOperation` with the per-call timeout and the caller's signal; a timed-out or
  failed call is a value, never a hang. There are no retries: the sources runner decides what happens next from the
  outcome (`rate_limited` carries `retryAfterSeconds`).

## Tests

`pnpm exec vitest run tests/gateway/brain-integration-caller*.test.ts` (fake fetch from
`tests/gateway/helpers/brain-integration-fetch.ts`, fake platform database and Pipedream client; no network).
