# Preview Environments

How to see a change running, production-shaped, and read its logs — for humans
and coding agents. Spec: `specs/093-preview-environments/`.

Production Matrix OS is VPS-native per user (host systemd services from a host
bundle) with the platform on Cloud Run. Previews mirror that architecture
instead of approximating it with local containers. All previews ship logs to
the central Loki on the ops VPS, queryable through one script.

## Decision table

| Feature type | Surface | Latency per change | Cost |
|---|---|---|---|
| Shell/gateway UI iteration | Staging slot (HMR) | seconds | none (ops VPS) |
| Shell/gateway/kernel verification | Preview VPS | ~20 min (bundle build + deploy) | 1 small Hetzner VPS until PR close |
| Onboarding flows | Preview VPS (virgin by construction) | ~20 min | same |
| Platform changes | Cloud Run preview revision | ~10 min | Cloud Run free-tier-ish |
| macOS app | CI artifact + preview VPS runtime | n/a | none extra |
| CLI beta x shell | npm dist-tag + preview VPS profile | minutes | none extra |

## Staging slots — the inner loop

Four hot-reloading dev containers on the ops VPS behind the existing tunnel,
one per git worktree:

```bash
./scripts/staging-slot.sh up ~/matrix-os.worktrees/my-feature
# claimed slot 2:
#   shell: https://staging-2.matrix-os.com
#   api:   https://api-staging-2.matrix-os.com
```

Edits in the worktree hit Turbopack/`tsx watch` directly — no rebuild. Each
slot gets its own database (`matrixos_staging_<n>` on the dedicated staging
postgres) and its own named volumes. Slot ownership lives in
`~/.matrixos/staging-slots/`; claims are race-safe (`O_EXCL`).

- `staging-slot.sh status` — list owners; `status --reap` frees slots idle past
  `STAGING_SLOT_TTL_HOURS` (default 72).
- `staging-slot.sh down <n>` — release. Slots are a shared resource; release
  them when done.
- `staging-slot.sh logs <n> -f` — raw compose logs; or use `preview-logs.sh
  --slot <n>` (slot containers ship to Loki automatically via the
  observability promtail's docker discovery).

## Preview VPS — the verify loop

### Per-PR hostname migration

The target browser URL is `https://pr-<N>.preview.matrix-os.com`. A dedicated
Preview edge Worker is prepared to route the exact hostname to the matching
tagged revision of `matrix-platform-preview`; `preview.matrix-os.com` can then
become the stable entry host. **Do not deploy its wildcard route yet.** The current
`preview-vps` workflow still provisions under the production platform, and
the share connector still uses production Clerk identities. Keep using the
current `/vm/pr-<N>` URL until the Preview-owned VPS and separate identity
path in [spec 530](../../specs/530-per-pr-preview-hostnames/spec.md) is complete.

The platform workflow still uses a shared staging database, secrets, and
service account across PR revisions. Before activating the new route, give
each PR its own database, service identity, secrets, and VPS; provision a
separate Preview Clerk instance, proxied wildcard DNS, and TLS coverage for
the deeper `*.preview.matrix-os.com` subdomains. Audit parent-domain cookies
and CSRF boundaries before exposing unmerged PR JavaScript at this hostname.

### Host configuration safety

Preview host configuration changes must preserve the existing file owner,
group, and mode across atomic replacement. The service wrapper runs as the
runtime user and sources `/opt/matrix/env/host.env`; a root-only replacement
can prevent the gateway from starting even when its values are correct. Check
metadata and readability as the service user before restarting anything, retain
a bounded rollback copy, and verify local health immediately afterward. Never
print the file contents or use a reboot as a substitute for restoring access.
If the gateway is unavailable, use an explicitly authorized operator connection;
do not recreate the preview or affect production machines to repair it.

### Provisioning workflow

Add the **`preview-vps`** label to a same-repo PR. The `Preview VPS` workflow:

1. Builds the host bundle as `0.0.0-pr<N>.<sha7>` (re-runs on every push while
   the label is present).
2. Publishes it **register-only** (`publish-release.sh --channel none`): the
   release exists in R2 + platform DB but no channel pointer can ever select
   it, so it cannot reach real users.
3. Provisions VPS `pr-<N>` (runtime slot `pr-<N>`, owned by the
   `PREVIEW_CLERK_USER_ID` Clerk user and shared only with the bounded
   `PREVIEW_CLERK_ACCESS_USER_IDS` allowlist) if absent, then deploys exactly
   that version to exactly that handle. Shared access applies only to
   server-classified preview machines; customer and primary runtimes remain
   owner-only.
4. Comments the URL on the PR: `https://app.matrix-os.com/vm/pr-<N>`.

Teardown is automatic on PR close. A daily reaper deletes any `pr-*` VPS whose
PR is closed or that is older than 72h — orphaned previews cannot accumulate
Hetzner cost. The reaper is fail-safe: a VPS whose PR state cannot be confirmed
is skipped, and the job fails so the skip is visible. Manual deploy: `gh workflow run preview-vps.yml -f pr=<N>`.

Required repo secrets (beyond the existing release secrets):
`PREVIEW_CLERK_USER_ID` — the Clerk user that owns preview VPSes.
`PREVIEW_CLERK_ACCESS_USER_IDS` — optional JSON array of up to eight additional
Clerk user IDs allowed to open the same preview VPSes. The owner must not be
repeated in this list. Re-running the workflow replaces the preview allowlist
with the configured value without recreating the VPS. Removing a collaborator
blocks subsequent HTTP requests and new WebSocket handshakes after that deploy.
An already-established WebSocket remains connected until it disconnects or is
closed; active connection draining is intentionally deferred.

Preview VPSes cannot use machine credentials alone for personal Integrations or
Custom MCP accounts. A collaborator with a shared Terminal can read the machine credential,
so the platform rejects personal-account requests on both internal routes,
including requests claiming the owner or another collaborator. An isolated
platform-preview Custom MCP fixture uses a synthetic owner and remains available.
Personal integrations remain available through the platform's
Clerk-authenticated routes under each actor's own account. A narrowly scoped
Preview Google Drive acceptance flow can list at most three file metadata
records only after an authenticated browser Chat turn and one exact browser
approval. Platform binds the actor, Preview handle, run, account label and
arguments, then atomically consumes the short-lived grant. The machine bearer
alone still cannot access the account; all other personal integration and
Custom MCP paths remain denied. Shared Terminal users may inspect returned
metadata, so the owner must accept that visibility before a real-account test.
Use synthetic fixtures for broader integration acceptance.

### Shared preview Terminal authorization

The platform database machine record is authoritative for preview classification
and `accessClerkUserIds`. The machine retains one canonical owner. Each browser
request and WebSocket token retains the authenticated collaborator's Clerk ID.
No allowlist is copied into VPS configuration.

For `/api/terminal/*` and `/ws/terminal/tab`, the platform adds a compact,
HMAC-SHA256 signed `x-platform-preview-terminal` access decision only after checking
the current preview classification and allowlist. The existing verified identity
headers continue to carry the real actor. The terminal access signature binds that
actor to the canonical owner and runtime slot; its existing per-handle signing key
also binds it to the exact preview handle. HTTP and WebSocket proxies strip incoming
platform identity and terminal-access headers before creating their own. The
gateway verifies the signature, authenticated actor, configured owner, and exact
runtime slot. Preview classification remains a server-side platform decision, not
a client header or a classification inferred solely from a `pr-*` name. Customer
records cannot issue terminal access, including records with preview-shaped names.

Terminal workspaces, project fences, and attachment capabilities continue to use
canonical resource ownership. Authentication, Chat authorization, and terminal
audit data retain the real actor. The same gateway owner/access
guard protects HTTP discovery/mutations and WebSocket attachment. Invalid proofs
provide no additional authority and retain the generic denial behavior. The
browser keeps the `/vm/pr-<N>` prefix on API, token, and WebSocket URLs.

Allowlist changes apply on the next proxied request or handshake. Active-stream
revocation, changes to Chat permissions, and sharing of
other owner-only APIs are outside this fix. There are no new DB writes, caches,
clocks, background timers, or persisted authorization state. Existing terminal lifecycle,
project transaction/fencing, and shutdown behavior remain in effect.

Rollout requires both the platform routing service and the preview VPS gateway
host bundle. Publishing only a host bundle leaves the old platform token/proof
behavior in place. Install both before validating the browser workflow with an
allowlisted collaborator; ordinary customer VPS access remains owner-only.

Preview provisioning uses the operator-only `/vps/preview/provision` route with the
same `pr-<N>` value for the handle and runtime slot. A `202` is valid only when its
machine ID is immediately visible as `provisioning` or `running` in `/vps/fleet`.
Rerunning the workflow resumes that exact machine; an absent or failed preview is
retried through the same idempotent route. The platform persists the machine and a
durable provisioning job atomically before provider dispatch.

Golden-snapshot rollout validation may additionally supply one exact
`testSnapshotId`. That optional field is accepted only with the separate snapshot
operator bearer, only for a ready test-mode image, and fails closed rather than
falling back to a clean image. Normal preview automation continues to use the
platform bearer and cannot opt into this path.

To walk the full onboarding/billing flow against branch platform code — a
four-slice split (staging slot for the shell, an IAM-proxied `preview-platform`
revision for the journey/reliability API, a local `dev:platform` + Stripe CLI
for the test-mode checkout/webhook race, and a disposable feature VPS for the
provisioned hand-off) — see the `staging-platform-vps` command and
[Staging Platform and Feature VPS Runbook](staging-platform-vps.md).

## Platform preview revisions

Add the **`preview-platform`** label. The workflow (bound to the GitHub
`Preview` environment) deploys the platform image to the dedicated
`matrix-platform-preview` Cloud Run service as a zero-traffic tagged revision
(`https://pr-<N>---<service-url>`). It runs as the dedicated
`matrix-platform-preview-runner` SA, which can read only: the **staging**
database (`platform-database-url-staging` — previews share it; Neon branch
per PR is deferred, spec 093), preview-generated platform/JWT/edge-router
secrets, the Clerk keys, the R2 bundles credentials (required by
`CUSTOMER_VPS_ENABLED=true` boot validation), and **Stripe TEST-mode** secrets.
Production `CLOUD_RUN_SERVICE`, its runtime SA, its database, and live Stripe
keys are never referenced. No Hetzner token is mounted, so a preview platform
cannot provision real VPSes. Provider-disabled revisions marked
`PLATFORM_PREVIEW=true` therefore skip the production primary-sync-storage
startup invariant; mounting a Hetzner token immediately restores that fail-closed
canonical EU R2 check. On PR close the workflow removes the `pr-<N>` tag
and deletes its revisions, mirroring the VPS teardown model.

**Browser-reachable onboarding/billing.** The service runs with public ingress
(`--allow-unauthenticated`, exactly like production — the app enforces its own
Clerk/JWT auth, the operator API stays gated by the preview `PLATFORM_SECRET`)
and is fronted by **`https://preview.matrix-os.com`**. So a labelled PR can be
walked end to end in a browser before merge: sign in → plan → Stripe **test**
checkout (`4242 4242 4242 4242`) → settling → journey. Origins/redirects
resolve to the preview host (`MATRIX_APP_URL`/`PLATFORM_PUBLIC_URL`).
Bearer-returning desktop control-plane calls use the separate preview Cloud Run
service origin published as `PREVIEW_API_ORIGIN`; it must never alias the
browser-reachable preview host.

Previews are still per-PR tagged, zero-traffic revisions, so point the host at
the PR you want to walk, then reset:

```bash
gcloud run services update-traffic matrix-platform-preview \
  --region europe-west3 --to-tags pr-<N>=100      # walk this PR
```

The host serves whichever PR tag currently holds traffic, so switching to
another PR is just another `--to-tags pr-<M>=100` (no separate reset needed).
Avoid `--to-latest` here — on this service "latest" is the most recently
*deployed* PR revision, not a stable base, so it would leave the host pinned to
whatever deployed last. To park the host on a known-good target, point traffic
at an explicit revision/tag you designate as the resting state.

**Collaboration authority.** Each preview revision runs the real collaboration
composition (organizations, discovery, tickets and relay) against the staging
database instead of the fail-closed registrar. It signs tickets with the
preview-only keyring `collaboration-ticket-keys-preview`, never the production
`collaboration-ticket-keys`, so a preview ticket cannot verify on a production
home and a production ticket cannot verify on a preview home. The active key ID
comes from the `Preview` environment variable
`PREVIEW_COLLABORATION_TICKET_ACTIVE_KEY_ID` (default
`collaboration-preview-v1`). The browser (allowed) and relay origins are the
preview host, `https://preview.matrix-os.com`, derived from `PREVIEW_PUBLIC_URL`,
which must be an HTTPS origin and never a production host. Before deploying, the
workflow checks that the secret has a readable latest version, that its keyring
holds at most eight well-formed Ed25519 seeds including the active key, and that
the preview runtime service account has `secretAccessor` on it. After deploying,
it confirms the tagged revision binds exactly that secret and those origins and
that `/api/collaboration/inbox` answers an anonymous request with `401` (the
fail-closed registrar answers `503`). Key material is never printed.

Provisioning the boot→ready hand-off in the browser is still out of scope (no
Hetzner token on preview); enabling it is a deliberate follow-up (a
preview-scoped Hetzner token + VPS reaping). For that slice today, use the
feature-VPS path in [Staging Platform and Feature VPS Runbook](staging-platform-vps.md).

### One-time infrastructure setup

The label workflow assumes this is already provisioned in GCP/Cloudflare/Stripe
(run by an owner with the relevant access — the workflow only deploys):

1. **Stripe test secrets** in Secret Manager (test mode only):
   `stripe-secret-key-test`, `stripe-webhook-secret-test`,
   `stripe-price-matrix-{starter,builder,max}-{monthly,annual}-test`.
2. **Routing** `preview.matrix-os.com` → the `matrix-platform-preview` run.app
   origin (`matrix-platform-preview-<hash>-ey.a.run.app`) via Cloudflare, the
   **same mechanism app/api.matrix-os.com use** (Cloud Run domain mappings are
   not available in `europe-west3`, so this is Cloudflare-proxied with the
   run.app Host header, not a GCP domain mapping). Because previews are tagged
   zero-traffic revisions, also route the PR under test to traffic
   (`update-traffic --to-tags pr-<N>=100`) so the base origin serves it.
3. **Stripe test webhook** → `https://preview.matrix-os.com/billing/webhooks/stripe`
   (`checkout.session.completed`, `.expired`, `customer.subscription.*`); store
   its signing secret as `stripe-webhook-secret-test`.
4. Grant `matrix-platform-preview-runner` `secretAccessor` on the new secrets.
5. **Collaboration ticket keys** (preview only): create
   `collaboration-ticket-keys-preview` holding a freshly generated keyring, a
   JSON object mapping the active key ID to a base64url 32-byte Ed25519 seed
   (for example `{"collaboration-preview-v1": "<43 characters>"}`). Generate the
   seed locally and pipe it into `gcloud secrets create --data-file=-`; never
   reuse or copy the production keyring. Grant
   `matrix-platform-preview-runner` `secretAccessor` on it, and set the
   `Preview` environment variable `PREVIEW_COLLABORATION_TICKET_ACTIVE_KEY_ID`
   to the key ID. To rotate, add a secret version that holds both the old and
   the new key IDs, then switch the variable; homes learn the published keys
   when they re-register.

The GitHub `Preview` environment may set `MATRIX_CARD_TRIALS_ENABLED` to
`true` or `false`; it defaults to `true`. Disable it temporarily for an immediate-
payment regression pass, then restore it after validation. `MATRIX_CARD_TRIAL_DAYS`
controls new trial offers, defaults to `3`, and must be an integer from `1`
through `30`. Each change
requires redeploying the preview revision. Existing Stripe trials and reserved
Checkout attempts retain their original duration, and billing status continues
to display that reserved duration until the attempt settles.

## Collaboration previews

A collaboration preview is a pre-merge gate for organization collaboration: a
disposable `pr-<N>` home served by that PR's preview platform revision, owned
by a dedicated test account instead of `PREVIEW_CLERK_USER_ID`. It takes two
labels and one dispatch.

1. **Provision.** Add `preview-vps` and `preview-collaboration` to a same-repo
   PR. The `Preview VPS` deploy job then runs in the protected
   `collaboration-e2e` environment, which waits for a required reviewer. It
   provisions `pr-<N>` with `clerkUserId = PREVIEW_COLLABORATION_OWNER_USER_ID`
   and an empty `accessClerkUserIds`, so preview access proofs cannot mask
   organization checks. The job refuses an owner equal to
   `PREVIEW_CLERK_USER_ID`. It never reassigns ownership: if `pr-<N>` already
   exists under another owner, in either direction, it fails and asks for
   `teardown_preview`. Previews without the label are unchanged. Fork PRs never
   get a preview.
2. **Platform revision.** Add `preview-platform` so the same head has a tagged
   preview platform revision with the preview collaboration authority.
3. **Connect.** Once both are green for the same head, sign in once as the
   collaboration owner at `https://app.matrix-os.com` (the connection drives the
   home through that account's active session), then run:

   ```bash
   gh workflow run preview-platform.yml -f pr=<N> \
     -f connect_share_preview=true -f connect_collaboration_preview=true
   ```

   `connect_collaboration_preview` runs only together with
   `connect_share_preview`; alone, the dispatch fails. It replaces the speech
   and Custom MCP share connection for that PR.

The `Connect collaboration preview home` job, also gated by
`collaboration-e2e`, works in this order:

- It confirms the PR is open, same-repo, labeled both ways and still at the
  selected exact head, and that the tagged revision runs that head's image and
  binds `collaboration-ticket-keys-preview`.
- The home proves it is this preview before anything changes: `MATRIX_HANDLE`
  and `MATRIX_RUNTIME_SLOT` equal `pr-<N>`, and `MATRIX_CLERK_USER_ID` is the
  collaboration owner. It reports its machine ID.
- In one staging transaction, it registers the machine under its real ID and
  owner with an empty access list. It retires this handle's synthetic share
  fixture row and earlier incarnations owned by the same account, and refuses
  anything owned by someone else.
- It arms a dead-man guard: a 300 s systemd timer that restores the rollback
  copy and restarts the gateway unless this run commits. Only then does the
  run claim the connection, which also installs the guard. The latest claim
  owns the home, so ownership only moves to a run whose timer already covers
  it, and a cancelled earlier run's timer can never undo a newer connection.
  A failed claim leaves the earlier owner and its timer in charge.
- Under the guard's lock, and only while it still owns the connection, it
  re-points only the home's collaboration binding in
  `/opt/matrix/env/host.env`:
  - `PLATFORM_INTERNAL_URL` becomes the PR tag URL;
  - `UPGRADE_TOKEN` becomes HMAC-SHA256 of the handle under the preview
    `PLATFORM_SECRET`, the credential the preview platform verifies;
  - `MATRIX_COLLABORATION_CLIENT_ORIGINS` becomes the tagged revision's allowed
    origins;
  - `MATRIX_UPDATE_MANIFEST_BASE_URL` is pinned to the original platform, so
    later exact-head deploys still find their release metadata.

  `MATRIX_AUTH_TOKEN` is untouched, so the `/vm/pr-<N>` control channel keeps
  working for rollback. The file keeps its owner, group and mode. One rollback
  copy (`.host.env.preview-collaboration-rollback`, the file before the first
  connection) sits next to it. Nothing prints the file or a value.
- It restarts the gateway and requires local health with collaboration
  configured from a new gateway process (a different `MainPID`). Next it
  requires that process to register its runtime endpoint (`vps-<machine ID>`)
  and keep its control stream live on the preview platform, with enrollment
  evidence dated after the new process was healthy. Only then does it commit
  and disarm the guard. Any failure after the claim fires the guard
  immediately, and a lost runner leaves the timer to fire. A failed
  reconnection therefore returns the home to its original binding.

The host scripts live in `scripts/preview-collaboration-{probe,home,guard}.py`.
The terminal run API caps each argument at 4096 characters, so each script
travels as 4000-character chunks that a one-line loader joins and runs.

After connecting, the home is reachable for collaboration only through
`https://preview.matrix-os.com` with that PR's tag holding traffic. Other
platform calls that follow `PLATFORM_INTERNAL_URL` also move to the preview
platform and may be unavailable there: platform-mediated sync, personal
integrations, Custom MCP and Symphony. Run collaboration journeys only on such
a preview. Closing the PR or `teardown_preview` deletes the VPS as usual. The
staging row stays `running` until the next connection, but the platform issues
no ticket for a home whose control stream has been silent for 60 s.

## Centralized logs

Everything funnels into the ops-VPS Loki and is queryable one way:

```bash
./scripts/preview-logs.sh --handle pr-123                      # whole VPS
./scripts/preview-logs.sh --handle pr-123 --unit matrix-gateway --grep ERROR
./scripts/preview-logs.sh --slot 2 --since 30m                 # staging slot
./scripts/preview-logs.sh --selector '{env="preview"}'         # everything preview
```

Runs against `http://127.0.0.1:3100` on the ops VPS (`LOKI_URL` to override).
Grafana (`grafana.matrix-os.com`) has the same Loki as a datasource for
dashboards.

### How logs get there

- **Staging slots / ops containers**: the observability promtail's docker
  discovery ships any container with `matrixos` in its name. Nothing to do.
- **VPSes (preview or fleet)**: Grafana Alloy, installed by
  `matrix-install-logship` (ships in the host bundle `bin/`). It tails the
  matrix systemd units and the kernel JSONL logs, labels streams with
  `handle` and `env`, and dual-writes to PostHog Logs via OTLP/HTTP plus the
  existing `https://logs.matrix-os.com` Loki ingest edge. Loki is retained only
  as the `preview-logs.sh` compatibility path until the self-hosted
  observability stack retirement slice removes it. Enroll a VPS once from the
  ops box:

  ```bash
  PLATFORM_SECRET=... LOGS_INGEST_USER=fleet LOGS_INGEST_PASSWORD=... POSTHOG_PROJECT_TOKEN=<project-token> \
    ./scripts/enable-vps-logship.sh <handle> <preview|prod|staging>
  ```

  Credentials live in `~/matrix-os/.env`; the edge's bcrypt hash lives in
  `distro/observability/logs-edge/logs-edge.env` (gitignored; see the
  `.example`). Rotate by regenerating both and recreating `logs-edge`, then
  re-running enrollment.
- **Fleet auto-enrollment** (every new customer VPS ships logs from first
  boot) requires platform cloud-init templating and is deferred — spec 093.

## Operational notes

- The tunnel config (`distro/cloudflared.yml`) and observability compose are
  live, bind-mounted configs on the ops VPS — merged changes there must be
  applied by restarting the respective containers.
- Staging slot DNS (`staging-<1..4>`, `api-staging-<1..4>`, `logs`) was created
  once via `cloudflared tunnel route dns matrix-os <hostname>`.
- Preview bundles in R2 (`system-bundles/0.0.0-pr*`) can be cleaned after PR
  close; they are never referenced by channel pointers.
