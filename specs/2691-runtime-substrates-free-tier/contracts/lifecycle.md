# Contract: lifecycle, registration, and upgrade routes

Route names are proposals to reconcile with the owning routers. Every mutating route
uses Hono `bodyLimit` before parsing and a Zod schema for path, query, and body. Error
bodies are `{ error: <code> }` with a fixed set of codes.

## Platform, called by the container

Auth for all three: per-runtime HMAC token bound to handle, machine id, slot, and token
epoch, compared in constant time. A token from an older epoch is rejected with 401.

| Route | Body | Result |
| --- | --- | --- |
| `POST /internal/containers/:handle/register` | `{ generation, bundleVersion }` | 200 `{ ok: true }`; sets `running` by compare-and-set from `starting`; idempotent |
| `POST /internal/containers/:handle/lifecycle/activity` | `{ unsettledRuns: number }` | 204; advisory only |
| `POST /internal/containers/:handle/lifecycle/flushed` | `{ generation, manifestDigest }` | 204; records the last good flush |

Limits: 4 KiB body; per-runtime rate limit.

## Gateway, called by the platform

Auth: platform verification token plus verified-user proof, as on existing internal
routes.

| Route | Result |
| --- | --- |
| `GET /internal/runtime/ready` | 200 only after the boot set matching the accepted manifest is restored and the database answers |
| `POST /internal/runtime/quiesce` | Atomically stops accepting new runs; returns `{ unsettledRuns }` |
| `POST /internal/runtime/resume` | Cancels a quiesce |
| `POST /internal/runtime/flush` | Final flush; returns `{ manifestDigest, parts }` (below) |

`quiesce` followed by `flush` is the only path to a clean stop. After a successful
`quiesce` the gateway rejects new runs with a retryable code until `resume` or exit.

The final flush runs in a fixed order: files, then the manifest commit, then the owner
Postgres dump. It has a configured deadline (`MATRIX_FINAL_FLUSH_DEADLINE_MS`, default
120000) and attempt count (`MATRIX_FINAL_FLUSH_ATTEMPTS`, default 3). `parts` reports
each part's durability separately, so a manifest digest never implies that everything is
saved:

| Part | Values |
| --- | --- |
| `home` | `persisted` |
| `ownerDatabase` | `persisted`, or `skipped` when no upload store is configured |
| `kernelDatabase` | `persisted` once the boot set carries the `matrix.db` copy; `local_only` or `absent` otherwise |

Errors: 503 with `not_ready`, `flush_failed`, or `misconfigured`. Owner dumps use the key
`system/db/snapshots/<YYYY-MM-DDTHHMMSSZ>-g<generation>.dump`. The platform accepts this
key alongside the older minute-precision names.

## Provider hooks, called by Lambda MicroVMs

Lambda delivers per-unit data only through hooks: HTTP `POST` to
`/aws/lambda-microvms/runtime/v1/<hook>` on a hook port set on the image. The `/run` body
is `{ microvmId, runHookPayload }`, where `runHookPayload` is the platform's boot payload
(version 1, at most 16 KB). Environment variables are fixed per image version, so per-owner
configuration cannot arrive through them. The endpoint forwards no traffic until `/run`
returns 200.

| Hook | Runtime behaviour |
| --- | --- |
| `run` | Accept the payload once, validate it, store it with mode 0600 outside the home, start the gateway; 200 once it listens |
| `suspend`, `terminate` | Bounded final flush as a safety net behind the platform's quiesce, flush, stop; always 200 |
| `resume` | Re-check credentials |
| `ready`, `validate` | Image health at build time only; no owner data exists yet |

The platform owns idleness. Units are started with an explicit `idlePolicy`: the idle
duration is set to the provider maximum, above the platform's hard session limit, and
auto-resume is off. This stops the provider from suspending a unit behind the generation
compare-and-set. The docs do not give a timeout for any hook.

## Platform, called by clients

Auth: Clerk session (or existing device and sync tokens), owner only.

| Route | Body | Result |
| --- | --- | --- |
| `POST /api/auth/provision-runtime` (existing) | adds `{ plan: "matrix_free" }` | Creates the container runtime; `waitlisted` when not invited; `busy` at capacity |
| `GET /api/runtime/upgrade` | none | Current migration state, or none |
| `POST /api/runtime/upgrade` | `{ idempotencyKey }` | Starts or resumes a migration after an active paid entitlement exists |

Waking is not a separate route. An authenticated owner request to a stopped container
runtime triggers `ensureRunning`; the response is the runtime state (`waking`,
`restoring`, `busy`, `failed`), and clients retry with backoff.

## Operator routes

Auth: platform operator credential.

| Route | Purpose |
| --- | --- |
| `POST /internal/free-tier/invites` | Add an invite |
| `DELETE /internal/free-tier/invites/:userId` | Remove an unconsumed invite |
| `GET /internal/free-tier/capacity` | Counts against ceilings, no owner data |

## Stripe

The existing webhook, after verifying the signature and recording the entitlement,
creates a `runtime_migrations` row keyed by the event id for an owner whose runtime is a
container. It returns non-2xx if that write fails so Stripe retries.
