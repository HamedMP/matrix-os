---
name: release-matrix-stable
description: Release the Matrix OS customer VPS host bundle by qualifying the exact automatic green-main dev artifact, verifying that immutable version on a reviewed VPS, and promoting it to stable (or rolling stable back). Use when asked to release Matrix host bundles, promote stable, write the host changelog, or roll back stable.
---

# Release Matrix Stable

Customer VPSes run immutable host bundles. A push to `main` automatically builds
and publishes the host artifact to the `dev` channel. A stable release reuses
that exact green-main dev artifact: it does not build or promote a separate host
canary. Desktop prerelease channels are unrelated to this skill.

Platform Postgres holds release metadata and channel pointers; R2 holds the
immutable bytes. The platform service is a separate lane handled by
`release-platform`.

## Where to run it

Run from the root of a Matrix OS checkout and name the repository on every
GitHub CLI call:

```bash
test "$(gh repo view --repo HamedMP/matrix-os --json nameWithOwner -q .nameWithOwner)" = "HamedMP/matrix-os"
test -f .github/workflows/host-bundle-release.yml
```

## Rules

- Release only the locked `main` commit whose same-SHA CI is green.
- Do not manually dispatch another host build for an ordinary stable release.
  Wait for the automatic `main` run and qualify its exact `dev` artifact.
- Ask immediately before each mutation: updating release metadata, deploying to
  any VPS, promoting `stable`, retrying a mutating job, choosing
  `severity=security`, or rolling back.
- Never set `deploy_after_publish=true` for this path. Fleet rollout uses the
  exact approved target manifest from `release-full-stable`.
- Never print `PLATFORM_SECRET`.

## 1. Lock the commit and release range

```bash
git fetch origin main
SHA=$(git rev-parse origin/main)
gh run list --repo HamedMP/matrix-os --commit "$SHA" --workflow ci.yml --limit 3 \
  --json databaseId,headSha,status,conclusion,url
STABLE=$(curl -fsS https://app.matrix-os.com/system-bundles/channels/stable.json)
BASE=$(echo "$STABLE" | jq -r .gitCommit)
echo "$STABLE" | jq '{version,gitCommit,createdAt,snapshotStatus}'
git log --oneline "$BASE..$SHA"
```

Record the current stable version as the rollback target. If `origin/main`
moves later, keep this locked SHA; do not silently expand the release.

## 2. Qualify the automatic dev artifact

Find the automatic host workflow for the locked SHA and wait for its R2 publish
job to succeed:

```bash
gh run list --repo HamedMP/matrix-os --commit "$SHA" \
  --workflow host-bundle-release.yml --limit 5 \
  --json databaseId,event,headSha,status,conclusion,url,createdAt
DEV=$(curl -fsS https://app.matrix-os.com/system-bundles/channels/dev.json)
echo "$DEV" | jq '{version,gitCommit,gitRef,buildTime,channel,severity,updateType,sha256,size}'
VERSION=$(echo "$DEV" | jq -r .version)
test "$(echo "$DEV" | jq -r .gitCommit)" = "$SHA"
curl -fsS "https://app.matrix-os.com/system-bundles/releases/$VERSION.json" \
  | jq '{version,gitCommit,gitRef,buildTime,channel,severity,updateType,sha256,size,bundleKey,checksumKey,incrementalManifestKey,incrementalManifestSha256}'
```

Stop if the workflow `headSha`, dev `gitCommit`, immutable release
`gitCommit`, version, checksum, or object keys disagree. If the automatic run
is absent or failed, diagnose it and ask before retrying; do not replace it with
a second release build.

## 3. Write and approve the changelog

The changelog is plain text shown in Settings → System → Updates. Use newlines
and `- ` bullets, keep 3–8 user-visible items, and omit PR numbers, internal
names, customer data, and infrastructure noise.

```bash
node scripts/release-changelog.mjs --base "$BASE" --head "$SHA" > /tmp/changelog.txt
```

Show the edited changelog and the selected `VERSION`, SHA, severity, current
stable version, and workflow URL. Approval of the copy is not permission to
mutate release metadata.

## 4. Attach the changelog to the same immutable artifact

The automatic dev registration normally has no final customer changelog.
Re-registering identical artifact fields updates only changelog/severity/update
type and does not move a channel pointer. Ask immediately before this request.

For a normal release use `severity=normal` and `updateType=manual`.
`security` implies `updateType=auto` and requires separate explicit approval.

```bash
curl -fsS "https://app.matrix-os.com/system-bundles/releases/$VERSION.json" \
  | jq --rawfile cl /tmp/changelog.txt \
      '{version,gitCommit,gitRef,buildTime,bundleKey,checksumKey,incrementalManifestKey,incrementalManifestSha256,sha256,size,severity:"normal",updateType:"manual",changelog:$cl}' \
  | curl -fsS -X POST https://app.matrix-os.com/system-bundles/releases \
      -H "Authorization: Bearer $PLATFORM_SECRET" \
      -H "Content-Type: application/json" --data-binary @-
```

A `409` means an immutable artifact field differed; stop rather than forcing
it. Read the release back and verify the changelog, severity, update type,
checksum, size, and SHA.

## 5. Verify the stable candidate on one reviewed VPS

Ask before deploying `VERSION` to a reviewed disposable or named VPS. This is
a scoped exact-version deployment, not a channel promotion:

```bash
curl -fsS -X POST https://app.matrix-os.com/vps/deploy \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"handle":"<reviewed-handle>","version":"<VERSION>"}'
curl -fsS https://app.matrix-os.com/vps/fleet \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  | jq '.machines[] | select(.handle=="<reviewed-handle>") | {machineId,handle,status,imageVersion,healthy}'
```

Verify on that VPS:

```bash
cat /opt/matrix/app/BUNDLE_VERSION
cat /opt/matrix/release.json
systemctl is-active matrix-gateway matrix-shell matrix-sync-agent
curl -fsS http://127.0.0.1:4000/health
```

Also verify the changed user journeys and Settings release information. Record
the exact handle, machine ID, installed version, provenance, services, health,
and observations. If no reviewed VPS is available, report stable promotion as
blocked instead of claiming the artifact is qualified.

## 6. Promote the exact verified version to stable

Show the verified `VERSION`, SHA, changelog, and previous stable version, then
ask immediately before promotion:

```bash
curl -fsS -X POST https://app.matrix-os.com/system-bundles/channels/stable \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"version":"<VERSION>"}'
curl -fsS https://app.matrix-os.com/system-bundles/channels/stable.json \
  | jq '{version,gitCommit,sha256,severity,updateType,changelog,snapshotStatus}'
```

This reuses the already verified bytes. It changes new provisioning and the
stable pointer, and requests a golden snapshot. It does not perform a fleet
rollout.

## Rollback

Ask first, then re-promote the recorded previous stable version:

```bash
curl -fsS -X POST https://app.matrix-os.com/system-bundles/channels/stable \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"version":"<previous-stable-version>"}'
```

VPSes that already installed the bad version require explicit scoped downgrades.

## Report

- [ ] Locked SHA, same-SHA CI, automatic host workflow
- [ ] Qualified dev version, checksum, object keys, and changelog
- [ ] Reviewed-VPS verification and changed journeys
- [ ] Stable promotion response and golden snapshot status
- [ ] Previous stable version as rollback target
