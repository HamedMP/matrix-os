# Symphony fleet polling storm: rollout and compatibility

## Incident and scope

On 2026-09-14 the reported 81 runtimes sent roughly 950 failing calls/minute,
phase-aligned at five seconds. Bundled Symphony fell back to the integration
bridge and called the unrestricted `linear/graphql` action removed by #1410
(`fd1c253a`). Error envelopes discarded HTTP status, and automatic VPS activation
plus a default project made unconfigured runtimes poll too. Cloud Run concurrency
and pending queues saturated while CPU and memory remained below exhaustion;
capacity gaps broke static asset loads. Increasing capacity alone cannot fix it.

This PR changes code and documents an operator rollout; it does not authorize
production changes. Keep the temporary matrix-platform **minimum 3 / maximum 30**.
Do not restart the incident-mitigated customer Symphony service except with the
corrected bundle; identify that host from the private operator incident record.
Never log into customer Matrix accounts for validation.

## Deploy in this order, after explicit approval

1. Inventory VPS bundle versions, Symphony service activity, custom workflow
   selection and whether a Linear project is explicitly configured. Record only
   booleans/version/activity, never credential values or workflow contents.
   An owner with an explicit credential retains the old `matrix-os` default.
   Bridge-only owners relying on that implicit project need it explicitly configured. Preserve intentionally running users and custom files.
2. Deploy the platform/app-shell service from the reviewed commit first. The new
   host bundle alone cannot update this Cloud Run boundary. Verify an authenticated
   legacy `linear/graphql` request returns 410 `unsupported_contract` without any
   owner lookup, account discovery or provider call. The action remains absent
   from the registry. New typed calls must use the authenticated owner's account.
3. Keep 3/30 scaling while legacy clients remain. Old binaries ignore 410 and
   Retry-After, so **a server response cannot make those binaries stop polling**.
   The pre-database tombstone makes these calls cheap and prevents downstream
   amplification; do not mistake it for completed fleet migration. The general
   admission guard independently caps current integration traffic at eight
   in-flight calls per instance, 10 calls/sec with burst 20, and two calls/sec per
   authenticated handle with burst 10. It returns immediate 429/Retry-After: 60,
   never queues work or sleeps in a request. Its handle cache expires after a
   minute and is capped at 2048. These are per-instance bulkheads, not global
   quotas. Watch aggregate traffic as Cloud Run scales.
4. Build and publish the reviewed immutable VPS-native host bundle using the
   normal release pipeline. Deploy the exact version to a disposable test VPS,
   then small batches of the fleet through platform `POST /vps/deploy`. Do not
   SSH-copy bundles, roll customer Docker containers, replace owner data, or
   deploy a shell with the example Clerk key. Existing sync agents install the
   corrected wrapper before starting it: unconfigured services exit successfully,
   and saved inactive service state is honored. The corrected updater preserves
   activity and enablement rather than enabling everyone.
5. For offline/failed-upgrade runtimes, leave the platform protection and 3/30 in
   place. If an authorized operator needs to drain legacy traffic before those
   hosts can update, stop only inventoried unconfigured legacy Symphony services
   through host operations; do not blanket-stop configured owners. Track every
   unpatched caller until upgraded or explicitly disabled. No server-side payload
   filter, fake success response or arbitrary GraphQL fallback is a replacement.
6. Verify `/opt/matrix/app/BUNDLE_VERSION`, `/opt/matrix/release.json`, gateway,
   shell and sync-agent health on every upgraded VPS. Verify stopped Symphony
   stays stopped, configured Symphony reads its project and updates one test
   workpad/state through the typed bridge, and owner files remain untouched.
   Exercise 400/401/403/404/422 suspension, 429/503 backoff, disconnect/reconnect
   followed by owner restart, and restart 100 simulated runtimes together.
   Ask whether to delete the disposable test VPS after validation.

## When temporary capacity can be reverted

Only after every active legacy caller is upgraded or explicitly disabled, observe
at least 60 minutes (covering multiple maximum backoff cycles) with:

- zero legacy `linear/graphql` calls from the inventoried fleet;
- bounded, desynchronized typed polls and no recurring per-handle 4xx loops;
- no sustained integration admission limiting or request queue growth;
- no “no available instance” 500s or static JavaScript/ChunkLoadError regression;
- configured-owner workpad/state smoke tests and host health passing.

Then obtain explicit operator approval, reduce scaling toward the recorded
pre-incident settings in steps, and observe another 60 minutes. Do not invent
old min/max values or automatically change them in this PR. Keep the tombstone
and admission guard after scale-down. If queues or 500s recur, retain/restore
3/30 while investigating; never re-enable arbitrary GraphQL.

## Invariants and rollback

Owner workflow/env files and platform connection records remain canonical. The
per-process circuit is deliberately volatile: a service restart permits a new
jittered probe; systemd restarts are limited to three in ten minutes with a
60-second delay. Configuration changes reopen the circuit, while clicking refresh
cannot. There is one monitored request lease; caller death releases it. No network
operation holds a database transaction or a database lock. No new persistence is
introduced. Repeated comment mutations are not automatically retried by Req;
an interrupted mutation may have succeeded, so workers should inspect the workpad
before retrying. No new user-account secrets are copied to VPSes.

Auth remains the per-handle HMAC bearer before admission, followed by the existing
owner lookup. Invalid handles/tokens fail closed. Body size is capped at 64 KiB;
operation schemas reject unknown keys and bound strings, IDs and pages to 50.
Only fixed GraphQL documents go upstream. Transient provider failure never falls
through to account discovery for Symphony. The circuit opens on permanent configuration/authentication/contract failure.
Item-level GraphQL errors suppress only their identical request for 15 minutes
(cache cap 128), so stale comments cannot suspend unrelated polling. Structured
`RATELIMITED` errors, including HTTP 400, back off as transient failures. Typed
worker parameters are validated locally as well as at the platform boundary.
The orchestrator and request gate share one randomized startup deadline.

Prefer rolling forward. A rollback to a pre-fix Symphony binary reintroduces the
storm: keep platform protection and 3/30, and explicitly stop unconfigured legacy
services after an approved rollback. Preserve the saved service activity in the
update transaction. Global distributed quotas, push-based Linear subscriptions,
and migration of owner-custom arbitrary GraphQL scripts are outside this PR.

## Reproducible validation

- `cd packages/symphony-elixir && mix deps.get --check-locked && mix test --no-start`
- `pnpm exec vitest run tests/integrations/symphony-*.test.ts tests/platform/internal-integration-guard.test.ts tests/platform/internal-integration-routes.test.ts tests/deploy/customer-vps/symphony-*.test.ts`
- `bun run typecheck`, `bun run check:patterns`, and `bun run test`

The deterministic fleet test spreads 100 initial requests across at least 50
one-second buckets and caps persistent transient failures at 1500 calls/hour
across the simulated fleet. The shared-gate test suppresses 1000 attempts after
one permanent response. Boundary tests send 1200 legacy calls with zero downstream
calls and admit at most eight of a 100-runtime burst. These prove code-level rate
bounds, not measured Cloud Run capacity; live rollout metrics remain mandatory.
