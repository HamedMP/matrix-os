# Control-plane contract

Tracking: ENG-418. All routes below are new, default disabled and hosted by the
trusted provisioning/control plane, never by unmerged code with operator secrets.
Use existing Hono auth, strict Zod4 boundary schemas and generic error mapping.

## Routes and authorization

| Route | Authentication/authorization | Public? |
| --- | --- | --- |
| POST `/vps/preview-pairs` | Existing timing-safe operator bearer; trusted workflow evidence resolves requester/eligible open PR; fixture IDs derive from approved server config | No |
| POST `/vps/preview-pairs/requests` | Same operator; current reviewed-controller receipt, current maintainer/test membership, actual target isolation and requested same-repo head; profile derives only from source config | No |
| POST `/vps/preview-pairs/requests/:pairId/actions` | Same operator; strict stop action and exact recorded controller run/generation; cannot stop an adopted pair | No |
| POST `/vps/preview-pairs/requests/:pairId/publication` | Same operator; exact live request, current reviewed controller/maintainer, fixture/target isolation and eligible source; image digest only, repository and bindings derive from approved source profile | No |
| POST `/vps/preview-pairs/:pairId/actions` | Same operator authority; expected generation/revision; discriminated update/stop/reconcile payload | No |
| POST `/vps/preview-pairs/:pairId/status` | Same operator; exact recorded controller run and effective generation (the target during update); safe status only, no manifest/content capability | No |
| POST `/vps/preview-pairs/:pairId/adoption` | Same operator; current reviewed controller, memberships, verified candidate and immutable intent; exact parent generation/source checked under the admission lock, then revision-fenced writes | No |
| POST `/vps/preview-pairs/reconcile` | Same operator authority; bounded claim count and worker lifetime | No |
| GET `/api/preview-pairs/:pairId` | Real first-party Clerk session; requester, configured maintainer or actual leased fixture actor; current pair binding | No |
| GET `/api/preview-pairs/:pairId/requests/:generation` | Verified control-issuer requester of this exact request or current configured maintainer; Preview-issuer/outsider denied uniformly | No |
| GET `/api/preview-pairs/:pairId/manifest` | Same real actor check; live ready generation, current identity/routing/artifact/funding prerequisites; cache disabled | No |
| GET `/api/preview-pairs` | Real configured maintainer membership; bounded cursor/limit; only permitted reports | No |
| GET `/api/preview-pairs/setup` | Verified control-issuer reader and current configured maintainer; returns only reviewed controller identity/ref, verified requester and admission flag | No |
| POST `/api/preview-pairs/:pairId/stop` | Verified control issuer and current configured maintainer; strict generation/revision,16KiB body limit; stops only the selected infrastructure generation | No |
| GET `/preview-pair-updates/:handle/system-bundles/releases/:version.json` | Non-authorizing public bundle metadata; exact active projected Preview handle/slot, empty access list and matching confirmed/target version+digest; reject all channel/list/other-version paths | Yes |

Every mutating route, including future DELETE aliases, has a16KiB body-limit
middleware before parsing. Validate UUID params, integer cursors/limits and
strict action schemas at the boundary. Do not trust client identity headers,
caller-selected owners, provider types, addresses, origins or class flags.

## Start

Before publication, the reviewed controller records a source-owned request using
`repository`, `pairId`, `generation`, `pr`, `sourceSha`, and `controllerRunId`.
No requester, issuer, secret reference, profile or arbitrary URL is accepted.
The server independently resolves the controller actor and verifies the requested
PR head, fixture identity and target database isolation before recording it.
The reply contains the safe request state, expiry and public profile fingerprint.
Preparation itself creates no fixture lease, machine, job or cloud resource.

The trusted publisher sends a64-character image digest, generation and recorded
controller run. It accepts no URL, image repository, environment, secret, actor or
service override. Current controller/identity/target/source checks repeat before
publication. The source journals a unique publication nonce and immutable digest
before its single etag-conditional template/traffic update. Retries poll the
recorded operation; an ambiguous issuing state never repeats the effect. Existing
traffic is pinned to observed revisions before zero-percent UI/API tags are added,
so a `LATEST` target cannot route normal traffic to the candidate. Admission waits
for a completed successful operation and matching immutable revision/image.

At most32 unadopted requests may exist; cancelled requests still consume this
capacity until exact retirement is proved. Preparation expires after two hours,
capped by the existing pair's hard expiry for updates. Replays do not extend it.
The same UUID/generation cannot switch actor, controller run, source or profile.
Actual configured admission/update adopts that exact request in the transaction
that writes the canonical generation. Cancelling before adoption prevents a late
admission. Cancelling after adoption returns `adopted`; it does not grant authority
to retire the canonical pair. Normal generation-fenced stop remains separate.

The source worker durably schedules exact cloud retirement, including an
unadopted update whose parent stops or advances. Recording an intent alone is not
proof of retirement. Protected workflow invocation remains a dependent layer.

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

Before pair admission, the ordinary report path returns a request-only diagnostic
to its verified control-issuer requester or current maintainer. The explicit
request/generation path also diagnoses an unadmitted update without replacing the
active pair's report. It exposes finite publication/lifecycle/failed-stage fields,
never operation resource names, publication nonces, claims, secrets or provider
error bodies. Infrastructure readiness is always false and acceptance is not run;
it grants no manifest or content access. Preview-issuer readers and outsiders get
the same404 as unknown requests. Invalid/expired sessions retain401; unavailable
membership/configuration is503 rather than a fake not-found.

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


## Pinned host configuration

The internal pair dispatcher supplies the verified browser origin to the existing
host-config producer. Pair hosts boot directly against the approved API, use only
the approved browser origin for collaboration relay/client-origin checks, and pin
the updater to their projected confirmed bundle. Missing/mismatched internal binding
fails closed. Ordinary and Private Preview configuration retains its current policy.
The public metadata route grants no user or runtime capability, never accepts
caller-selected download URLs, and reserves its whole prefix before owner routing.
