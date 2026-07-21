# Contract: Golden Snapshot Control Plane

All responses expose coarse state/codes only. Provider names, raw provider errors, filesystem paths, secrets, and scan matches remain server-side.

## POST `/system-bundles/snapshot-builds`

Production (`testMode: false`) requests use the existing constant-time `PLATFORM_SECRET`
bearer check. Test-mode requests require the separate constant-time
`GOLDEN_SNAPSHOT_OPERATOR_SECRET`; a release credential alone cannot set `testMode`.
The mutating body is limited by Hono `bodyLimit` and parsed before the scoped auth
branch is selected.

Request:

```json
{
  "bundleVersion": "v2026.07.19-1234",
  "testMode": false
}
```

Rules:

- `bundleVersion` resolves an existing immutable release and digest.
- Compatibility is injected from bounded platform configuration; callers cannot
  provide provider URLs, locations, base images, or arbitrary labels.
- `testMode` is accepted only from the operator boundary, is persisted on the candidate, is never production-selectable, and remains subject to a separately bounded retention TTL.
- Main/tag release automation uses `testMode: false`; previews are rejected by default.
- Repeated requests return the existing canonical snapshot/build.

Response `202` (also used for idempotent reuse):

```json
{
  "snapshotId": "uuid",
  "buildId": "uuid",
  "status": "queued",
  "reused": false
}
```

Errors: `400 Invalid request`, `401 Unauthorized`, `500 Snapshot build request failed`, `503 Snapshot builds disabled`.

## GET `/system-bundles/snapshot-builds/:buildId`

Authenticated with the separate constant-time `GOLDEN_SNAPSHOT_OPERATOR_SECRET` bearer
check. `buildId` is a strict UUID path parameter. The
response contains `buildId`, `snapshotId`, `phase`, `status`, `attempts`, snapshot
`state`, and a nullable coarse `failureCode`; it never includes leases, callback
tokens, provider errors, raw scan evidence, or secret-bearing logs. Errors are generic
`400/401/404/503`.

## POST `/system-bundles/snapshot-builds/:buildId/retry`

Authenticated with `GOLDEN_SNAPSHOT_OPERATOR_SECRET`; strict UUID path parameter and a Hono `bodyLimit`
of 1 KiB. The request body is ignored. The transaction accepts only terminal retryable
builds, resets the bounded attempt budget and candidate state consistently, and uses
conditional writes so repeated requests are idempotent. Response `200` is:

```json
{ "retried": true }
```

`retried` is `false` when the build is missing or not retryable. Errors are generic
`400/401/500`.

## GET `/system-bundles/snapshots`

Authenticated with `GOLDEN_SNAPSHOT_OPERATOR_SECRET`. Query fields are `limit`, coerced to an integer
from 1-100 with a default of 25, and an optional opaque URL-safe `cursor` bounded to
16-512 characters. Response `200` is
`{ "snapshots": [{ "snapshotId", "bundleVersion", "state", "failureCode", "updatedAt" }], "nextCursor"?: "opaque" }`.
Provider IDs, provider errors, leases, and raw validation evidence are omitted. Errors
are generic `400/401/500`.

Pages use immutable keyset order `(created_at DESC, snapshot_id DESC)`. The opaque
cursor encodes and schema-validates both values and the next query applies the strict
lexicographic boundary; database-default or mutable-`updated_at` ordering is forbidden.
Contract tests update lifecycle rows across a page boundary and prove the traversal
neither skips nor repeats snapshot identities.

## POST `/system-bundles/snapshots/:snapshotId/revoke`

Authenticated with `GOLDEN_SNAPSHOT_OPERATOR_SECRET`; strict UUID path parameter and a Hono `bodyLimit`
of 4 KiB. Strict request:

```json
{ "reason": "base-generation-revoked" }
```

`reason` is an allowlisted bounded code. The transaction immediately makes the
snapshot non-selectable, records the coarse reason, and enqueues exact-resource cleanup
only when retention/revocation policy permits it. Repeated revocation is idempotent.
Response `200` is `{ "revoked": true }`; `false` is an idempotent no-op for a missing
or already terminal snapshot. Errors are generic `400/401/500`.

## POST `/system-bundles/snapshot-base-generations/:baseGeneration/revoke`

Authenticated with `GOLDEN_SNAPSHOT_OPERATOR_SECRET`; `baseGeneration` is validated as a bounded
compatibility identifier and the request uses a Hono `bodyLimit` of 4 KiB. The strict
request body is:

```json
{ "reason": "base-generation-revoked" }
```

The transaction inserts the durable revoked-generation deny marker with `ON CONFLICT`;
enqueue, readiness, and selection check that marker immediately. It does not load every
matching snapshot. A bounded worker subsequently quarantines active snapshots,
terminates builds, clears callback material, and queues exact builder/validator cleanup
in deterministic pages. Revocation makes the image non-selectable immediately even
while leases remain ambiguous; exact provider-image cleanup is queued at high priority
as soon as the last unreleased lease drains, bypassing channel/rollback protection.
Existing running machines remain online. Repeated revocation is
idempotent. Response `200` is `{ "revoked": true }`; errors are generic `400/401/500`.

## GET `/system-bundles/snapshot-base-generations/:baseGeneration/affected-machines`

Authenticated with `GOLDEN_SNAPSHOT_OPERATOR_SECRET`; `baseGeneration` uses the same bounded schema as
revocation. Query fields are `limit` (1-100, default 25) and an optional opaque URL-safe
`cursor` bounded to 16-512 characters. Rows are ordered deterministically by the
immutable key `machineId ASC`; the cursor contains only that identity and applies a strict
`machine_id > cursor.machineId` boundary. Mutable status timestamps MUST NOT
participate in the cursor. Rows come only from retained running-machine provenance.
Response `200` is:

```json
{
  "machines": [{
    "machineId": "uuid",
    "runtimeSlot": "primary",
    "sourceSnapshotId": "uuid",
    "targetBundleVersion": "v2026.07.19-1234",
    "status": "running",
    "updatedAt": "2026-07-19T12:00:00.000Z"
  }],
  "nextCursor": "opaque"
}
```

The route omits owner identifiers, provider IDs, addresses, and raw errors. Invalid
cursors or identifiers return generic `400`; auth and server errors are `401/500`.

## POST `/system-bundles/snapshot-cleanup/:cleanupId/retry`

Authenticated with `GOLDEN_SNAPSHOT_OPERATOR_SECRET`; `cleanupId` is a strict UUID and
the ignored request body is limited to 1 KiB. One conditional transaction accepts only
terminal `failed` or `quarantined` snapshot-domain cleanup, resets the bounded attempt
budget and lease fields on that same durable row, and preserves its exact provider ID
and provenance key. Repeated or ineligible requests are idempotent and return
`{ "retried": false }`; an accepted retry returns `{ "retried": true }`. Errors are
generic `400/401/500`.

## POST `/system-bundles/snapshot-builds/:buildId/callback`

Authenticated with `Authorization: Bearer <phase-token>`. The token is stored hashed,
compared in constant time, phase-bound, and expires. Each callback carries a UUID
`eventId`; the transaction persists the event ID, a canonical payload digest, and the
coarse response before clearing the active token. Replaying the same event and payload
returns that response without repeating side effects, while reusing the event ID with
a different payload fails closed.

Strict request union:

```json
{
  "eventId": "00000000-0000-4000-8000-000000000001",
  "phase": "sanitized",
  "bundleVersion": "v2026.07.19-1234",
  "bundleSha256": "64-hex",
  "builderMachineIdSha256": "64-hex",
  "builderSshHostKeySha256": "64-hex"
}
```

or:

```json
{
  "eventId": "00000000-0000-4000-8000-000000000002",
  "phase": "validated",
  "validationOrdinal": 1,
  "bundleVersion": "v2026.07.19-1234",
  "bundleSha256": "64-hex",
  "validationMachineIdSha256": "64-hex",
  "validationSshHostKeySha256": "64-hex",
  "evidence": {
    "exactBundle": true,
    "healthy": true,
    "freshActivation": true,
    "uniqueMachineId": true,
    "uniqueSshHostKey": true,
    "forbiddenStateAbsent": true
  }
}
```

The first independent clone callback persists its identity hashes and remains in
`validating`; it never makes the image selectable. The platform then creates a second
independent clone. Its callback (`validationOrdinal: 2`) compares both identity hashes
with the builder and clone 1 before accepting the uniqueness booleans and readiness.
Any reused hash, false/mismatched field, skipped ordinal, or duplicate validation-clone
identity fails closed and quarantines the candidate. Response is
`{ "accepted": true }`; failures are generic `400/401/409/503`.

## Existing provisioning contracts

Public/customer request and response schemas do not change. Snapshot source, fallback reason, provider IDs, and lease IDs remain internal. The internal `/vps/register` request adds bounded `bundleSha256` and coarse `healthy` evidence. Registration atomically compares the reported version and digest with the provisioning job's persisted target and accepts routing only when the established local health probe succeeds; self-reported `imageVersion` alone is insufficient.
