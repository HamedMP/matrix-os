---
name: release-matrix-stable
description: Release the Matrix OS customer VPS host bundle - cut a canary from main with a user-facing changelog, verify it on a reviewed VPS, then promote that exact version to stable (or roll stable back). Use when asked to "release to stable", "promote stable", "cut a canary", "release Matrix", "write the changelog" for a host-bundle release, or "roll back stable".
---

# Release Matrix Stable

Customer VPSes run immutable host bundles. Platform Postgres holds release
metadata and channel pointers; R2 holds the bytes. Pipeline:
`.github/workflows/host-bundle-release.yml` -> `scripts/host-bundle-release.mjs`
(manifest) -> `scripts/publish-release.sh` (R2 upload + `POST
/system-bundles/releases`). Background: `docs/dev/releases.md`. The platform
service is a separate lane: `release-platform`.

## Rules

- Release only a `main` commit whose CI is green. Never dispatch a canary or
  stable build from a feature branch.
- **Ask the user before**: dispatching the canary, deploying to any VPS,
  promoting `stable`, choosing `severity=security`, or rolling back.
- Never set `deploy_after_publish=true` without explicit approval for a
  fleet-wide rollout; it deploys the new version to every running VPS.
- Never print `PLATFORM_SECRET`. Platform admin calls below need it in env.

## 1. Pick the commit and the range

```bash
git fetch origin
SHA=$(git rev-parse origin/main)
gh run list --commit "$SHA" --workflow ci.yml --limit 3     # must be success
STABLE=$(curl -fsS https://app.matrix-os.com/system-bundles/channels/stable.json)
echo "$STABLE" | jq '{version, gitCommit, createdAt}'
BASE=$(echo "$STABLE" | jq -r .gitCommit)
git log --oneline "$BASE..$SHA"
```

The workflow's own `Same-SHA CI gate` also waits for CI on that commit.

## 2. Write the changelog

The changelog is **plain text**, stored in the `changelog` field of the release
registration JSON (`string | null`, max 32,000 chars, schema
`HostBundleReleaseBodySchema` in `packages/platform/src/host-bundle-routes.ts`).
Settings -> System -> Updates renders it with `whitespace-pre-line`, so use
newlines and `- ` bullets, not Markdown headings or links. It is fixed at
registration and carried unchanged when the same version is promoted to
`stable`, so write it when cutting the canary.

Draft from Conventional Commits, then edit by hand:

```bash
node scripts/release-changelog.mjs --base "$BASE" --head "$SHA" > /tmp/changelog.txt
```

The script groups `feat` -> New, `fix`/`revert` -> Fixed, `perf` -> Faster,
everything else -> Polish and reliability. Then:

- Keep what a user would notice; drop `ci`/`test`/`docs`/refactor noise.
- Plain language, one short line per item, 3-8 items, well under 1,500 chars.
- No PR or ticket numbers, internal names, hostnames, customer data, or secrets.
- Merge related commits into one line.

Example:

```text
What's changed

New
- Chat shows your sent message immediately.
- Keyboard shortcuts are listed in Getting started.

Fixed
- Files Next and Previous now include every open tab.
- WhatsApp settings stay connected after a restart.
```

Shape of the registration body that carries it (built by `publish-release.sh`;
you do not hand-write it for a normal release):

```json
{
  "version": "v2026.11.23-2101",
  "gitCommit": "<40-char sha>",
  "gitRef": "main",
  "buildTime": "2026-11-23T10:00:00Z",
  "bundleKey": "system-bundles/<version>/matrix-host-bundle.tar.gz",
  "checksumKey": "system-bundles/<version>/matrix-host-bundle.tar.gz.sha256",
  "incrementalManifestKey": "system-bundles/<version>/incremental-manifest.json",
  "incrementalManifestSha256": "<sha256>",
  "sha256": "<sha256>",
  "size": 123456789,
  "severity": "normal",
  "updateType": "manual",
  "changelog": "What's changed\n\nNew\n- ...",
  "snapshotEligible": true,
  "channel": "canary"
}
```

Show the draft to the user and get approval before step 3.

## 3. Severity

- `normal` (default): `updateType=manual`; users see the update in Settings and
  choose when to install.
- `security`: `publish-release.sh` sets `updateType=auto`, so VPSes subscribed
  to that channel may auto-apply it during passive polling. It does **not**
  bypass the `deploy_after_publish` gate. Use only for real security fixes, and
  ask first.

## 4. Cut the canary

Canonical today: dispatch from `main` (version becomes
`v<YYYY.MM.DD>-<run_number>`):

```bash
git fetch origin && test "$(git rev-parse origin/main)" = "$SHA"   # main moved? redo steps 1-2
gh workflow run host-bundle-release.yml --ref main \
  -f channel=canary -f severity=normal -f changelog="$(cat /tmp/changelog.txt)"
gh run list --workflow host-bundle-release.yml --event workflow_dispatch --limit 1 \
  --json databaseId,headSha,url
gh run watch <run-id> --exit-status
gh run view <run-id> --log | grep 'Generated version'     # VERSION
curl -fsS https://app.matrix-os.com/system-bundles/channels/canary.json | jq '{version, gitCommit, changelog}'
```

`--ref main` builds whatever `main` is at dispatch time, and the CI gate
checks that commit, not the one you approved. The run's `headSha` and the
canary's `gitCommit` must equal `$SHA`. If they differ, stop: do not deploy or
promote it. Regenerate the changelog for the new range and get fresh approval.

Alternative: pushing a `v*` tag builds a bundle named after the tag and
promotes `canary`, but registers **no changelog**. Recent tags
(`git tag -l 'v*' --sort=-creatordate`) use the same date-run form; never push a
tag that matches an already-published version (the registration conflicts).
Dispatching `channel=stable` directly skips canary verification; avoid it.

## 5. Verify the canary

Deploy only to a reviewed handle (ask first; prefer a disposable test VPS):

```bash
curl -fsS -X POST https://app.matrix-os.com/vps/deploy \
  -H "Authorization: Bearer $PLATFORM_SECRET" -H "Content-Type: application/json" \
  -d '{"handle":"<reviewed-handle>","version":"<VERSION>"}'
curl -fsS https://app.matrix-os.com/vps/fleet -H "Authorization: Bearer $PLATFORM_SECRET" \
  | jq '.machines[] | select(.handle=="<reviewed-handle>") | {handle,status,imageVersion,healthy}'
```

On the VPS (`docs/dev/releases.md` step 4):

```bash
cat /opt/matrix/app/BUNDLE_VERSION; cat /opt/matrix/release.json
systemctl is-active matrix-gateway matrix-shell matrix-sync-agent
curl -fsS http://127.0.0.1:4000/health
```

In the browser: Settings -> System -> Updates shows the version and Git commit,
and the changed features work. Record what you tested.

## 6. Promote to stable (ask first)

Promote the exact verified version; this reuses its bytes and changelog:

```bash
curl -fsS -X POST https://app.matrix-os.com/system-bundles/channels/stable \
  -H "Authorization: Bearer $PLATFORM_SECRET" -H "Content-Type: application/json" \
  -d '{"version":"<VERSION>"}'
curl -fsS https://app.matrix-os.com/system-bundles/channels/stable.json | jq '{version, gitCommit, snapshotStatus}'
```

What it triggers:

- New provisioning uses it immediately (production binds
  `CUSTOMER_VPS_IMAGE_VERSION=stable` and pins the resolved version per machine).
- A golden snapshot build is requested in the same transaction
  (`docs/dev/golden-vps-snapshots.md`); `snapshotStatus` tracks it. A 503 means
  snapshot compatibility is not configured: stop and escalate.
- Existing stable-subscribed VPSes discover it within about 5 minutes; with
  `updateType=manual` users install from Settings. No fleet deploy happens.

## Fixing a changelog after publishing (ask first)

Re-registering the same version with identical artifact fields updates only
`changelog`/`severity`/`updateType`. Omit `channel` so nothing is promoted:

```bash
curl -fsS https://app.matrix-os.com/system-bundles/releases/<VERSION>.json \
  | jq --rawfile cl /tmp/changelog.txt '{version,gitCommit,gitRef,buildTime,bundleKey,checksumKey,incrementalManifestKey,incrementalManifestSha256,sha256,size,severity,updateType,changelog:$cl}' \
  | curl -fsS -X POST https://app.matrix-os.com/system-bundles/releases \
      -H "Authorization: Bearer $PLATFORM_SECRET" -H "Content-Type: application/json" --data-binary @-
```

A 409 means an artifact field differed; do not force it.

## Rollback (ask first)

Re-promote the previous stable version (note it in step 1):

```bash
curl -fsS -X POST https://app.matrix-os.com/system-bundles/channels/stable \
  -H "Authorization: Bearer $PLATFORM_SECRET" -H "Content-Type: application/json" \
  -d '{"version":"<previous-stable-version>"}'
```

This fixes new provisioning and the channel pointer. VPSes that already
installed the bad version downgrade with `matrix-update <version>` or a scoped
`POST /vps/deploy {handle, version}`.

## Report

- [ ] Commit SHA, base stable version, CI run
- [ ] Workflow run URL, `VERSION`, channel, severity
- [ ] Final changelog text
- [ ] Canary verification: handle, checks run, results
- [ ] Stable promotion response and `snapshotStatus` (or "not promoted")
- [ ] Previous stable version (rollback target)
