# Immediate Web Desktop and disposable compute

The isolated preview works locally through Cloudflare's native APIs with the
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

## Measurements and limits

All timings below are **local** Wrangler/Miniflare plus Docker on Apple Silicon
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

Cloudflare resources created: an empty isolated R2 bucket and primary/dead-letter
Queues. Remote Worker/container deployment and Hyperdrive connection creation
were held after automatic approval review rejected exporting test credentials.
No Worker secrets were uploaded. The local test used those credentials only on
this computer. Two isolated database/role pairs separate shared control data
from the agent's kernel database; the agent never receives the shared DB secret.

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
   disposable test's archives are removed with its local state. The R2 file
   adapter includes a bounded reference-aware collector for staged text objects.
4. Wire real plan placement/admission and upgrade migration, preserve all OS-view
   surfaces, and measure remote cold/warm latency and failures under concurrency.

Separate public documentation: [site draft PR #264](https://github.com/FinnaAI/matrix-os-site/pull/264).

Validation: **112 focused tests and 2 real Postgres integration tests passed**;
Worker and shell typechecks passed. Native integration and browser checks above
are additional live checks. Test failures were observed before the associated
implementation fixes, including native SDK behavior that unit fixtures missed.

## Reproduction

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
