# Operating a DevStack readiness wallet

The opt-in source Platform and Relay must share one operator wallet for paid model
readiness, separate from ordinary customer Chat and owner-funded Jev. Use this
procedure after the [monetary contract](../../specs/639-devstack/operator-probe-budget.md)
and synthetic PostgreSQL + stub-provider qualification have been reviewed. It does
not qualify live funding, native x64, a modified Shell, or shared Linux.

## Identify the target and exposure

1. Independently verify the intended Dev computer, named profile and explicit
   runtime route. Record the trusted operator source SHA, lockfile digest,
   source Platform/Relay/CLI versions and ordinary Chat's pinned Relay version.
   Confirm the dedicated PostgreSQL DB, role and schema, free loopback ports,
   namespace, ownership and lifecycle. Keep the authority outside installed
   services. On each peer record routing, owner-data identity, balances and service
   versions for comparison after the experiment.
2. Refresh the private usage audit. Record coverage and individual historical
   probe cost as **unknown**. A conservative reserve is not measured cost.
   Disable and drain all legacy readiness admissions, including background,
   admin and cache-miss callers; account for live holds and delayed settlement.
   Preserve the old serving Relay for ordinary Sonnet Chat. If isolation cannot
   be established, keep spending disabled.
3. For the agreed pilot, reduce old-pilot effective exposure from $8.40 to
   $2.25 **before** initializing a wallet. Confirm existing spend and in-flight
   work fit that limit. Keep three $0.50 customer caps: $3.75 customer exposure
   plus $6.25 operator allocation = $10. The operator allocation includes the
   $1 historical reserve, leaving $5.25 prospective availability. No grants on
   restart, refill, balance reset, or historical cost reclassification. Any
   later Stage 2 customer allocation must first come out of the old pilot.

## Start and initialize

From the reviewed, trusted checkout use Node 24 with dependencies installed
from the reviewed lockfile (including the built observability workspace).
Keep private JSON files outside source projections, canonical absolute paths,
operator-owned, mode 0600, each in an operator-owned 0700 directory. Do not
place credentials in command arguments, shell history, source, logs, or
experimental source processes. The filenames below are placeholders.

- Authority file: `databaseUrl`, `expectedDatabase`, `expectedRole`,
  `expectedSchema`, `budgetId`, `token` (separate authority credential),
  `hostname` (literal loopback), `port` (unprivileged fixed listener).
  The PostgreSQL URL must name its role, database and literal loopback host.
  To set a dedicated schema, its only optional URL parameter is `options`
  with encoded value `-c search_path=<expectedSchema>`. The effective path
  must contain exactly the expected schema (apart from implicit system schemas).
  Use a dedicated least-privileged role and database, never a host/Platform DB.
- Allocation plan: the same `budgetId`, `revision`, reviewed `source` SHA,
  `expiresAt` (UTC before the monthly reset and certificate expiry),
  `allocationMicrousd: 6250000`, `historicalReserveMicrousd: 1000000`,
  `historicalUnpriced: true`, the explicit canonical model IDs in `models`,
  and `pricingEnv` with the reviewed Relay pricing version, reviewed-at and
  valid-through environment entries for these models. Bootstrap uses the
  source Relay's own fixed-body, catalog and conservative quote helpers.
  The wallet cannot outlive any included pricing review.
- Doctor file: `authorityUrl`, `token` (authority token, **never** owner bearer),
  `budgetId`, and `expectedBinding` copied from an independent trusted direct
  inspection. Preserve the binding in a private operator receipt.

Start the authority as an owned foreground process on Dev. It checks placement
before applying its own additive migration and **does not create a wallet**.
Use a second trusted terminal for inspection and the one explicit initialization
after exposure approval. Stop with SIGTERM to that exact owned process and await
its exit. Restart with the same file and DB; verify the binding and counters.

```sh
node --import tsx scripts/operator-probe-wallet.ts serve /private/authority.json
node --import tsx scripts/operator-probe-wallet.ts inspect /private/authority.json
node --import tsx scripts/operator-probe-wallet.ts initialize /private/authority.json /private/plan.json
node --import tsx scripts/operator-probe-wallet.ts inspect /private/authority.json
```

Direct inspection of an unmigrated namespace fails without creating tables;
a migrated empty namespace reports `initialized: false`. Initialization under
a different ID in the same dedicated namespace or a changed plan is rejected.
Exact replay during plan validity retains the original binding, holds and
settlements. Never recover a wallet by deleting/recreating it or selecting
a new database, schema or ID.

## Verify the inward forward before admitting paid requests

Use the reviewed CLI from a **trusted** operator process with the named profile's
existing authenticated session. Supply the explicit Dev gateway URL including
its VM and runtime prefix; verify that URL independently. For example, with
non-secret selectors and port numbers in shell variables:

```sh
: "${DEV_PROFILE:?}" "${DEV_GATEWAY:?}" "${LOCAL_PORT:?}" "${AUTHORITY_PORT:?}"
node packages/sync-client/bin/matrix.mjs port forward \
  "${LOCAL_PORT}:127.0.0.1:${AUTHORITY_PORT}" --profile "$DEV_PROFILE" --gateway "$DEV_GATEWAY"
node --import tsx scripts/operator-probe-wallet.ts doctor /private/doctor.json
```

Require nonempty selectors before executing. A ready listener alone does not
prove target identity. Run the authenticated read-only doctor from **each
actual caller network namespace** and compare its binding and counters to
Dev direct inspection. Plain HTTP for the authority is permitted only on
literal loopback; use verified HTTPS for a non-loopback service origin.
Mac loopback and container loopback are different: arrange an isolated,
trusted fixed-destination inward forward or authenticated HTTPS bridge
reachable by that namespace before enabling probes. Never expose an arbitrary
forward proxy or mount profile credentials into experimental code. There is
no reverse Matrix CLI forward in this procedure.

On the source Platform configure the dedicated
`MATRIX_FUNDED_AI_OPERATOR_PROBE_AUTHORITY_URL`, authority token, budget ID,
and source probe Relay URL (the latter three names use the same
`MATRIX_FUNDED_AI_OPERATOR_PROBE_` prefix and suffixes `AUTHORITY_TOKEN`,
`BUDGET_ID`, and `RELAY_URL`). Do not omit the authority URL: that selects
local Platform DB placement. On the source probe Relay enable
`MATRIX_AI_RELAY_OPERATOR_PROBE_BUDGET_REQUIRED` and point its authenticated
Platform callback at the intended source Platform. Keep ordinary Chat's
`MATRIX_FUNDED_AI_RELAY_URL` and owner-funded Jev independent. Record config
**names**, hashes of reviewed non-secret artifacts and effective versions;
never record secret values or copy a shared owner token into these components.

Run only separately approved bounded positive checks, capturing the exact
version, probe UUID, committed receipt, held and settled deltas, and independent
customer Chat charge. Synthetic providers only prove the protocol. Unknown
settlement keeps the maximum hold. A missing receipt, over-bound report,
wrong binding, changed peer or unverified transport blocks further paid work.
Quiesce admissions and allow the monetary Platform's 30-second drain before
its 40-second hard stop. Preserve the database, private receipts and unresolved
holds; compare all local peers and installed Dev state against the baseline.
