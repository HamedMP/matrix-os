# Exact-runtime funded acceptance

An isolated Platform service tag sharing the normal database and control key is
not sufficient to limit acceptance to a disposable runtime. This optional mode
adds an admission restriction to existing funded control-plane operations. It
does not enable funding, grant credit, change authentication, or authorize a paid
test or customer rollout.

## Configuration and lifetime

`MATRIX_FUNDED_AI_ACCEPTANCE_SCOPE` is a **new optional deployment setting**. Its
value is a strict JSON object containing `ownerId`, `machineId` (UUID),
`runtimeSlot` (the existing runtime-slot schema), `runtimeTokenEpoch` (positive
safe integer from the current machine row), and `validThrough` (canonical UTC
timestamp including milliseconds). Unknown fields and oversized values above
2,048 UTF-8 bytes are rejected. Configuration is copied and frozen at startup.
The tuple is immutable for that service process; no request can supply or change
the acceptance scope.

The initial future deadline must be at most one hour away. A well-formed expired
scope remains active after a restart and rejects new work; it must never become
an absent scope. Existing normal behavior applies when the setting is absent.
Use a separately coordinated isolated deployment, not a shared default tag, to
install this setting. Owner and machine identifiers belong in private operator
records, not public examples or issue attachments.

The acceptance deployment requires these existing settings:

- `MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED=true`.
- `PLATFORM_BACKGROUND_WORKERS_ENABLED=false` explicitly.
- `MATRIX_FUNDED_AI_RUNTIME_ENABLED`, `MATRIX_FUNDED_HOST_CONFIG_ENABLED`,
  `MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED`, and
  `AI_FUNDED_PROMOTIONAL_GRANT_ENABLED` absent or explicitly `false`.

Contradictory or misspelled feature settings fail startup. Acceptance composition
omits funded operator routes and the Relay global cleanup endpoint. Repository
guards also reject grant/policy writes, execution-release support writes, manual
Jev reconciliation, and global cleanup. Normal route composition remains intact
when the scope is absent. No new endpoint, credential format, role, migration,
grant path, or policy mutation is introduced.

## Authentication and admission

Existing authentication always remains required:

| Existing operation | Authentication | Acceptance behavior |
| --- | --- | --- |
| Runtime credential, funding summary, route readiness | Existing authenticated runtime-machine lookup | Exact owner/machine/slot, current epoch, running/authorized/nondeleted machine, unexpired scope |
| Relay policy check and authorization | Existing Relay control bearer plus stored funded credential checks | Additional exact scope restriction for new work |
| Relay reservation start | Existing Relay control bearer and exact reservation/token lookup | Current machine guard before a new reserved dispatch |
| Settle, finalize, release, revoke | Existing authentication and historical reservation/token/identity fences | Existing closure remains reachable after acceptance expiry |

Credential issuance, including the fixed Jev readiness lease, uses the exact
machine predicate in its SQL statement and holds the machine row through the
write. Authorization uses the existing account-deletion admission and owner
advisory lock, then locks the current machine before dependent mutable rows.
New reservation starts locate the existing reservation, acquire its owner lock,
lock the machine, and recheck the locked reservation before changing state.
Funding-summary balancing also checks the locked machine before writes.
Acceptance transactions check the absolute deadline again before commit using
both application time and PostgreSQL `clock_timestamp()`; failure rolls back
new writes. This preserves the existing transaction and lock order rather than
claiming concurrency safety from a detached read.

Exact historical authorization and in-flight start replays retain their existing
payload, credential, policy, and closure fences. Scope expiry alone does not
discard them. Existing settlement/finalization/release/revocation semantics and
unknown liabilities remain unchanged. A replay does not authorize a new
reservation or restart a closed one.

## Readiness and resource bounds

All model probes receive validated internal runtime identity and current epoch.
The scope guard runs before cache lookup, in-flight joining, budget counters,
credential issuance, or outbound readiness HTTP. It runs again after waits and
before returning a positive observation. Missing context, wrong epoch, stopped
machine, expired scope, or a failed identity read yields unavailable.

Acceptance identity reads are limited to eight pending operations per service;
each caller waits at most 1,500 ms or its shorter existing deadline. Abandoned
reads retain a slot until their underlying query settles. Existing model cache,
waiter caps, timeout signals, probe budget and credential cleanup remain in
force. Ordinary model keys and lifecycle are preserved when the scope is absent.

These readiness checks are observations. No database row lock is held during
HTTP, and an epoch can change after the last observation. This mode does **not**
provide atomic latest-epoch exclusion across provider HTTP. Direct authorization
and new start still apply the current-row admission guard under their own write
transactions.

## Validation and removal

Tests must cover an already-funded sibling runtime being refused, exact current
issuance/admission, startup contradictions, epoch/state changes, expiry during
waits, generic model readiness before cache/budget/HTTP, and preserved historical
closure/replays. Independent local PostgreSQL pools verify conflicting machine
writes and deadline expiry while requests are actually blocked on row locks.
Local tests and mocked readiness responses do not prove provider billing or
Electron Desktop acceptance.

After separately authorized Preview VPS and Electron Desktop validation, keep
the isolated scope present while outstanding closure or audit work remains.
Remove the temporary isolated deployment/configuration only through coordinated
operator cleanup after recording exact revisions and obligations. Removing the
setting while continuing to route requests to that service restores normal
admission and therefore requires separate rollout authorization. This capability
is neither a durable campaign limit nor a dollar spending cap, and proves no
customer or general-availability acceptance.

The implementation deliverables include this public-safe specification and a
separate documentation PR in `FinnaAI/matrix-os-site` under `content/docs/`, owned
by the incident coordinator.
