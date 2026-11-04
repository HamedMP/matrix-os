# Control-plane contract

Tracking: ENG-418. All routes below are new, default disabled and hosted by the
trusted provisioning/control plane, never by unmerged code with operator secrets.
Use existing Hono auth, strict Zod4 boundary schemas and generic error mapping.

## Routes and authorization

| Route | Authentication/authorization | Public? |
| --- | --- | --- |
| POST `/vps/preview-pairs` | Existing timing-safe operator bearer; trusted workflow evidence resolves requester/eligible open PR; fixture IDs derive from approved server config | No |
| POST `/vps/preview-pairs/:pairId/actions` | Same operator authority; expected generation/revision; discriminated update/stop/reconcile payload | No |
| POST `/vps/preview-pairs/reconcile` | Same operator authority; bounded claim count and worker lifetime | No |
| GET `/api/preview-pairs/:pairId` | Real first-party Clerk session; requester, configured maintainer or actual leased fixture actor; current pair binding | No |
| GET `/api/preview-pairs/:pairId/manifest` | Same real actor check; live ready generation, current identity/routing/artifact/funding prerequisites; cache disabled | No |
| GET `/api/preview-pairs` | Real configured maintainer membership; bounded cursor/limit; only permitted reports | No |

Every mutating route, including future DELETE aliases, has a16KiB body-limit
middleware before parsing. Validate UUID params, integer cursors/limits and
strict action schemas at the boundary. Do not trust client identity headers,
caller-selected owners, provider types, addresses, origins or class flags.

## Start

Input: fixed repository, positive PR number, full selected SHA, trusted source/run
and artifact identifiers, and the requester resolved by the reviewed controller.
The server independently verifies same-repository open PR/current source and
allowed workflow provenance; config supplies fixture leases and approved origins.

Output202: pair ID, generation, state, expiry and safe report reference. An existing
active pair returns its canonical identity; a different requested head only makes
currency stale until explicit update. Capacity shortage yields a bounded queued
request, not one provisioned computer. Queue full returns429 safely.

## Actions

- `type=update`: expected generation/revision, full new candidate SHA, verified
  artifact provenance, `dataPolicy=reset`. Retire old capabilities and perform a
  clean generation transition; no implicit extension of hard expiry.
- `type=stop`: expected generation/revision. Invalidate manifest/new access and
  enqueue cleanup idempotently. A stale generation conflicts rather than stopping
  a newer run. Repeated stop of the same terminal run returns its current status.
- `type=reconcile`: expected generation and a bounded stage request; no arbitrary
  host command, credential, script body or retry-policy overrides.

## Reports and manifest readiness

Report fields: canonical pair/generation/PR/SHA, separate lifecycle/currency,
exact component sources, two role/computer observations, prerequisite booleans,
fixture/evidence expiry, product observations and allowlisted failed stage.
No provider error bodies, host env, tokens or customer identifiers/content.

The manifest is unavailable until both members have matching installed/running
candidate source, current expected ownership/org membership, empty machine access
lists, fresh collaboration control registration and supported exact desktop bytes.
Missing isolation or inference allowance is explicitly blocked/unavailable.
A report remains readable for diagnosis even if a product sharing scenario fails.

## Adapter and transaction contract

`prepareMembers(trx, canonicalPairGeneration)` prepares both existing VPS machine
and encrypted provisioning-job records in the current transaction; it returns
machine/job IDs and performs zero provider/network calls. Rollback leaves no
reserved fixture or first member behind. Existing per-owner quotas and account
admission apply on the same connection. No public generic pair-role provision API.

`dispatch(jobIds, claim)` runs after commit through the existing durable dispatcher.
`bindPreview(member, approvedAuthority, claim)` uses trusted operator host transport
and the existing guarded config/health/enrollment primitives; no forged actor session.
`observe(member)` reads actual source, owner/slot/control freshness and test funding.
`retire(member)` invalidates run access and logically retires the machine.
`proveAbsent(member)` verifies exact provider IDs and machine-label orphans are gone;
unknown/unavailable is not success. Existing deletion queue/backoff is reused.

Each external stage rechecks a current claim before an effect and records completion
with expected generation/revision/claim predicates. Never hold a DB transaction open
across provider calls. Shutdown cancels only local work and leaves durable recovery.

## Configuration, errors and limits

Activation requires explicit approved Preview identity issuer/secret, platform
origin/service account/signing/data bindings, bounded fixture inventory, internal
maintainer authority and existing test funding. The default is disabled. A flag
alone is not evidence that spec530 isolation exists; the trusted controller verifies
actual runtime/service bindings before any ready manifest is issued.

Fixed public errors:401 unauthorized,403 forbidden,404 unavailable report,409 stale
or conflicting generation,413 oversized input,429 bounded capacity/queue exhausted,
503 missing configuration or stage unavailable. Unexpected failures are logged with
safe context and normalized to503. Misconfiguration is never a fake404.

At most8 fixture sets and32 queued requests; reconcile pages <=16 pairs and <=60s
per invocation; claims expire after120s and are renewed before longer work. API
calls timeout10s, whole provisioning readiness30minutes, cleanup retry starts15s
and caps5minutes with visible pending status. No infinite in-memory queues/maps.
No route accepts an arbitrary URL: origins come from strict server-approved config
and exact verified candidate provenance; redirects must be rejected/revalidated.
