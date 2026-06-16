# Spec 094: Delivery Acceleration

## Problem

Urgent Matrix OS fixes currently take the same heavy delivery path as broad platform
changes. A small pre-VPS app-shell routing fix can trigger the full Platform Cloud Run
workflow: fresh dependency installs, platform/gateway/kernel builds, a Next production
build, image push, candidate deploy, smoke, and traffic promotion. During the June 16,
2026 billing setup incident, the code fix was merged quickly, but production remained
on the old platform image while the image build continued. Users could not safely retry
until Cloud Run promoted the new revision.

Customer runtime delivery has a parallel problem. Host-bundle updates are correct for
VPS-native production, but every update is treated as a full bundle replacement. That
is simple and safe, but too slow for narrow customer-runtime fixes and wasteful for
small shell/app changes.

Matrix OS needs a delivery system that routes each bug or feature to the smallest
correct production surface, keeps urgent fixes fast, and preserves the same safety
bar: PR review, smoke checks, rollback, and live verification.

## Goals

1. **Route by affected surface**: platform API, pre-VPS app shell, app-domain edge
   routing, customer VPS runtime, website/docs, CLI, and observability each get an
   explicit deploy lane.
2. **Ship urgent platform/app-shell fixes in minutes** without rebuilding unrelated
   runtime surfaces.
3. **Support operator-selected deploy tags** so humans can force a specific lane or
   replay a lane for a known commit.
4. **Add incremental customer runtime updates** so VPSes download and apply only changed
   artifacts when that is safe.
5. **Keep production proof mandatory**: every lane ends with current revision/version
   evidence, traffic state, and a surface-specific smoke check.
6. **Make rollback first-class** for every deploy lane.

## Non-Goals

- Removing the PR, CI, Greptile, or review gates.
- Replacing local development workflows such as `bun run dev`.
- Using Docker Compose or per-user Docker containers as the production customer runtime.
- Bypassing Cloud Run smoke checks for normal production deploys.
- Building a full binary-delta engine in v1; v1 can use content-addressed file manifests
  and rsync/zstd-style transfer before more complex binary deltas.

## Delivery Surfaces

| Surface | Current path | Target path | Trigger examples |
|---|---|---|---|
| Pre-VPS app shell (`app.matrix-os.com` auth, billing, onboarding, runtime picker) | Full `matrix-platform` Cloud Run image | Dedicated app-shell deploy unit or cached shell-only image layer | `deploy/shell`, `shell/v*`, path changes under `shell/**` that affect pre-VPS routes |
| Platform API/control plane | Full `matrix-platform` Cloud Run image | Platform API image with app-shell dependency only when needed | `deploy/platform`, `platform/v*`, path changes under `packages/platform/**`, `packages/clerk-sync/**`, platform-owned observability dependencies, and `distro/customer-vps/cloud-init.yaml` provisioning inputs |
| App-domain edge router | Platform image side effects or ad hoc Worker deploy | Explicit edge/router lane, or a required paired shell+platform deploy while the router is embedded | `deploy/edge`, `edge/v*`, path changes under edge/router packages, app-domain route maps, Cloudflare Worker config, or platform route handlers that select pre-VPS shell vs active VPS proxy |
| Customer VPS runtime | Full host bundle build/publish/deploy | Manifested host bundle plus incremental update plan | `deploy/runtime`, existing `v*` tags, path changes under `shell/**` that affect active VPS shell, `packages/gateway/**`, `packages/kernel/**`, `packages/sync-client/**`, host-bundle-shipped `packages/**`, `home/**`, `distro/customer-vps/host-bin/**`, `distro/customer-vps/systemd/**`, and `scripts/build-host-bundle.sh` |
| Website/docs | Vercel/site deploy | Independent website/docs lane | `deploy/www`, path changes under `www/**` |
| CLI | npm/GitHub/Homebrew release | Independent CLI lane | `deploy/cli`, `cli-v*`, path changes under CLI package/scripts |
| Observability/ops | Ad hoc scripts or platform image side effects | Explicit ops lane with scoped smoke | `deploy/ops`, path changes under `packages/observability/**`, ops distro files |

## Operator Tags and Labels

### Tags

Tags are immutable release selectors. They should identify the target surface and the
source commit.

- `platform/vYYYY.MM.DD.N` deploys the platform API lane.
- `shell/vYYYY.MM.DD.N` deploys the pre-VPS app-shell lane.
- `edge/vYYYY.MM.DD.N` deploys app-domain router changes when the router is a separate
  deployable; before that split, edge changes must select the platform lane plus any
  paired shell/runtime lane needed by the route contract.
- `vX.Y.Z` remains the canonical customer host-bundle release tag in Phase 1.
- `www/vYYYY.MM.DD.N` deploys the website/docs lane.
- `cli-vX.Y.Z` publishes CLI artifacts, matching the existing release workflows.

Tags must never infer broad deployment. A `shell/*` tag cannot deploy customer VPSes,
and a customer runtime tag cannot redeploy Cloud Run unless explicitly paired with a
separate platform tag.

### Runtime tag migration

The live host-bundle workflow already uses `v*` tags and promotes `canary` by default.
Phase 1 must preserve that behavior. A future `runtime/vX.Y.Z` namespace may be added
only after the release workflow, docs, and channel-promotion runbooks are migrated in
one PR. Until that migration lands, `runtime/*` is invalid and must fail closed instead
of silently doing nothing.

### Labels and workflow dispatch

Labels are mutable PR controls. They select previews and optional pre-merge deploys.

- `deploy-platform-preview`
- `deploy-shell-preview`
- `deploy-edge-preview`
- `preview-vps`
- `skip-screenshots`
- `release-candidate`

`deploy/<lane>` values in the Delivery Surfaces table are manual dispatch selectors,
not git tags. Valid selectors are `deploy/platform`, `deploy/shell`, `deploy/edge`,
`deploy/runtime`, `deploy/www`, `deploy/cli`, and `deploy/ops`. They may appear as
workflow-dispatch inputs or checked-in operator script arguments; unknown selectors
fail closed before any build or deploy starts.

Workflow dispatch remains the emergency operator path. It must require:

- commit SHA,
- target lane,
- environment,
- promote yes/no,
- reason,
- rollback target when known.

Production dispatch SHAs must be reachable from `main` or from an approved immutable
release tag. Deploying an unmerged branch SHA is a separate break-glass path that must
record explicit human approval, bypass rationale, and rollback target in the workflow
summary.

## Architecture

### Lane router

Add a small delivery router script, `scripts/delivery/resolve-lanes.mjs`, that receives
a base SHA and head SHA, reads changed paths, and emits a JSON decision:

```json
{
  "lanes": ["shell"],
  "reason": "pre-vps shell files changed",
  "requires": ["react-doctor", "shell-smoke"],
  "blocked": []
}
```

Workflows call this script before building. A lane can be selected by path filters,
operator tag, PR label, or manual dispatch. Shell changes are not automatically
shell-lane-only: shared shell files that are bundled into customer VPSes must select the
runtime lane too unless the router can prove they affect only pre-VPS routes. Manual
selection must be included in the workflow summary so reviewers can see when an
operator overrode the automatic router.
If the router throws, exits non-zero, emits invalid JSON, or emits a lane outside the
enum, the workflow aborts before build/deploy and prints an actionable error. It must
never fall through to a permissive default lane.

### Split pre-VPS app shell from platform API

Today `Dockerfile.platform` packages:

- platform API,
- gateway/kernel build outputs,
- observability build outputs,
- customer VPS cloud-init files,
- the Next app shell,
- a startup script that launches both platform API and auth shell.

The target design creates a separate pre-VPS app-shell deploy unit:

- **App-shell service**: serves `/`, `/sign-in`, `/sign-up`, billing setup, plans,
  checkout return, device auth return, and runtime picker for users without an active
  VPS. It can call the platform API over an internal URL.
- **Platform API service**: owns control-plane API, billing webhooks, provisioning,
  fleet state, host-bundle release metadata, and customer routing decisions.
- **Edge router**: routes app-domain pre-VPS shell requests to the app-shell service,
  API/control-plane requests to the platform API service, and authenticated active
  runtime requests to the selected customer VPS proxy. This active-VPS route ownership
  is part of the split contract; non-API `app.matrix-os.com/*` requests must not fall
  back to the pre-VPS shell for users with an active machine.

If a full service split is too large for v1, v1 can still improve the current image:

- use BuildKit registry cache (`cache-from`/`cache-to`) in Cloud Build,
- cache pnpm store between builds,
- split Dockerfile stages so shell-only changes do not rebuild platform/gateway/kernel
  TypeScript outputs,
- avoid the second fresh dependency install when lockfile and prod dependency graph are
  unchanged,
- add a shell-only smoke assertion that `/?billing=setup` renders `BillingGate`, not
  `BootSequence`, for billing-owned entrypoints.

### Fast hotfix lane

The fast hotfix lane is for incidents where production is currently broken and the fix
has already passed PR review and focused tests.

Required sequence:

1. Confirm the PR is merged to `main` and record the merge SHA.
2. Capture the current live rollback target before building: Cloud Run revision and
   image digest for platform/shell lanes, installed version and manifest digest for
   runtime lanes, deployment ID for website, dist-tag/release pointer for CLI, or ops
   config revision for ops.
3. Build only the lane-specific artifact for that SHA.
4. Deploy as a no-traffic candidate revision.
5. Smoke the candidate URL with production-equivalent headers/secrets.
6. Promote candidate to 100% traffic.
7. Verify live service revision/image/artifact digest.
8. Query logs for the incident signature for at least one retry window.

Fast hotfix is not a local-machine deploy. It still runs through a workflow or a
checked-in script with the same environment variables and smoke checks as CI.

### Incremental customer runtime updates

Host bundles remain the canonical customer runtime release artifact, but each bundle
also publishes a manifest:

```json
{
  "version": "0.4.12",
  "baseVersion": "0.4.11",
  "files": [
    {
      "type": "file",
      "path": "app/shell/.next/server/app/page.js",
      "sha256": "...",
      "size": 12345,
      "mode": "0644",
      "url": "system-bundles/objects/sha256/..."
    }
  ],
  "symlinks": [
    {
      "path": "app/node_modules/@matrix-os/gateway",
      "target": "../../packages/gateway"
    }
  ],
  "delete": [],
  "requiresFullBundle": false,
  "protected": [
    "/home/matrix/home/system/desktop.json",
    "/home/matrix/home/system/theme.json",
    "/home/matrix/home/system/wallpapers/"
  ]
}
```

The v1 incremental manifest may update files and symlinks inside the staged app tree.
Symlink entries must include an explicit relative target and the resolved target must
remain inside the staged release tree. If a bundle diff changes non-app roots such as
`bin`, `runtime`, `systemd`, launchers, or unsupported symlink topology, publication
must mark `requiresFullBundle: true` and the VPS updater must use the full-bundle path
before staging. The updater must never write a mixed release where `/opt/matrix/app`
comes from the target version but `/opt/matrix/bin`, `/opt/matrix/runtime`, or systemd
units remain from a different target version.

The VPS update agent compares the installed manifest with the target manifest and
downloads only changed content-addressed objects. It stages changes under
`/opt/matrix/releases/<version>.staging`, verifies hashes, then atomically flips the
`/opt/matrix/app` symlink after all checks pass. Activation also records
`/opt/matrix/release.json` with the target version, manifest digest, activated path,
rollback version, and timestamp via tmp-then-rename while holding the updater lock.
Because `release.json` rename and symlink flip are separate filesystem operations and
cannot be committed atomically together, the lock is only a concurrency guard. The
updater also runs a startup and pre-update consistency check: compare
`/opt/matrix/release.json` with `/opt/matrix/app/BUNDLE_VERSION` and the installed
manifest digest. Any mismatch fails closed before applying deltas and enters recovery:
repair `release.json` from the symlink target when the target tree verifies against a
known installed manifest, otherwise perform a full-bundle reinstall or require operator
intervention.

Protected owner data remains outside the update set. Incremental updates may replace
`/opt/matrix/app` only. They must never write owner data under `$MATRIX_HOME`.

### Rollback

Each lane stores enough metadata to roll back without guessing:

- Cloud Run lane: previous revision name, image digest, traffic split.
- App-shell lane: previous artifact version or Cloud Run revision.
- Edge lane: previous Worker/script version, route-map revision, and active traffic
  binding.
- Customer runtime lane: previous host-bundle version and manifest digest per VPS.
- Website lane: previous deployment ID.
- CLI lane: previous npm dist-tag and GitHub release pointer.
- Ops lane: previous applied config revision, affected service/unit names, and the
  command or workflow needed to restore the prior config.

Rollback must be a workflow action, not an undocumented operator command.

## Security Architecture

### Auth matrix

| Surface | AuthN | AuthZ | Notes |
|---|---|---|---|
| Delivery router script | GitHub Actions checkout or local operator shell | Read-only repo diff | No secrets. Emits lane decisions only. |
| Cloud Run deploy workflows | GitHub OIDC to GCP | Environment-scoped service account | Production and preview environments use separate GitHub environments. |
| App-shell internal API calls | Service-to-service identity or shared internal token | Platform API allowlist | Do not expose platform secrets to browser code. |
| Edge router deploy workflow | GitHub OIDC or provider-scoped deploy token | App-domain route-map deploy permission | Edge secrets stay provider-side; route decisions never trust user-controlled headers. |
| Host-bundle manifest publish | Existing platform secret / release workflow identity | Release registration route | Manifest registration follows the same auth as full bundle registration. |
| VPS incremental updater | Existing platform verification token | Per-handle deploy authorization | A VPS may only fetch manifests/releases selected for its handle/channel. |
| Manual workflow dispatch | GitHub user + environment approval when configured | Lane-specific workflow permissions | Dispatch reason and SHA are recorded in workflow summary. |

### Input validation

- Lane names are an enum: `platform`, `shell`, `edge`, `runtime`, `www`, `cli`, `ops`.
- Tag names must match a lane-specific pattern. Unknown tags fail closed.
- Workflow dispatch SHA must resolve to a commit in the repository.
- Production workflow dispatch SHA must be reachable from `main` or an approved release
  tag unless the break-glass path with explicit human approval is used.
- Host-bundle manifest paths must be normalized relative paths, must not contain `..`,
  and must target only `/opt/matrix/app` staging content.
- Host-bundle manifest entry types are allowlisted: `file`, `directory`, and `symlink`.
  Unknown types fail before download or staging.
- Host-bundle manifest symlinks must have normalized relative paths and relative targets
  whose resolved target stays inside the staged release tree. Absolute symlink targets,
  owner-data targets, and targets escaping the release tree are rejected.
- Host-bundle manifests that touch non-app roots, launchers, service units, or unsupported
  symlink topology must set `requiresFullBundle: true`; an incremental updater must
  fail before staging if it cannot honor that fallback.
- Host-bundle manifest `files[].url` values must be platform-API-relative object paths
  under `system-bundles/objects/sha256/<sha256>` or absolute `https://` URLs whose host
  exactly matches the release metadata's allowlisted bundle object host. Reject URL
  credentials, IP literals, private/loopback/link-local hosts, non-HTTPS schemes, `..`
  segments, and redirects. Object fetches use `redirect: "error"` and
  `AbortSignal.timeout(30000)`.
- Manifest file modes are allowlisted (`0644`, `0755`, directory modes as needed).
- Delete entries are allowed only inside the staged app tree.
- Candidate smoke URLs are generated by Cloud Run, not operator-provided free-form URLs.

### Error policy

- Workflow summaries show lane, SHA, artifact digest, revision/version, and coarse
  pass/fail state.
- Secret values, raw provider errors, signed URLs, and internal database errors are
  never written to PR comments.
- Candidate smoke failures include the failed check name, not raw response bodies.
- Runtime update failures are reported as coarse phases: download, verify, stage,
  activate, restart, health.

### Credential handling

- Browser-facing shell builds receive only `NEXT_PUBLIC_*` values.
- Service secrets stay in Cloud Run secret references or platform-owned secret stores.
- Incremental manifest object URLs are short-lived signed URLs or fetched through the
  platform API; manifests do not contain permanent credentials.

## Failure Modes

- **Automatic lane detection misses a dependency**: manual labels/tags can force a
  broader lane. The router emits reasons and changed path evidence in workflow output.
- **Lane router fails or emits invalid output**: fail closed before build/deploy. The
  workflow must not default to `platform`, `runtime`, or "all lanes" because that can
  silently ship the wrong surface.
- **Two deploys race**: lane workflows use concurrency groups per environment and lane.
  Production `shell` and `platform` lanes serialize independently unless they target
  the same Cloud Run service.
- **Related lanes promote independently**: when a PR changes an app-shell/API contract,
  edge routing contract, or runtime/platform contract, either the contracts must be
  backward-compatible across old and new revisions or the router must select a combined
  promotion group with ordered candidate smokes before any lane receives production
  traffic.
- **Fast hotfix candidate fails smoke**: do not promote; leave current production
  traffic untouched; workflow prints candidate revision for cleanup.
- **Cloud Run promotion succeeds but verification fails**: automatically roll traffic
  back to the previously recorded revision and fail the workflow.
- **Incremental update verification fails**: keep the current `/opt/matrix/app` symlink,
  delete the staging directory, and report failure to platform.
- **Runtime preflight fails**: do not activate the staged tree, keep the current
  symlink/release metadata untouched, delete or quarantine the staging directory, and
  report the coarse `preflight` phase to platform.
- **Incremental manifest base mismatch**: if the installed manifest/version does not
  match `manifest.baseVersion`, do not apply file deltas. Fall back to a full-bundle
  install when allowed by the release policy, or fail before staging with an explicit
  base-mismatch error.
- **Incremental manifest requires full bundle**: if `requiresFullBundle` is true, a
  non-app root changed, or symlink topology cannot be represented safely, do not apply
  partial deltas. Use the full-bundle install path or fail before staging according to
  release policy.
- **Runtime metadata split-brain**: if `/opt/matrix/release.json` and
  `/opt/matrix/app/BUNDLE_VERSION` disagree after crash, restart, or before a new
  update, stop incremental updates. Recover by deriving `release.json` from the
  verified symlink target when possible; otherwise run a full-bundle reinstall or
  surface a manual recovery requirement.
- **Activation succeeds but service health fails**: flip symlink back to the previous
  release, restart services, and mark the target release failed for that handle.
- **Manifest references a missing object**: fail before activation; release publication
  should also verify object existence before registration.
- **Operator dispatches wrong lane**: dispatch requires explicit SHA and lane; workflow
  summary records the override; smoke checks remain lane-specific backstops.

## Resource Management

- Cloud Run revisions are capped by scheduled cleanup: keep the currently live revision,
  the previous rollback revision, and recent preview/candidate revisions still attached
  to open PRs.
- Build cache uses a bounded Artifact Registry cache tag/prefix with TTL cleanup.
- Incremental object storage is content-addressed. Objects referenced by live channel
  manifests, rollback manifests, or active VPS installed versions are retained; orphaned
  objects are garbage-collected after a grace period.
- VPS staging directories are bounded: at most one active staging directory per update
  plus the current and previous release directories. The updater takes an exclusive
  advisory lock before downloading into a staging directory and holds it through service
  restart. Startup and failed-update cleanup delete abandoned `.staging` directories
  older than 24h using symlink-safe `lstat()` traversal; active lock holders are never
  cleaned.
- Update agents must use bounded download concurrency and timeouts.

## Integration Wiring

### Workflow split

Add or refactor workflows around lanes:

- `.github/workflows/deploy-platform.yml`
- `.github/workflows/deploy-shell.yml`
- `.github/workflows/deploy-edge.yml`
- `.github/workflows/host-bundle-release.yml`
- `.github/workflows/deploy-www.yml`
- `.github/workflows/cli-release.yml`
- `.github/workflows/delivery-router.yml` or shared composite action

Each production workflow writes a final summary with:

- source SHA,
- lane,
- artifact/image digest,
- candidate revision/version,
- promotion result,
- rollback target,
- verification command/result.

### Smoke checks

Minimum smoke checks:

- `shell`: `/sign-in` serves `data-matrix-auth-shell="true"`; `/?billing=setup`
  serves `data-matrix-billing-gate="true"` and does not serve
  `data-matrix-boot-sequence="true"`; checkout return routes do not call journey boot.
- `edge`: unauthenticated/no-active-VPS app-domain requests route to app-shell,
  API/control-plane requests route to platform API, and authenticated active-VPS
  app-domain requests proxy to the selected customer VPS.
- `platform`: `/health`, billing webhook route config, `/api/journey` with test auth,
  release metadata read.
- `runtime`: `/opt/matrix/app/BUNDLE_VERSION`, `/opt/matrix/release.json` target
  version, gateway health, shell health, sync-agent release version, app-domain route
  through platform to target VPS, websocket auth path.
- `www`: docs route, homepage route, canonical headers.
- `cli`: install, login/device auth smoke, version command, package dist-tag.
- `ops`: target config checksum, affected systemd/container unit health, log/metric
  ingestion continuity for the changed component, and rollback command dry-run.

### Runtime updater

The customer VPS updater runs in `matrix-sync-agent` or a dedicated systemd unit. It:

1. Fetches target release metadata from platform.
2. Acquires an exclusive advisory lock under `/opt/matrix/releases/`; a second updater
   waits with a bounded timeout or aborts with a clear structured log.
3. Runs startup/pre-update consistency checks comparing `/opt/matrix/release.json`,
   `/opt/matrix/app/BUNDLE_VERSION`, and the installed manifest digest; mismatch fails
   closed into the split-brain recovery path before deltas are considered.
4. Downloads manifest metadata and validates every `files[].url`, symlink target, and
   `requiresFullBundle` condition against the bundle object allowlist, release-tree
   containment, and redirect/timeout policy.
5. Compares `manifest.baseVersion` with the installed
   version from `/opt/matrix/release.json` and the installed manifest digest.
6. Falls back to full-bundle install when the base mismatches, `requiresFullBundle` is
   true, non-app roots changed, or symlink topology cannot be represented safely and
   policy allows it; otherwise fails before staging.
7. Downloads changed objects with bounded concurrency and 30s per-object timeouts.
8. Verifies every object hash and manifest signature/digest.
9. Stages app files under `/opt/matrix/releases/<version>.staging`.
10. Runs preflight checks: staged root ownership and mode are correct, free disk margin
    remains above the configured threshold, `BUNDLE_VERSION` matches the target version,
    manifest digest metadata is present, protected owner-data paths are absent from the
    staged tree, symlinks resolve inside the staged release tree, executable bits match
    the manifest, and any service-unit or launcher change has already forced the
    full-bundle path.
11. Activates the staged app tree under the updater lock by flipping `/opt/matrix/app`
   and writing `/opt/matrix/release.json` via tmp-then-rename. The startup/pre-update
   consistency check is the recovery mechanism if the process crashes between those
   filesystem operations.
12. Restarts affected services while still holding the updater lock.
13. Reports installed version and health back to platform, then releases the lock.

## Phased Plan

### Phase 1: Make the current path honest and faster

- Add a delivery router script and workflow summaries.
- Harden the existing Platform Cloud Run smoke test so billing-owned URLs must render
  `BillingGate`, not `BootSequence`.
- Add BuildKit/registry cache to `cloudbuild.platform.yaml`.
- Split Dockerfile stages enough that shell-only changes reuse platform/gateway/kernel
  build outputs where possible.
- Add a documented fast hotfix workflow dispatch using the existing full image but with
  explicit SHA, candidate smoke, promotion, and rollback metadata.
- Test checkpoint: `bun run test`, a router unit suite covering path/tag/dispatch
  decisions and fail-closed invalid output, and a manual Cloud Run dry-run/preview
  verification that proves billing-owned shell URLs render the billing gate marker.

### Phase 2: Split the pre-VPS app shell lane

- Extract app-shell service configuration and deploy workflow.
- Route app-domain pre-VPS shell paths to the app-shell lane.
- Keep platform API and billing/provisioning routes in the platform lane.
- Verify billing/signup/onboarding hotfixes can ship without rebuilding customer
  runtime or unrelated platform packages.
- Test checkpoint: `bun run test`, integration smoke that routes app-domain pre-VPS
  requests through app-shell to platform API without exposing service secrets, verifies
  authenticated active-VPS app-domain requests still proxy to the selected runtime, and
  a manual candidate-revision verification for `/sign-in`, `/?billing=setup`, checkout
  return, runtime picker, and active-runtime paths.

### Phase 3: Add incremental host-bundle manifests

- Publish file manifests next to every host bundle.
- Teach release registration to store manifest digest and object root.
- Implement VPS-side staging, verification, atomic activation, health report, and
  rollback.
- Keep full-bundle fallback until incremental update has proved stable across canary
  and beta channels.
- Test checkpoint: `bun run test`, an updater integration test that stages a synthetic
  manifest, rejects base-version mismatches/path traversal/bad object URLs/bad symlink
  targets/missing hashes, falls back or fails on `requiresFullBundle` and non-app-root
  changes, serializes concurrent updates with the updater lock, detects split-brain
  `release.json` vs `BUNDLE_VERSION` state, flips the app symlink, updates
  `/opt/matrix/release.json` via tmp-then-rename, reports health to a test platform
  endpoint, cleans abandoned staging directories, and manually verifies rollback on a
  disposable VPS.

### Phase 4: Delivery dashboard and SLOs

- Track lead time from merge to live per lane.
- Track artifact build time, deploy time, smoke time, and rollback time.
- Display current live SHA/version per surface.
- Alert when an urgent lane exceeds its SLO.
- Test checkpoint: `bun run test`, dashboard/API contract tests for recorded deploy
  events and rollback metadata, and a manual verification that a known PR shows
  merge-to-live timing for each lane it exercised.

## Success Metrics

- Pre-VPS shell hotfix median merge-to-live time under 5 minutes.
- Platform API hotfix median merge-to-live time under 10 minutes.
- Customer runtime no-op or small shell update downloads less than 20% of the full
  host-bundle bytes.
- Every production deploy has a recorded revision/version and rollback target.
- No customer-facing deploy requires guessing whether it belongs to Cloud Run or the
  customer VPS runtime.

## Deferred Scope

- Binary patch generation beyond content-addressed file manifests.
- Multi-region active-active platform deployment.
- Per-tenant runtime canary cohorts beyond existing channel/handle targeting.
- Automatic incident detection and self-triggered rollback.
- Replacing Cloud Run with a different platform runtime.
