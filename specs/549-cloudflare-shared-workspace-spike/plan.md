---
status: local-validated-remote-approval-pending
---

# Cloudflare shared workspace spike

Goal: immediate authenticated Web Desktop access with owner data available while
compute is asleep; Cloudflare-backed background execution using the actual Matrix
gateway and Agent SDK; personal VPS routing preserved. This is an isolated,
feature-gated preview, not a production free-plan or billing rollout.

## Architecture and boundaries

Cloudflare Worker serves authenticated shared data APIs, R2 holds owner files and
checkpoints, Queues carries wake requests, and a per-workspace Durable Object
controls the Linux sandbox using the current native Container API. Postgres via
Kysely remains authoritative for workspace/app records, leases and jobs; no D1 or
Durable Object SQL is introduced as an application database. Hyperdrive may pool
the external Postgres connection. DO storage is restricted to its platform alarm.
Agent credentials are injected only at execution time, never in images or client
responses. A unique preview deployment and test database avoid customer changes.

### U1: Shared owner data APIs

Owner: data worker. Files: `packages/workspace-worker/src/data/**`,
`packages/workspace-worker/src/auth.ts`, `packages/workspace-worker/src/routes.ts`,
`tests/workspace-worker/data*.test.ts`, `tests/workspace-worker/routes*.test.ts`.

Approach: bounded Hono/Zod routes, server-derived owner identity, Kysely/Postgres
repository and R2 file adapter. Supply bootstrap, layout, file and chat reads
independent of compute; owner mutations are durable before acknowledgement.
Expose runtime status and enqueue execution via injected runtime adapter. Keep
personal placement behind an injected trusted adapter, never a client-provided
upstream URL. Parent owns package manifest, Worker entrypoint and deployment.

Tests first: no-runtime bootstrap succeeds, missing auth rejected, cross-owner
access denied, payload/path bounds, revision conflicts, transaction/idempotency,
read paths do not wake compute. Confirm failing tests before implementation.

### U2: Cloudflare runtime and active-work lifecycle

Owner: runtime worker. Files: `packages/workspace-worker/src/runtime/**`,
`packages/workspace-worker/Dockerfile`, `packages/workspace-worker/runtime/**`,
`tests/workspace-worker/runtime*.test.ts`.

Approach: native Sandbox 1.0/Container API in a DO, bounded Queue delivery,
Postgres-backed fenced work leases, heartbeat and alarms while jobs/tools are
active. Agent waits and browser disconnects do not imply idleness. Only release
after completion/explicit cancellation/fenced failure and durable flush; idle
grace then checkpoint to R2 before stop. Bounded maximum run budget; heartbeat
loss marks interrupted/recoverable rather than successful. Use actual compiled
Matrix gateway and Claude Agent SDK with a low-cost live model for validation.
No fake gateway or mocked live-provider evidence. Parent supplies DB/R2/secrets.

Tests first: model-wait remains awake, one run per owner with queued retries,
stale generation rejected, duplicate queue messages idempotent, failed checkpoint
prevents stop, idle expiry sleeps, personal placement not destroyed. Runtime
worker must notify parent of current SDK signatures and build prerequisites.

### U3: Immediate shared Web Desktop entry

Owner: desktop worker. Files: `shell/src/app/workspace/**`,
`shell/src/components/workspace/**`, `shell/src/lib/shared-workspace.ts`,
focused edits in `shell/src/lib/gateway.ts` and `shell/src/proxy.ts`,
`tests/shell/shared-workspace*.test.ts*`.

Approach: explicitly enabled authenticated preview entry renders existing Matrix
desktop components without billing/provisioning gates. Same-origin shared API
prefix forwards to configured Worker using a verified owner session; do not trust
browser-supplied owner/host headers. Show warming state only for execution actions;
saved data and desktop stay usable. Personal VPS routes remain unchanged. Reuse
shared contracts and presentation derivations; avoid a second fake desktop.

Tests first: shared desktop renders before pending compute, auth fails closed,
disabled preview unavailable, shared API URL scoped, normal /vm routing preserved.
Parent owns shared contracts, package/lockfile changes and integration wiring.

### U4: Deploy and test real workload

Owner: parent. Files: Worker entrypoint/config/manifests, shared contracts if
needed, `scripts/spikes/cloudflare-workspace/**`, evidence/report in this folder.

Deploy isolated Cloudflare resources; disposable owner-scoped Postgres data;
build the real gateway/agent image without credentials. Validate authenticated
desktop bootstrap before sandbox start, live agent file write/tool wait, browser
disconnect, lease renewal, checkpoint/sleep, wake and preserved data. Capture
memory and timing boundaries; test personal route via explicit compatibility
contract and real gateway. Delete billable test compute after measurements.
Run focused tests, type checks and review; create a PR with invariants. Follow-up
public enablement includes a separate `FinnaAI/matrix-os-site/content/docs/` PR.

## Auth matrix

| Surface | Auth | Public |
|---|---|---|
| Web Desktop preview document | Verified Clerk session, explicit preview flag | No |
| Shared data API | Verified Clerk JWT or isolated test bearer mapped server-side to one owner | No |
| Wake/job mutation | Same owner auth, bounded action schema and quota | No |
| Queue consumer/DO RPC | Cloudflare bindings only, fenced job identity | No |
| Sandbox gateway | Per-generation runtime credential; no public direct port | No |
| Personal VPS adapter | Existing platform-authorized route | No |
| Health | Same owner auth, coarse shared-data readiness only | No |

## Execution notes

Units own disjoint files; parent serializes manifest/lockfile edits and commits.
Workers are not alone and must not revert others' edits. No production DNS,
billing, signup, existing VPS data or fleet deployments are changed by this spike.
Record exact access limitations and live-test failures rather than replacing them
with synthetic results. Report how agent liveness and sleep work in plain words.
