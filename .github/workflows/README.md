# GitHub Actions Workflows

This directory owns the GitHub Actions workflows for Matrix OS. Keep workflow
changes small and explicit: PR checks optimize for actionable signal, while
main, release, and scheduled workflows preserve comprehensive validation.

## Required Checks

The branch protection rule should require `CI Results` from `ci.yml` as the stable
aggregate gate. Do not require every internal shard directly unless branch
protection is also updated when the shard list changes.

`CI Results` depends on:

- `Detect CI-relevant changes`
- `Type Check`
- `Pattern Scan`
- `React Doctor`
- `Sync Client Package (Node 20)`
- `Unit Tests`
- `Docs Contract Tests`
- `E2E Tests`

The aggregate job writes a summary table and fails when any required internal
job fails or is cancelled. Internal jobs may still be inspected directly for
logs and artifacts.

Docs-only changes still run targeted docs contract tests through `Docs Contract Tests`.
Expensive jobs remain path-aware.

## Release Artifacts

Matrix OS does not publish customer runtime Docker images. The customer runtime
ships only as immutable VPS host bundles registered in platform Postgres.
Docker remains supported for local development and CI validation only;
`docker-test.yml` build artifacts are ephemeral and are never pushed to a
container registry.

The platform service still uses a container image because Cloud Run consumes
one. That image is a control-plane deployment artifact in Google Artifact
Registry, not a Matrix customer-runtime package.

| Surface | Released artifact | Destination | Publisher |
| --- | --- | --- | --- |
| Customer runtime | VPS host bundle | R2 bundle storage plus platform release/channel metadata | `host-bundle-release.yml` |
| Platform | Platform service image | Google Artifact Registry, then Cloud Run | `platform-cloud-run.yml` |
| Mobile native | Mobile native builds | EAS Build, then App Store Connect/TestFlight or Google Play | EAS operator flow in `docs/dev/mobile-shell.md` |
| Mobile OTA | Mobile OTA update | EAS Update branch/channel | EAS operator flow in `docs/dev/mobile-shell.md` |
| Desktop | Desktop installers and OTA metadata | GitHub Releases | `desktop-release.yml` and `desktop-release-canary.yml` |
| CLI | `@finnaai/matrix` CLI plus standalone binaries | npm, GitHub Releases, and Homebrew | `release.yml` and `cli-release.yml` |

Only `@finnaai/matrix` is a language package published to a package registry.
The other rows are bundles, service deployment artifacts, native installers, or
OTA payloads.

## Workflow Ownership

| Workflow | Owner | When it runs | Required? |
| --- | --- | --- | --- |
| `ci.yml` | Core code validation | `ready-for-ci`, ready PRs, merge queue, `main`, manual | Yes, via `CI Results` |
| `docker-test.yml` | Legacy/local Docker scenario validation | Docker/local-runtime changes on `ready-for-ci`, ready PRs, and `main`; every merge queue, nightly, and manual run | Required when Docker/local-runtime paths are touched |
| `host-bundle-release.yml` | VPS-native customer runtime release | `main`, `v*` tags, manual | Required for host bundle publishing |
| `platform-cloud-run.yml` | Platform/app-shell Cloud Run deployment | `main` when platform/auth-shell inputs change, manual | Required for app.matrix-os.com platform changes |
| `release.yml` / `cli-release.yml` | Installable `@finnaai/matrix` CLI release plus standalone binaries | Manual CLI release | Required for CLI publishing |
| `pr-title.yml` | Conventional Commit PR title policy | PR title changes | Yes |

## Delivery Lane Router

Use `scripts/delivery/resolve-lanes.mjs` before lane-specific build or deploy
jobs. The router accepts either a git diff range:

```bash
node scripts/delivery/resolve-lanes.mjs --base "$BASE_SHA" --head "$HEAD_SHA"
```

or explicit operator inputs:

```bash
node scripts/delivery/resolve-lanes.mjs --selector deploy/shell --tag shell/v2026.06.16.1
```

It emits a JSON object with `lanes`, `reason`, `requires`, and `blocked`.
Workflows must fail closed if the script exits non-zero, emits invalid JSON, or
returns an unknown lane. `runtime/*` tags are intentionally invalid until the
host-bundle release workflow migrates away from the existing `v*` runtime tag
contract.

## Docker Relevance Router

Use `scripts/ci/docker-relevance.mjs` as the source of truth for whether a PR or
`main` push needs the legacy/local Docker validation. It includes the dev image,
Compose and startup configuration, Docker scenario harness, root workspace
metadata, gateway/kernel/shell dependencies, home templates, and the shared
sync-client protocol and package export manifest imported by the gateway.
Platform-only, proxy-only, installable CLI, desktop/mobile, docs/specs, and
unrelated workflow changes do not spend a Docker runner.

The PR and `main` paths are relevance-filtered for cost and signal. The merge
queue, nightly, and manual runs remain comprehensive so an incomplete path rule
cannot silently remove the recurring full scenario coverage. Classification
errors fail the workflow instead of being interpreted as an irrelevant change.

## Release Rules

The `Host Bundle Release` workflow publishes code that customer VPSes install
under `/opt/matrix/app`. For that reason, host bundle release tests are blocking:
typecheck or unit-test failures must stop the workflow before build or publish.

Release workflows must not skip host-bundle, shell, or default-app validation
based only on changed-file heuristics. Path-aware skips are acceptable for PR
speed, but `main`, tag, and manual release paths should stay comprehensive.

The host bundle workflow may skip a dev bundle only for an explicit manual
maintenance dispatch using `skip_dev_bundle`. Commit-message markers and
metadata-only path detection are not accepted release skips.

## Visual Evidence

Screenshot workflow removed: visual evidence should be attached manually to PRs
that change shell UI behavior until a cheaper, reliable visual check is added.

For UI PRs, reviewers may still require screenshot evidence in the PR body.
