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
| `GET /internal/runtime/ready` | 200 only after hydrate completes and the database answers |
| `POST /internal/runtime/quiesce` | Atomically stops accepting new runs; returns `{ unsettledRuns }` |
| `POST /internal/runtime/resume` | Cancels a quiesce |
| `POST /internal/runtime/flush` | Flushes home and database snapshot; returns `{ manifestDigest }` |

`quiesce` followed by `flush` is the only path to a clean stop. After a successful
`quiesce` the gateway rejects new runs with a retryable code until `resume` or exit.

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
