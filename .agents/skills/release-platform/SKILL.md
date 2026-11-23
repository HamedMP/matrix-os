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

Inputs: `environment` (`staging` | `production`, default `staging`),
`promote` (boolean, default `false`), and `expected_sha` (the approved commit).

```bash
git fetch origin main
SHA=$(git rev-parse origin/main)    # the commit you reviewed and got approval for
# Staging candidate, no traffic change
gh workflow run platform-cloud-run.yml --ref main -f expected_sha="$SHA" -f environment=staging -f promote=false
# Production deploy + promote to 100% (ask first)
gh workflow run platform-cloud-run.yml --ref main -f expected_sha="$SHA" -f environment=production -f promote=true
gh run list --workflow platform-cloud-run.yml --limit 1   # get the run id
gh run watch <run-id> --exit-status
```

`--ref main` deploys whatever `main` is when the dispatch lands. `expected_sha`
pins the approved commit: the run fails in its first step, before any image is
built or traffic is switched, when `main` has moved. Always pass it. If the run
fails there, nothing was deployed: review the new commits, ask again, and
dispatch with the new SHA.

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

A promoted production deploy replaces three things that must agree with each
other:

- the serving service (`$CLOUD_RUN_SERVICE`);
- the background worker (`$CLOUD_RUN_SERVICE-worker`, a private singleton);
- the Matrix.page Cloudflare Worker (`matrix-public-sites`), deployed with the
  active Sites edge secret when `MATRIX_PUBLIC_SITES_ENABLED` is `true`.

Before a production deploy, record what each one serves so you have rollback
targets:

```bash
for svc in "$CLOUD_RUN_SERVICE" "$CLOUD_RUN_SERVICE-worker"; do
  gcloud run services describe "$svc" --project "$GCP_PROJECT_ID" --region "$GCP_REGION" \
    --format=json | jq -r --arg svc "$svc" '.status.traffic[] | select((.percent // 0) > 0) | "\($svc) \(.revisionName)"'
done
# Matrix.page Worker version serving 100% (needs Cloudflare access: `wrangler login`)
pnpm --filter @matrix-os/edge-router exec wrangler deployments status \
  --config wrangler.sites.toml --json \
  | jq -r '.versions[] | select((.percentage | tonumber) == 100) | "matrix-public-sites \(.version_id)"'
```

Previous revisions and Worker versions stay available. Roll back all three
together (ask first), so serving code, background jobs, and the edge run
compatible builds:

```bash
gcloud run revisions list --service "$CLOUD_RUN_SERVICE" --project "$GCP_PROJECT_ID" \
  --region "$GCP_REGION" --limit 10
gcloud run services update-traffic "$CLOUD_RUN_SERVICE" --project "$GCP_PROJECT_ID" \
  --region "$GCP_REGION" --to-revisions "<previous-serving-revision>=100"
gcloud run services update-traffic "$CLOUD_RUN_SERVICE-worker" --project "$GCP_PROJECT_ID" \
  --region "$GCP_REGION" --to-revisions "<previous-worker-revision>=100"
pnpm --filter @matrix-os/edge-router exec wrangler rollback "<previous-worker-version-id>" \
  --config wrangler.sites.toml --message "Roll back with platform <previous-serving-revision>"
```

Why the Worker belongs in the rollback: it sends the Sites edge secret it was
deployed with, and each platform revision accepts only the secret versions it
was deployed with (`SITES_EDGE_SECRET_VERSION` and
`SITES_EDGE_SECRET_PREVIOUS_VERSION`). After a secret rotation, restoring only
the two Cloud Run services leaves the newer Worker sending a secret the
restored platform rejects. Every hosted site then returns 404 while `/health`
and `/sign-in` still pass. A Worker version carries its own secret, so rolling
it back restores the matching one. See
`specs/551-public-app-sites/operations.md` for the rotation procedure.

The first `gcloud` command is the one the workflow's `Promote revision` step
uses. Only the `-worker` revision may run with
`PLATFORM_BACKGROUND_WORKERS_ENABLED=true`; never point serving traffic at a
worker revision or the reverse.

After the rollback, re-run the step 4 and step 5 checks on both services, and
confirm the edge reaches the restored platform:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 30 https://matrix.page/_edge-health   # must be 200
```

Anything other than `200` means the Worker and platform disagree: check that
the Worker version and the serving revision come from the same deploy. The
next `main` push that matches the paths filter promotes a new revision again,
so land the fix or revert through a PR.

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
- [ ] Rollback targets from before this deploy: serving revision, worker revision, and Matrix.page Worker version
- [ ] After a rollback: `https://matrix.page/_edge-health` returned 200
