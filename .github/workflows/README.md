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
- `Sync Client Package`
- `Unit Tests`
- `E2E Tests`

The aggregate job writes a summary table and fails when any required internal
job fails or is cancelled. Internal jobs may still be inspected directly for
logs and artifacts.

## Workflow Ownership

| Workflow | Owner | When it runs | Required? |
| --- | --- | --- | --- |
| `ci.yml` | Core code validation | `ready-for-ci`, ready PRs, merge queue, `main`, manual | Yes, via `CI Results` |
| `docker-test.yml` | Legacy/local Docker scenario validation | `ready-for-ci`, ready PRs, merge queue, `main`, nightly, manual | Required when Docker/runtime paths are touched |
| `host-bundle-release.yml` | VPS-native customer runtime release | `main`, `v*` tags, manual | Required for host bundle publishing |
| `platform-cloud-run.yml` | Platform/app-shell Cloud Run deployment | `main` when platform/auth-shell inputs change, manual | Required for app.matrix-os.com platform changes |
| `release.yml` / `cli-release.yml` | Installable `@finnaai/matrix` CLI release | Manual CLI release | Required for CLI publishing |
| `pr-title.yml` | Conventional Commit PR title policy | PR title changes | Yes |
| `docker.yml` | Legacy Docker image publishing/deploy path | `v*` tags, manual | Legacy only, not the customer runtime path |

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
