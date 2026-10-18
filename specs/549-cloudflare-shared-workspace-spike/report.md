# Immediate Web Desktop and disposable compute

The isolated preview works remotely through Cloudflare's native APIs with the
**actual Matrix gateway, dispatcher and Claude Agent SDK**. Shared data works
without a running container. Existing personal VPS routes remain alongside it.
This is a spike, not a released Free plan or a production onboarding change.

## What passed

- Real Web Desktop renders independently of compute, including bundled icons,
  wallpaper, a shared-workspace selector and a link to personal computers.
- Worker → Queue → per-owner Durable Object → Linux container → authenticated
  Matrix gateway → real agent → R2 checkpoint → durable output publication.
- A first agent read an API-saved input, waited 20 seconds in Bash and wrote two
  files. The container was saved and destroyed. A replacement read the private
  file that had **never** been projected into the shared file API. Its result
  proved native checkpoint restoration. Both runs ended with stopped compute.
- Saved files and committed Chat messages remained readable while asleep.
  Duplicate delivery did not start another container.
- Separate real Postgres tests verified owner isolation, reconnect persistence,
  conflicting revisions, duplicate jobs and expired leases.
- Personal `/vm/<handle>` routing and gateway isolation regressions passed;
  the direct gateway test also exercised the existing authenticated message path.

## Starter Help popover crash regression

The signed-in pilot crash report identified `PopoverAnchor` without its owning
`Popover` (the original screenshot's `mx-18mp5k4` error). The shared Help menu
created an unscoped checklist anchor using its own Radix import, while the Web
checklist's provider came from the shell's `radix-ui` import. The checklist
renderer now supplies the anchor from the same import as its provider; Help
retains its independent scope. Both Web and Electron callers use this contract.
A real-component regression first reproduced the exact exception with a trigger
ref and no ambient provider, then passed after the fix. Existing Web/Electron
Help/checklist switching and inbox tests remain part of validation. This does
not substitute for live surface captures or a signed-in post-deploy retest.

## Measurements and limits

The remote Worker, Queue, Durable Object, Container, R2 and Hyperdrive path passed
against isolated Postgres databases. The production-built Next frontend ran on
the developer machine against those live APIs. These are individual observations,
not fleet percentiles or a deployed frontend performance claim.
Sanitized results: [remote-evidence.json](./remote-evidence.json).

| Remote boundary | Observed |
|---|---:|
| Saved-data bootstrap with compute stopped | 127–202 ms |
| Production-built Web Desktop visible | 1.17 seconds |
| Saved file visible in the actual File Browser, compute still asleep | 1.52 seconds |
| First queued real-gateway wake, before agent work | 74.2 seconds |
| Agent reading shared input, including a 20s tool wait and durable result | 72.9 seconds |
| Replacement restoring a private file and publishing its result | 50.8 seconds |
| Completion to sleeping, including 15s idle grace and checkpoint | 18.2–21.4 seconds |
| Maximum sampled VM used memory | 1.20 GiB |
| Maximum sampled gateway RSS | 739 MiB |
| Restore-verification agent inference | $0.0341263 |
| Saved native archive | 97,391,005 bytes |

The two completed agent jobs extended their persisted leases by 66.7s and 46.2s.
Neither had a browser attached. A later real browser visit also started compute
in the background; it remained running after the browser closed, then slept.
Concurrent live dock-position and dock-size patches both remained saved.

Native VM cgroup counters were unavailable. Memory above samples
`MemTotal - MemAvailable` every three seconds; it is not an exact peak, process
RSS total, or billable allocation. The tested instance was **standard-2: 6 GiB,
1 vCPU, 12 GB disk**. A smaller remote shape has not been qualified.

One earlier remote agent attempt failed and was interrupted without a completed
output. Its cause remains unresolved. A fresh retry after adding safe RPC
diagnostics passed both tasks. This small sample does not establish reliability.
Image preparation also took several minutes; a tiny diagnostic image prepared
in 16.9s. Pinning the actual amd64 manifest removed index ambiguity, but does not
establish the cause of the preparation delay.

Earlier timings below are **local** Wrangler/Miniflare plus Docker on Apple Silicon
with Linux/amd64 emulation, source/tsx gateway imports and real external Postgres
and inference. They are not Cloudflare remote latency or fleet percentiles.
Raw sanitized results and boundaries: [evidence.json](./evidence.json).

| Boundary | Observed |
|---|---:|
| Shared bootstrap with compute stopped | 195–217 ms |
| Warm development Web Desktop visible | 1.8–3.1 seconds |
| Restored saved file visible in the actual File Browser | 2.7 seconds, compute asleep |
| Native queued wake, before agent execution | about 28 seconds |
| First queued agent, including cold start, 20s tool wait and durable result | 62.3 seconds |
| Second queued agent, including replacement, restore and durable result | 44.7 seconds |
| Completion to sleeping, including 15s idle grace | about 16–18 seconds |
| Observed native first-run container peak | 1.49 GiB |
| Separate direct gateway task, including 20s wait | 30.7 seconds / $0.0453 AI |
| Native restore-verification task | $0.0341 AI |

Cold development compilation was materially slower than the warm desktop sample;
there is no production frontend performance claim. A 1 GiB machine cannot safely
fit this tested workload. Cloudflare charges provisioned memory, so observed RSS
is not a billing estimate. See [cost assumptions and comparison](./costs.md).

## How the agent stays alive

Postgres owns the work lease, generation and hard deadline. The controller renews
it every five seconds in the test configuration; the lease allows 120 seconds
for cold starts and transient delay. A model wait, tool wait or closed browser
does not release the lease. One task runs per owner in this spike.

On success, the gateway drains, its credential is revoked, the home is saved to
R2 and output is published only if the lease and file revisions are still valid.
Completion releases the lease. After 15 idle seconds, the controller takes a
final checkpoint and destroys the container. Shared reads do not start compute
or renew a work lease. The next task restores the home and overlays newer shared
files before starting the gateway.

Expiry and cancellation first advance the durable generation and quarantine the
runtime; an old callback cannot kill a replacement run. A restarted controller
can re-enter checkpointing. Failed saves retry for at most 120 idle seconds,
then stop under a failed state while retaining the last acknowledged checkpoint.
Restore and keepalive calls have timeouts. Failed explicit destruction keeps the
generation quarantined and arms a short platform inactivity fallback.

## Both architectures

The shared `/workspace` entry uses shared data APIs and queued compute. Personal
computers keep their current `/vm/<handle>` APIs, processes and provisioning.
The selector links between these entries without redirecting shared API calls to
a personal machine. A personal placement cannot be claimed or destroyed by the
pooled lifecycle. No customer VPS was changed by this spike.

These are separate placements. Migrating a shared workspace onto a personal VPS,
or keeping both in sync as one filesystem, is **not implemented** here.

## Deployment and follow-ups

After explicit user approval, the isolated deployment used Workers, Queues,
Durable Objects, native Containers, R2 and Hyperdrive. Postgres remains the data
source of truth; inference used the existing real gateway's Haiku route. Two
disposable database/role pairs separate shared control data from the agent's
kernel database; the agent never receives the shared DB secret. Four approved
secrets were stored on the test Worker, never in its image or checkpoints.

The Worker and secrets, container application, both Queues, Hyperdrive, ten R2
objects (681 MB), bucket, two databases/roles and both registry image tags were
removed and their absence checked. Local preview processes and test image tags
were removed. Unmerged code worktrees remain available for review; customer
resources were preserved. A saved archive scan found none of the five test
secret values. Local credential copies are removed after evidence collection.

Before a public rollout:

1. Resolve a separate owner database/role and scoped AI access for every runtime;
   replace the single trusted preview owner and static test key. Add authoritative
   per-owner spend reservations, storage/time quotas and abuse controls.
2. Connect canonical Chat/Terminal realtime transports and store a trusted SDK
   session mapping per Chat. Transcripts survive checkpoints, but each queued
   action currently starts a new SDK session. Only `spike-result.txt` and result
   text are projected back to shared data; generic file/app synchronization is
   unfinished. The preview states these limitations visibly.
3. Delete superseded native archives only after their replacement pointer is
   durable, and sweep unreferenced archives with bounded retention. The current
   disposable test's archives are removed with its test bucket. An hourly
   reference-aware text-object collector already uses a persisted cursor, fenced
   lease, bounded page and 24-hour grace. Native archive retention is unfinished.
4. Wire real plan placement/admission and upgrade migration, preserve all OS-view
   surfaces, qualify smaller shapes and compiled-gateway startup, and measure
   cold/warm latency and failures under concurrency.

The Web Desktop screenshot and recording use a local production frontend with a
live Cloudflare backend. A deployed UI capture, the required surface review and
Slack evidence sharing remain review-readiness gates; this PR stays a draft.
Web Canvas, Electron Desktop, Web Mobile and Native Mobile do not expose this
isolated web preview entry. Their N/A rationale still needs reviewer approval.

Separate public documentation: [site draft PR #264](https://github.com/FinnaAI/matrix-os-site/pull/264).

Validation: **230 focused tests and 2 real Postgres integration tests passed**;
Worker and shell typechecks passed. Native integration and browser checks above
are additional live checks. Test failures were observed before the associated
implementation fixes, including native SDK behavior that unit fixtures missed.
The production shell build passed. The changed-code React audit passed without
errors; remaining warnings concern bounded configuration parsing and existing
Appearance complexity. The full repository audit still reports unrelated debt. The pattern scanner
flags the Worker entrypoint and in-process Hono `app.fetch()` as external fetches;
manual review confirms both are local dispatch, not network requests.

## Reproduction

For the budgeted runtime stack, follow the ordered [U4 qualification setup](../630-shared-workspace-production/qualification.md). The original two-schema setup below describes the historical spike and is insufficient after compute admission is enabled.

Use an isolated preview owner and two disposable least-privilege Postgres
databases. Never point the harness at customer data. Initialize the shared schema
through `PostgresWorkspaceRepository.initialize()` and
`PostgresRuntimeStore.initialize()`; the real Postgres integration test exercises
those methods when `MATRIX_SHARED_WORKSPACE_TEST_DATABASE_FILE` names a private
DSN file. The runtime DB is initialized by the actual gateway.

The Worker config is an isolated resource template. Add an environment-specific
`HYPERDRIVE` binding before remote deployment. Supply `PREVIEW_TOKEN`,
`RUNTIME_AUTH_SECRET`, `ANTHROPIC_API_KEY` and the separate `RUNTIME_DATABASE_URL`
through secret storage. For local Wrangler, use a private `.dev.vars` and the
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` environment variable;
local credentials must not be committed. No control DB credential belongs in the
container image, runtime environment or checkpoint.

Run the shell with `MATRIX_SHARED_WORKSPACE_SPIKE=1`, configured Worker origin,
canonical `MATRIX_SHARED_WORKSPACE_SHELL_ORIGIN`, preview token and fixed owner.
Real-user authentication additionally requires the fixed Clerk issuer/audience;
the live browser sample used the isolated test bearer. Production standalone
packaging must include bundled icons/wallpapers or set the installation root.

```sh
MATRIX_WORKSPACE_TEST_TOKEN_FILE=/private/path/preview-token \
MATRIX_WORKSPACE_TEST_OUTPUT=/private/path/evidence.json \
node scripts/spikes/cloudflare-workspace/verify.mjs
```

The harness validates bootstrap without compute, R2/SQL data publication, two real
agent tasks, private-file restoration, sleep and duplicate delivery. It requires
Node 24+ and a fresh fixed preview owner. It never prints credentials.


### Starter transport regression (ENG-319)

The saved-data desktop does not expose the personal gateway WebSocket or its
`/api/auth/ws-token` endpoint. Shell mount, reconnect, and visibility recovery
must not start that transport on `/workspace`; native socket actions fail locally
without being queued. The shared runtime controller remains the compute status
authority, independent of saved-data access. Personal gateway authentication and
reconnect behavior are unchanged.

| Route | Authentication | Limits | Purpose |
| --- | --- | --- | --- |
| `POST /api/client-errors` | Existing verified workspace owner bearer/Clerk middleware | 16 KiB body; strict shell reporter schema; 1,000-character message and 4,000-character stack | Private operator exception diagnostics, never returned to clients or sent to compute |

Crash reports omit browser user agent and strip route queries/fragments from
operator logs. Regression tests cover auth, input bounds, spoofed owner rejection,
no compute admission, and native socket suppression. Live browser confirmation
remains required; removing unsupported requests alone does not prove the reported
shell crash is resolved.
