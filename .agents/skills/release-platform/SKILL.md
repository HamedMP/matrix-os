---
name: release-platform
description: Deploy the Matrix OS platform service (packages/platform, the pre-VPS app.matrix-os.com shell, api.matrix-os.com) to Cloud Run through the Platform Cloud Run workflow, verify it, and roll it back. Use when asked to "release the platform", "deploy platform", "promote the platform revision", "what commit is production platform on", "rerun the platform deploy", or "roll back the platform".
---

# Release Platform

Deploys the platform control plane to Cloud Run with
`.github/workflows/platform-cloud-run.yml`. Customer VPS runtime releases are a
different lane: use `release-matrix-stable`. Background: `docs/dev/releases.md`
and `docs/platform/dev/deployment.md`.

## Rules

- Deploy only reviewed, merged code. Production deploys only from `main`.
- **Ask the user before** any production dispatch, rerun, or traffic change.
- Never print secrets. Report the run URL and the exact commit.

## 1. Does `main` already deploy it?

A push to `main` deploys **and promotes production** automatically when it
touches a path in the workflow's `on.push.paths` list (`packages/platform/**`,
`shell/**`, `distro/customer-vps/**`, `packages/sync-client/**`,
`Dockerfile.platform`, `cloudbuild.platform.yaml`, and a few scripts). Check the
list itself, not this summary:

```bash
sed -n '/^  push:/,/^  workflow_dispatch:/p' .github/workflows/platform-cloud-run.yml
gh run list --workflow platform-cloud-run.yml --limit 5
```

Runs share one concurrency group per environment and never cancel a running
deploy, but a newer pending run replaces an older pending one (shown as
`cancelled`). That is expected.

## 2. Manual deploy (`workflow_dispatch`)

Inputs: `environment` (`staging` | `production`, default `staging`) and
`promote` (boolean, default `false`).

```bash
# Staging candidate, no traffic change
gh workflow run platform-cloud-run.yml --ref main -f environment=staging -f promote=false
# Production deploy + promote to 100% (ask first)
gh workflow run platform-cloud-run.yml --ref main -f environment=production -f promote=true
gh run list --workflow platform-cloud-run.yml --limit 1   # get the run id
gh run watch <run-id> --exit-status
```

With `promote=false` the workflow builds, deploys a zero-traffic `candidate`
revision, and smokes it (`/health`, `/sign-in`, billing shell, bundle channel
manifest). With `promote=true` (or any `main` push) it also deploys the
`production-candidate` revision, the dedicated worker service, moves 100%
traffic, and verifies no stale revision still has traffic.

## 3. Failed run after the image was built

The workflow is a single `deploy` job. `gh run rerun <run-id> --failed` reruns
that whole job for the same commit (the image is rebuilt). Use it for transient
failures (Cloud Build, smoke timeouts). If a deterministic check failed (secret
preflight, source-compatibility, contract smoke), fix it through a PR instead.

## 4. Which commit is production serving?

1. Latest successful production run:
   ```bash
   gh run list --workflow platform-cloud-run.yml --status success --limit 5 \
     --json databaseId,event,headSha,createdAt,url
   ```
   Staging dispatches appear here too; confirm the run's environment in its URL.
2. Authoritative: the serving revision's `matrix-source-sha` label (needs
   `gcloud auth login` with access to the project):
   ```bash
   eval "$(gh variable list --env production --json name,value \
     -q '.[]|select(.name|test("^(CLOUD_RUN_SERVICE|GCP_PROJECT_ID|GCP_REGION)$"))|"\(.name)=\(.value)"')"
   gcloud run services describe "$CLOUD_RUN_SERVICE" --project "$GCP_PROJECT_ID" \
     --region "$GCP_REGION" --format=json \
     | jq -r '.status.traffic[] | select((.percent // 0) > 0) | "\(.revisionName) \(.percent)%"'
   gcloud run revisions describe <revision> --project "$GCP_PROJECT_ID" \
     --region "$GCP_REGION" --format='value(metadata.labels.matrix-source-sha)'
   ```
   `/health` returns only `{"status":"ok"}`; it does not expose the commit.

## 5. Verify after deploy

```bash
curl -fsS https://app.matrix-os.com/health        # {"status":"ok"}
curl -fsS https://api.matrix-os.com/health        # {"status":"ok"}
curl -fsS https://app.matrix-os.com/sign-in | grep -c 'data-matrix-auth-shell="true"'   # >= 1
```

Then confirm step 4 shows the expected SHA at 100%, and exercise the changed
route or page directly.

## 6. Rollback

Previous revisions stay available. Move traffic back (ask first):

```bash
gcloud run revisions list --service "$CLOUD_RUN_SERVICE" --project "$GCP_PROJECT_ID" \
  --region "$GCP_REGION" --limit 10
gcloud run services update-traffic "$CLOUD_RUN_SERVICE" --project "$GCP_PROJECT_ID" \
  --region "$GCP_REGION" --to-revisions "<previous-revision>=100"
```

This is the same command the workflow's `Promote revision` step uses. The
next `main` push that matches the paths filter promotes a new revision again,
so land the fix or revert through a PR. The worker service
(`<service>-worker`) is deployed separately; check it if background
reconciliation regressed.

## Database migrations

Platform schema migrations run at **startup** of each revision
(`packages/platform/src/database/run-migrations.ts` via `migration-runner.ts`):
advisory-locked, revisioned, forward-only. There is no separate migrate step
and no down migration. A traffic rollback runs old code against the new schema,
so review migrations in the PR for backward compatibility before deploying.

## Pre-VPS shell

`/sign-in`, `/sign-up`, `/auth/device`, `/runtime`, billing, and provisioning
pages for users without a VPS are served by this platform service. A host-bundle
publish does not update them. After merging such a change, confirm this
workflow ran and promoted, then verify the no-VPS flow. If you cannot dispatch
it, tell the user to run the production dispatch.

## Report

- [ ] Trigger (push or dispatch with `environment`/`promote`) and run URL
- [ ] Commit SHA deployed, and serving revision + `matrix-source-sha` if checked
- [ ] Health and `/sign-in` checks result
- [ ] Migrations included (yes/no) and backward-compatibility note
- [ ] Rollback target revision (the one serving before this deploy)
