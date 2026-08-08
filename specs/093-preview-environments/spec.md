# Spec 093: Preview Environments and Centralized Dev Logging

## Problem

Production Matrix OS is VPS-native per user (host systemd services) with the platform
on Cloud Run. Local Docker stacks are therefore not production-shaped, and coding
agents working on feature branches have no way to observe a running stack: dev process
output evaporates in terminals, customer VPSes ship no logs anywhere, and browser
console output is invisible. Every feature type needs a different test surface (shell
changes need a runtime, onboarding needs a virgin VPS, the macOS app needs a runtime to
connect to, CLI betas need a paired shell), and today each is assembled by hand.

## Goals

1. One preview surface per feature type, all cloud-based and production-shaped.
2. Centralized logs: every preview environment (and, by rollout, the production fleet)
   ships logs to the existing Loki on the ops VPS, queryable by one agent-facing
   contract.
3. Agents discover and operate all of this through a skill and dev docs, without human
   hand-holding.

## Non-Goals

- Replacing the local `bun run dev` inner loop for sub-second HMR on a laptop.
- Metrics shipping (Prometheus remote-write) — logs first; metrics are a follow-up.
- Per-VPS unique ingest credentials in v1 (single rotating credential; see Security).
- Production fleet auto-enrollment in v1 (explicit per-VPS enablement; see Rollout).

## Surfaces by Feature Type

| Feature type | Surface | Mechanism |
|---|---|---|
| Shell / gateway / kernel | Preview VPS `pr-<N>` | CI label `preview-vps`: build bundle `0.0.0-pr<N>.<sha7>`, publish to R2, provision + deploy via platform API, PR comment with `app.matrix-os.com/vm/pr-<N>` |
| Onboarding | Fresh preview VPS | Same pipeline; a newly provisioned VPS is virgin by construction |
| Platform (Cloud Run) | Tagged preview revision | CI label `preview-platform`: build image, deploy to the dedicated preview service with `--tag pr-<N> --no-traffic` |
| macOS app | CI `.app` artifact + any preview VPS | `macos-086.yml` artifact, runtime switcher `app.matrix-os.com/vm/<handle>` |
| CLI beta x shell | npm dist-tag + preview VPS | `matrixos@pr-<N>` dist-tag paired via `~/.matrixos` profiles (068). Deferred: dist-tag automation ships publish AND removal together (`npm dist-tag rm` on PR close) -- a dangling dist-tag is publicly reachable forever |
| Fast UI iteration (HMR) | Staging slot `staging-<1..4>.matrix-os.com` | Per-worktree HMR container on the ops VPS behind the existing tunnel |

## Architecture

### Logging spine

- **Ingest edge**: a Caddy container (`logs-edge`) on the ops VPS, exposed only through
  the cloudflared tunnel as `logs.matrix-os.com`. It forwards exactly one path prefix —
  `POST /loki/api/v1/push` — to the internal Loki, behind HTTP basic auth. Everything
  else returns 404. Loki itself stays loopback-bound (PR #484).
- **Shipper**: Grafana Alloy (pinned version, checksum-verified) on each enrolled VPS,
  installed by a new self-contained host-bin script `matrix-install-logship`. It tails
  journald units (`matrix-gateway`, `matrix-shell`, `matrix-sync-agent`, `matrix-code`,
  `matrix-symphony`) and the kernel JSONL logs under the Matrix home, labeling streams
  with `handle`, `env` (`preview` | `prod` | `staging`), `source`, and `unit`.
- **Ops VPS local logs**: the existing promtail continues to ship docker container logs
  (which now include staging slots) directly to Loki on the internal network.
- **Query contract**: `scripts/preview-logs.sh` — curl/jq wrapper over the Loki query
  API (loopback on the ops VPS; `LOKI_URL`/credentials overridable). Selectors:
  `--handle pr-123`, `--slot 2`, `--unit matrix-gateway`, `--grep`, `--since`.

### Preview VPS pipeline (`.github/workflows/preview-vps.yml`)

- Trigger: PR labeled `preview-vps` (on label add and on synchronize while labeled),
  plus `workflow_dispatch` for manual runs.
- Build: reuse `scripts/build-host-bundle.sh` with
  `HOST_BUNDLE_VERSION=0.0.0-pr<N>.<sha7>`; version format passes the platform's
  release validation (`/^[A-Za-z0-9._-]{1,128}$/`).
- Publish: `scripts/publish-release.sh` **without** `--channel` — the release is
  registered but never promoted; no channel pointer can ever select a PR bundle.
- Provision: `POST /vps/preview/provision` with a dedicated
  `PREVIEW_CLERK_USER_ID` secret and identical `handle` / `runtimeSlot` values of
  `pr-<N>`. The platform commits the machine and its durable provisioning job in one
  transaction before returning `202`; the workflow rejects an accepted response unless
  that exact machine is immediately visible in `/vps/fleet`.
- Deploy: `POST /vps/deploy {"version": "...", "handle": "pr-<N>"}` — version-pinned,
  single-handle. Never channel-wide.
- Report: PR comment with the VM URL, bundle version, and log-query one-liner.
- Teardown: on PR `closed`, look up the machineId for `pr-<N>` in `/vps/fleet` and
  `DELETE /vps/<machineId>`. A scheduled reaper job (daily) deletes any `pr-*` VPS
  whose PR is closed or whose age exceeds 72h, so orphans cannot accumulate Hetzner
  cost.

### Platform preview revisions (`.github/workflows/preview-platform.yml`, scaffold)

- Trigger: PR labeled `preview-platform`.
- Deploys the platform image to a **dedicated preview Cloud Run service**
  (`CLOUD_RUN_PREVIEW_SERVICE`), never the production service, with
  `--tag pr-<N> --no-traffic`, using preview-scoped secrets (separate database URL —
  Neon branch databases are the intended pairing, deferred). The job no-ops with a
  clear message when preview secrets are not configured.
- Teardown mirrors the VPS model: on PR close the workflow removes the `pr-<N>`
  traffic tag and deletes its revision(s), so labeled PRs cannot accumulate
  revisions in the preview service. A periodic sweeper for revisions that escape
  close-teardown ships with the Neon automation (deferred).

### Staging slots (`scripts/staging-slot.sh` + `docker-compose.staging-slot.yml`)

- Four fixed slots: `staging-<n>.matrix-os.com` / `api-staging-<n>.matrix-os.com`
  (n = 1..4), pre-registered in the tunnel config and DNS — no Cloudflare API calls at
  slot-claim time.
- `staging-slot.sh up <worktree-path>` claims the lowest free slot (state file with an
  exclusive-create lock), runs the HMR dev container from that worktree's source with
  `COMPOSE_PROJECT_NAME=mx-staging-<n>`, and prints the URL. `down`, `status`, and
  `logs` subcommands complete the lifecycle. Slots idle longer than the TTL are
  reclaimable by `status --reap`.
- Slot containers match the existing promtail docker discovery (name contains
  `matrixos`), so slot logs flow to Loki with no extra wiring.

## Security Architecture

### Auth matrix

| Surface | AuthN | AuthZ | Notes |
|---|---|---|---|
| `logs.matrix-os.com` (ingest) | HTTP basic auth (bcrypt hash in Caddy config, secret from `.env`) | push-only: `POST /loki/api/v1/push`; all other paths 404 | Tunnel-only; no host port. Query APIs are NOT exposed. |
| Loki query | none (loopback) | reachable only from ops VPS / docker network | Agents query via `preview-logs.sh` on the ops box or via Grafana |
| Platform API calls in CI | `Authorization: Bearer PLATFORM_SECRET` (repo secret) | existing platform route guards | Same secret host-bundle-release.yml already uses |
| `POST /vps/preview/provision` | `Authorization: Bearer PLATFORM_SECRET` | operator-only preview provisioning | Accepts only identical `pr-<N>` handles and runtime slots, rejects caller-selected server types, writes a server-owned preview class, and uses a separate bounded preview capacity limit without weakening customer billing entitlements. |
| Preview VPS shell | Clerk (existing) | VPS bound to `PREVIEW_CLERK_USER_ID` | Team members use the runtime switcher with their own Clerk session per existing platform rules |
| Staging slots | Tunnel hostname only | no new auth (matches existing `staging.matrix-os.com` posture) | Slots run branch code with dev credentials only; never production secrets |
| Cloud Run preview | gcloud OIDC (existing workflow auth) | dedicated preview service + preview secrets | Production service and secrets are never referenced |

### Input validation

- `staging-slot.sh`: slot index validated against `[1-4]`; worktree path must resolve
  inside `~/matrix-os.worktrees/` or be an existing registered git worktree; PR/branch
  metadata stored, never interpolated into shell unquoted.
- Workflow inputs: PR number comes from the GitHub event payload (integer), handle is
  constructed as `pr-<N>` and therefore always matches the platform's handle regex.
- Preview provisioning validates the CI-derived handle and runtime slot again at the
  platform boundary, requires them to be identical, rejects unknown fields, and uses
  the mutating-route body limit before JSON parsing.
- Preview accounting requires both the validated `pr-<N>` shape and the persisted
  server-owned `preview` provisioning class. Normal customer provisioning always
  writes `customer`, so customer-selected handles or runtime slots cannot bypass
  billing slot enforcement. The authenticated operator path may adopt an existing
  matching row before excluding it from customer billing. Exact per-PR lookup falls
  back to the same owner's matching legacy `runtimeSlot: preview` row under the
  owner provisioning lock, so migration cannot create a duplicate provider server. Exact slots
  must match the requested handle or fail with a generic conflict, and a live
  matching legacy row wins over a failed exact row during migration. The failed
  duplicate is retired and queued for provider cleanup before capacity is checked.
- Provisioning jobs use bounded Postgres rows with encrypted, size-limited bootstrap
  payloads. A leased worker claim dispatches provider creation; completed and failed
  jobs clear the payload. Expired claims are eligible for bounded reconciliation.
- `matrix-install-logship`: URL must be `https://`, handle must match
  `^[a-z0-9][a-z0-9-]{1,62}$`, env must be one of `preview|prod|staging`; the Alloy
  binary download is pinned to an exact version and verified against a recorded
  sha256 before install.

### Error policy

- CI jobs surface platform API failures with status codes only; response bodies are
  not echoed into PR comments (they can contain infrastructure details). Full bodies
  go to the workflow log, which is repo-private.
- `preview-logs.sh` prints Loki errors verbatim (operator tool on the ops box).
- `logs-edge` returns generic 401/404; no upstream details.

## Failure Modes

- **Bundle build fails**: no publish, no deploy; PR comment is only posted on success.
- **Provision succeeds, deploy fails**: VPS exists with channel-default bundle. The
  deploy step retries once; on persistent failure the job fails loudly and the PR
  comment is replaced by a failure note with the handle so teardown still works.
  Orphan state is acceptable: the reaper deletes it within 72h regardless.
- **Provision enqueue fails**: the machine insert rolls back with the job insert and
  the route returns a generic non-success response. A successful response is never
  allowed for a machine that is absent from the authoritative fleet read.
- **Teardown fails on PR close**: the scheduled reaper is the backstop (same deletion
  code path). Reaper failures alert via workflow failure notifications.
- **Two PRs race for a staging slot**: slot claim uses `O_EXCL` lock-file creation;
  the loser gets the next slot or a clear "no free slots" error listing current owners.
- **logs-edge or Loki down**: Alloy buffers and retries with backoff (bounded WAL);
  VPS services are never blocked by log shipping (shipper is an independent unit,
  `Wants=`/`After=` only).
- **Credential leak of ingest secret**: blast radius is log injection (write-only
  endpoint). Rotate by updating `.env` + restarting `logs-edge`, then re-running
  `matrix-install-logship` on enrolled VPSes. Documented in runbook.
- **Reaper deletes a VPS still in use**: only `pr-*` handles are eligible, never
  `primary` runtime slots, and PR-open state is checked before age-based deletion.
- **Reaper cannot confirm PR state** (GitHub API failure/rate limit): fail-safe —
  that VPS is skipped, never deleted on unknown state, and age-based deletion also
  requires a confirmed state. The reaper job exits non-zero after processing when
  any lookup failed, so repeated skips surface as workflow failures instead of
  silently accumulating orphans.

## Resource Management

- Loki retention: existing config; preview labels make `{env="preview"}` streams
  cheap to delete; retention policy documented (follow-up: per-tenant limits).
- Alloy: bounded WAL/backpressure; install pinned and idempotent (re-running upgrades
  config in place).
- Staging slots: hard cap of 4 concurrent; slot state file caps entries at 4; TTL reap
  for idle slots; `down` removes containers and the per-slot named volumes are reused
  per slot (bounded count).
- Preview VPSes: hard TTL 72h via reaper; one VPS per PR (idempotent provision).
- Concurrent preview provisioning is serialized by the owner provisioning lock and
  capped separately from customer billing slots. `CUSTOMER_VPS_PREVIEW_PROVISIONING_LIMIT`
  defaults to 8 and rejects values outside the bounded range 1-16. Preview rows are
  excluded from customer entitlement counts, while non-deleted failed preview rows
  continue to consume preview capacity until their slot is retried or deleted.
- Cloud Run preview revisions: deleted on PR close (see Architecture); bounded by
  open labeled PRs.
- Logship enrollment inventory: `enable-vps-logship.sh` records every enrolled
  handle in an ops-side inventory file (`~/.matrixos/logship-enrolled.tsv`), giving
  credential rotation a concrete target list for the re-enrollment runbook.
- CI: preview jobs use `concurrency: preview-vps-<N>` with cancel-in-progress to avoid
  pile-ups on rapid pushes.

## Integration Wiring

- `logs-edge` joins the existing `observability` docker network next to Loki; tunnel
  ingress added in `distro/cloudflared.yml` (live config, bind-mounted).
- `matrix-install-logship` ships in the host bundle `bin/` (build-host-bundle.sh
  already copies `distro/customer-vps/host-bin/`). Enablement v1: invoked over SSH
  from the ops box (extension of the `staging-platform-vps` flow) with the ingest URL
  and credential. Follow-up (deferred): platform writes `/opt/matrix/env/logship.env`
  at provision time via cloud-init template vars so new VPSes auto-enroll.
- `preview-vps.yml` mirrors `host-bundle-release.yml` secrets exactly; one new secret
  (`PREVIEW_CLERK_USER_ID`), no new permissions.
- Skill `.claude/skills/preview-env/` + `docs/dev/preview-environments.md` are the
  discovery layer; AGENTS.md gets a one-line reference.

## Deferred Scope

- Platform-side cloud-init templating for automatic logship enrollment of every new
  VPS (follow-up issue; v1 is explicit per-VPS enablement).
- Prometheus remote-write (metrics) from VPSes.
- Neon branch-database automation for platform previews.
- Browser-console forwarding from preview shells into Loki (debug build flag).
- Per-VPS unique ingest credentials / Loki multi-tenancy.
