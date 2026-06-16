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

1. **Route by affected surface**: platform API, pre-VPS app shell, customer VPS runtime,
   website/docs, CLI, and observability each get an explicit deploy lane.
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
| Platform API/control plane | Full `matrix-platform` Cloud Run image | Platform API image with app-shell dependency only when needed | `deploy/platform`, `platform/v*`, path changes under `packages/platform/**` |
| Customer VPS runtime | Full host bundle build/publish/deploy | Manifested host bundle plus incremental update plan | `deploy/runtime`, existing `v*` tags, path changes under `packages/gateway/**`, `packages/kernel/**`, `home/**` |
| Website/docs | Vercel/site deploy | Independent website/docs lane | `deploy/www`, path changes under `www/**` |
| CLI | npm/GitHub/Homebrew release | Independent CLI lane | `deploy/cli`, `cli/v*`, path changes under CLI package/scripts |
| Observability/ops | Ad hoc scripts or platform image side effects | Explicit ops lane with scoped smoke | `deploy/ops`, path changes under `packages/observability/**`, ops distro files |

## Operator Tags and Labels

### Tags

Tags are immutable release selectors. They should identify the target surface and the
source commit.

- `platform/vYYYY.MM.DD.N` deploys the platform API lane.
- `shell/vYYYY.MM.DD.N` deploys the pre-VPS app-shell lane.
- `vX.Y.Z` remains the canonical customer host-bundle release tag in Phase 1.
- `www/vYYYY.MM.DD.N` deploys the website/docs lane.
- `cli/vX.Y.Z` publishes CLI artifacts.

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
- `preview-vps`
- `skip-screenshots`
- `release-candidate`

Workflow dispatch remains the emergency operator path. It must require:

- commit SHA,
- target lane,
- environment,
- promote yes/no,
- reason,
- rollback target when known.

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
operator tag, PR label, or manual dispatch. Manual selection must be included in the
workflow summary so reviewers can see when an operator overrode the automatic router.
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
- **Edge router**: routes app-domain pre-VPS shell requests to the app-shell service
  and API/control-plane requests to the platform API service.

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
2. Build only the lane-specific artifact for that SHA.
3. Deploy as a no-traffic candidate revision.
4. Smoke the candidate URL with production-equivalent headers/secrets.
5. Promote candidate to 100% traffic.
6. Verify live service revision/image/artifact digest.
7. Query logs for the incident signature for at least one retry window.

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
      "path": "app/shell/.next/server/app/page.js",
      "sha256": "...",
      "size": 12345,
      "mode": "0644",
      "url": "system-bundles/objects/sha256/..."
    }
  ],
  "delete": [],
  "protected": [
    "/home/matrix/home/system/desktop.json",
    "/home/matrix/home/system/theme.json",
    "/home/matrix/home/system/wallpapers/"
  ]
}
```

The VPS update agent compares the installed manifest with the target manifest and
downloads only changed content-addressed objects. It stages changes under
`/opt/matrix/releases/<version>.staging`, verifies hashes, then atomically flips the
`/opt/matrix/app` symlink after all checks pass.

Protected owner data remains outside the update set. Incremental updates may replace
`/opt/matrix/app` only. They must never write owner data under `$MATRIX_HOME`.

### Rollback

Each lane stores enough metadata to roll back without guessing:

- Cloud Run lane: previous revision name, image digest, traffic split.
- App-shell lane: previous artifact version or Cloud Run revision.
- Customer runtime lane: previous host-bundle version and manifest digest per VPS.
- Website lane: previous deployment ID.
- CLI lane: previous npm dist-tag and GitHub release pointer.

Rollback must be a workflow action, not an undocumented operator command.

## Security Architecture

### Auth matrix

| Surface | AuthN | AuthZ | Notes |
|---|---|---|---|
| Delivery router script | GitHub Actions checkout or local operator shell | Read-only repo diff | No secrets. Emits lane decisions only. |
| Cloud Run deploy workflows | GitHub OIDC to GCP | Environment-scoped service account | Production and preview environments use separate GitHub environments. |
| App-shell internal API calls | Service-to-service identity or shared internal token | Platform API allowlist | Do not expose platform secrets to browser code. |
| Host-bundle manifest publish | Existing platform secret / release workflow identity | Release registration route | Manifest registration follows the same auth as full bundle registration. |
| VPS incremental updater | Existing platform verification token | Per-handle deploy authorization | A VPS may only fetch manifests/releases selected for its handle/channel. |
| Manual workflow dispatch | GitHub user + environment approval when configured | Lane-specific workflow permissions | Dispatch reason and SHA are recorded in workflow summary. |

### Input validation

- Lane names are an enum: `platform`, `shell`, `runtime`, `www`, `cli`, `ops`.
- Tag names must match a lane-specific pattern. Unknown tags fail closed.
- Workflow dispatch SHA must resolve to a commit in the repository.
- Host-bundle manifest paths must be normalized relative paths, must not contain `..`,
  and must target only `/opt/matrix/app` staging content.
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
- **Fast hotfix candidate fails smoke**: do not promote; leave current production
  traffic untouched; workflow prints candidate revision for cleanup.
- **Cloud Run promotion succeeds but verification fails**: automatically roll traffic
  back to the previously recorded revision and fail the workflow.
- **Incremental update verification fails**: keep the current `/opt/matrix/app` symlink,
  delete the staging directory, and report failure to platform.
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
  plus the current and previous release directories.
- Update agents must use bounded download concurrency and timeouts.

## Integration Wiring

### Workflow split

Add or refactor workflows around lanes:

- `.github/workflows/deploy-platform.yml`
- `.github/workflows/deploy-shell.yml`
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
- `platform`: `/health`, billing webhook route config, `/api/journey` with test auth,
  release metadata read.
- `runtime`: gateway health, shell health, sync-agent release version, app-domain route
  through platform to target VPS, websocket auth path.
- `www`: docs route, homepage route, canonical headers.
- `cli`: install, login/device auth smoke, version command, package dist-tag.

### Runtime updater

The customer VPS updater runs in `matrix-sync-agent` or a dedicated systemd unit. It:

1. Fetches target release metadata from platform.
2. Downloads manifest and changed objects.
3. Verifies every object hash and manifest signature/digest.
4. Stages app files under `/opt/matrix/releases/<version>.staging`.
5. Runs preflight checks.
6. Atomically activates the release.
7. Restarts affected services.
8. Reports installed version and health back to platform.

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
  requests through app-shell to platform API without exposing service secrets, and a
  manual candidate-revision verification for `/sign-in`, `/?billing=setup`, checkout
  return, and runtime picker paths.

### Phase 3: Add incremental host-bundle manifests

- Publish file manifests next to every host bundle.
- Teach release registration to store manifest digest and object root.
- Implement VPS-side staging, verification, atomic activation, health report, and
  rollback.
- Keep full-bundle fallback until incremental update has proved stable across canary
  and beta channels.
- Test checkpoint: `bun run test`, an updater integration test that stages a synthetic
  manifest, rejects path traversal/missing hashes, flips the app symlink atomically,
  reports health to a test platform endpoint, and manually verifies rollback on a
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
