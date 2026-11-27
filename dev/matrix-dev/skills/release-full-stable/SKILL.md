---
name: release-full-stable
description: 'Coordinate an interactive, end-to-end Matrix OS stable release: collaboratively author the Desktop What''s New JSON, qualify platform readiness, release and verify the VPS host bundle, optionally roll it across the full fleet, publish Desktop stable, check the golden snapshot, and report in CET/CEST. Use when asked for a "full stable release" or to release both Matrix cloud/VPS and Desktop; use the narrower release skills for only one lane.'
---

# Release Full Stable

A full stable release is a human-approved coordination of independent release
lanes. GitHub Actions builds, signs, and publishes artifacts; this skill owns
the editorial proposal, approval gates, ordering, verification, and report.
It never turns one approval into permission for later mutations.

Use these detailed skills during the relevant stages:

- `release-notes` for `release-notes/<version>.json` and the Desktop What's New
  dialog.
- `release-matrix-stable` for qualifying the exact automatic green-main dev
  artifact, reviewed-VPS verification, stable promotion, and rollback.
- `release-platform` when the release range contains platform/control-plane
  changes or production platform is behind those changes.

Read each selected skill completely before acting. This coordinator does not
replace their safety rules.

## Meaning of "full"

| Lane | Full-release outcome |
| --- | --- |
| Release modal | Approved, validated JSON covers the invocation-time release cutoff and is merged before the Desktop build starts |
| Platform | Relevant production platform changes are deployed and verified, or explicitly `not needed` |
| Host bundle | The reviewed exact green-main dev artifact is promoted as the exact stable version |
| Fleet | An explicitly approved exact-version rollout is observed across the eligible fleet |
| Desktop | The exact approved Desktop stable version and update feeds are published |
| Golden snapshot | Final status is recorded; a build failure is visible but does not erase a successful release |
| Report | Every lane, exception, rollback target, and CET/CEST timestamp is shown |

Mobile, CLI, and unrelated services are not implied by "full stable release".

## 0. Repository and authority

Run from a Matrix OS checkout and use the repository explicitly on every `gh`
call:

```bash
test "$(gh repo view --repo HamedMP/matrix-os --json nameWithOwner -q .nameWithOwner)" = "HamedMP/matrix-os"
test -f .github/workflows/host-bundle-release.yml
test -f .github/workflows/desktop-release.yml
```

Use a manual worktree for the release-notes PR. Release only reviewed code on
`main`. Never merge a PR, publish/promote a release, deploy platform, deploy a
VPS, start a fleet rollout, push a Desktop tag, retry a mutating job, select
`severity=security`, or roll back without the user's explicit approval for that
action. Never print release credentials.

At the start, state the intended lanes and ask whether the user means a fleet
rollout as part of this run. This answer records intent but does not replace the
final approval immediately before the rollout.

## 1. Establish the release range and versions

Fetch `origin/main` and tags. Immediately record the current `origin/main` as
`RELEASE_CONTENT_SHA`. This is the immutable content cutoff for the run: the
notes cover changes through that SHA only. Exclude the release-notes PR itself
from the user-facing range and hidden PR audit. Later merges do not silently
expand this release.

Record:

- `RELEASE_CONTENT_SHA` and its same-SHA CI run;
- current stable host version, commit, timestamp, and rollback version;
- current Desktop stable version/tag, source commit, and rollback version;
- latest production platform source SHA and run;
- commits and merged PRs in both the host and Desktop release ranges.

Propose the next unused Desktop patch version unless the repository already
declares an intentional version. Do not reserve or publish it yet. Explain any
reason to choose something other than the next patch.

## 2. Collaborate on the release modal

Use `release-notes` to produce the JSON shown in Desktop's What's New release
modal. The agent leads the writing; the human makes product decisions.

### Editorial collaboration contract

1. Read the titles, bodies, `## User-facing` notes, labels, and changed surfaces
   for PRs merged through `RELEASE_CONTENT_SHA`. Separate user value from
   implementation detail. Do not include the release-notes PR itself.
2. Present a **complete recommended draft** first: version, title, short title,
   summary, ordered highlights, smaller items, art/tone choices, and the hidden
   PR audit. Make it polished enough that approval can be a simple yes.
3. When evidence leaves a meaningful product decision open, ask at most three
   focused questions in one round. Each question includes the agent's
   **recommended default** and the consequence of choosing differently. Useful
   questions are which story leads, whether a borderline feature is public,
   whether two changes are one story, and whether approved live media should
   replace illustration art.
4. Do not ask the user to write the copy, classify every PR, or choose details
   the evidence already resolves. Do not ask questions merely to appear
   collaborative. If there is a clear best narrative, recommend it and ask for
   approval.
5. Revise the whole draft after answers so its title, summary, highlights, and
   items read as one release—not a commit log. Prefer concrete outcomes and
   warm, confident language; never exaggerate availability or reliability.

Show the final draft plus the hidden list and reasons. Obtain **explicit
approval before committing** the JSON. Copy approval authorizes only the notes
PR, not a release.

## 3. Land the release-notes PR without blocking non-Desktop lanes

Follow the repository's Linear, worktree, PR, review, and merge rules. Validate
the JSON and preview the modal in light and dark themes when runtime access is
available. Open the approved notes PR and recommend “merge release-notes PR ASAP”
to reviewers. Do not make its pending review a global release gate.
Platform, Host, and Fleet lanes may proceed against `RELEASE_CONTENT_SHA` with
their normal approval gates while the notes PR is pending.

Desktop is different because the JSON is bundled at build time. It must wait
for the approved notes PR to merge. After merge, fetch again and record the
exact notes-bearing `main` commit as `DESKTOP_SHA`. Prove that
`RELEASE_CONTENT_SHA` is its ancestor and inspect every intervening commit.
The notes PR remains excluded from its own release story. Any other intervening
commit must be demonstrably irrelevant to the Desktop artifact and user
behavior and must be listed in the report; otherwise stop the Desktop lane
rather than silently shipping changes beyond the cutoff. Require same-SHA
`CI Results` to be green for both SHAs before their corresponding mutations.

Use `RELEASE_CONTENT_SHA` wherever the Platform, Host, and Fleet instructions
refer to the locked release SHA. Use `DESKTOP_SHA` only for Desktop publication.
If a dispatch pin rejects because `main` moved, return to the affected lane
instead of dropping the pin.

## 4. Qualify the platform lane

Read the **authoritative serving source SHA** from the Cloud Run revision that
currently receives production traffic, as described by `release-platform`.
The latest successful workflow run is supporting evidence, not proof of what is
serving. Fetch that commit and establish its relationship to
`RELEASE_CONTENT_SHA` before using path filters:

```bash
git merge-base --is-ancestor "$PLATFORM_SHA" "$RELEASE_CONTENT_SHA"
git diff --name-only "$PLATFORM_SHA..$RELEASE_CONTENT_SHA"
```

If the serving SHA is unavailable, is not verified main provenance, or is not
an ancestor of `RELEASE_CONTENT_SHA`, stop and qualify the platform explicitly.
Do not infer compatibility from timestamps, run order, or a green workflow. Inspect
every commit and changed file from the serving SHA through
`RELEASE_CONTENT_SHA` against the **current** `on.push.paths` filters in
`.github/workflows/platform-cloud-run.yml`. This whole gap matters: checking
only the host or Desktop release range can miss an earlier skipped or failed
platform deployment.

Also build a short **dependency ledger** for the host and Desktop changes being
released. For each client or bundle behavior that needs a platform route,
contract, environment value, migration, worker, or edge behavior, record:

- the required production behavior and introducing commit;
- proof that the introducing commit is contained in the serving SHA; and
- a live production check of the required route or contract.

Record `none` only after reviewing the release changes for such dependencies.
Do not mark Platform `not needed` unless the serving ancestry is proven, the
entire missing-commit gap contains no platform-trigger path, the dependency
ledger is empty or fully satisfied by the serving SHA, and the standard health
and sign-in checks pass. If any proof is missing, or a platform-relevant commit
is absent from production, use `release-platform`; prefer a successful
automatic production run only when the authoritative traffic and source label
confirm it actually deployed. Otherwise show the exact SHA and ask before a
production dispatch or retry. Verify production traffic, health, sign-in, every
ledger entry, and the changed route. Record serving, worker, and edge rollback
targets before an authorized manual deployment.

Platform readiness is a gate for host/Desktop publication when the new clients
depend on it. A host release never substitutes for a platform deployment.

## 5. Release the host bundle

Use `release-matrix-stable` against `RELEASE_CONTENT_SHA`:

1. Derive the host's plain-text changelog from the same approved editorial
   story, adapting it to the Settings update surface rather than copying JSON.
2. Qualify the exact green-main dev artifact from the automatic `main` host
   workflow; do not dispatch a second host build or create a host canary.
3. Verify workflow `headSha`, dev `gitCommit`, immutable release metadata,
   bundle checksum, and version all point to `RELEASE_CONTENT_SHA`.
4. Show the approved changelog and ask before attaching it to that same
   immutable release without moving a channel pointer.
5. Ask before deploying the exact candidate version to a reviewed disposable
   or named VPS.
6. Verify installed provenance, services, local health, and the changed user
   journeys on that VPS.
7. Show the exact verified version and ask before promoting it to stable.

Promote only the exact reviewed dev artifact; never rebuild it for stable.
Record the previous stable version before promotion.

## 6. Roll out and verify the fleet

After stable promotion, take a complete, non-truncated fleet inventory. Define
an **inventory-derived denominator**: every eligible running production VPS,
with preview/test machines and intentionally excluded machines listed
separately. Never hard-code a few handles as proof of fleet health.

Create an immutable **approval manifest** containing:

- the exact stable version;
- the inventory observation time;
- the sorted target list, with machine ID and handle for every recipient;
- the sorted exclusion list, with machine ID, handle, and reason; and
- the target count and a SHA-256 digest of the canonical manifest.

Show the complete target and exclusion lists, version, count, and digest, then
ask for final approval. Approval binds both the version and that exact target
set. Adding or removing a target, changing the version, or changing an
exclusion requires a new manifest and new approval.

Immediately before the first deploy request, fetch another complete inventory
and verify that every approved machine ID still maps uniquely to its approved
handle and remains eligible, every exclusion remains outside the target list,
and the derived recipients must exactly match the approved target set. Stop on
missing, duplicate, renamed, newly ineligible, or otherwise changed targets.
Never add a newly eligible machine without new approval; list it as appearing
after the approved snapshot or ask for a replacement manifest.

Use only a deploy mechanism that can honor the approved recipients and version.
With the current platform API, first prove each approved handle uniquely maps to
the approved machine ID, then issue one scoped request per manifest entry with
the exact body `{"handle":"<approved-handle>","version":"<exact-version>"}`.
Require each response to name exactly the approved machine ID and handle. Do
not use `deploy_after_publish=true`, a `/vps/deploy` body that omits `handle`,
or any other broad path that selects the fleet again at dispatch. If the
available API cannot preserve both the exact version and target set, stop and
report the fleet rollout as blocked. Never fall back to SSH copies or a broad
deploy. If a scoped request fails after dispatch begins, preserve the manifest
and report the rollout as partial; do not silently substitute another target.
A triggered rollout is not a completed rollout.

Observe both control-plane release reports and Loki update/health evidence.
Track at least:

- eligible;
- installed and healthy on the exact version;
- triggered or updating;
- failed;
- unreachable or stale;
- excluded, with reason.

Reconcile every control-plane response and Loki result to the manifest's
machine ID and handle. An excluded or post-approval machine is never part of the
success denominator, even if it updates independently. Use a bounded monitoring
window and report the remaining approved machines by handle and state. A
historically unreachable machine may be an accepted exception only when the
current inventory confirms it and the report names it; do not encode customer
handles in this skill. If Loki is unavailable, say which verification is
missing and do not claim fleet-wide observed completion from trigger counts
alone.

## 7. Publish and verify Desktop stable

Desktop publication must wait for the approved release-notes PR to merge
because its JSON is bundled into the application. Confirm
`release-notes/<version>.json` exists in `DESKTOP_SHA`, validates for `stable`,
and matches the exact approved version. Confirm the immutable
`desktop-v<version>` tag and release do not already exist.

Show the version, `DESKTOP_SHA`, `RELEASE_CONTENT_SHA`, and release-modal title,
then ask before Desktop publication. Prefer the immutable tag path so the
approved commit cannot move:

```bash
git tag "desktop-v<VERSION>" "$DESKTOP_SHA"
git push origin "desktop-v<VERSION>"
```

Monitor `desktop-release.yml`. Verify the immutable GitHub release is neither a
draft nor prerelease, all expected signed macOS, Windows, and Linux artifacts
exist, and `desktop-stable` exposes the new macOS, Windows, and Linux manifests.
Download or read each manifest and confirm its version is the exact approved
version. Confirm the release-modal JSON is present in the tagged source.

If the tag push or workflow fails after the immutable tag exists, do not move or
replace it. Diagnose whether a safe same-tag workflow retry is supported; ask
before retrying. Otherwise choose a new version and repeat the notes approval.

## 8. Golden snapshot and final verification

Poll the promoted host release's `snapshotStatus` through its bounded build
window. **Golden snapshot** readiness improves new provisioning but is separate
from successful R2 publication, stable promotion, fleet installation, and
Desktop publication. Record `ready`, `failed`, `pending`, `ineligible`, or the
exact observable state. Never hide a failure, and never claim the already
published release failed solely because the snapshot build failed.

Recheck the public host stable pointer and all Desktop stable feeds after caches
have had time to settle. Preserve previous host and Desktop versions as rollback
targets.

## 9. Report

Lead with whether the full release is qualified. Use one compact table with:

| Lane | Version/SHA | Status | Completed at | Evidence or blocker |
| --- | --- | --- | --- | --- |
| Release modal | Desktop version | done/blocked | local time | PR and validation |
| Platform | serving SHA | done/not needed/blocked | local time | run and revision |
| Host publish | host version + SHA | done/failed | local time | workflow and stable pointer |
| Fleet rollout | installed/eligible | done/partial/blocked | local time | reports and Loki |
| Desktop stable | Desktop version + SHA | done/failed | local time | release and feeds |
| Golden snapshot | host version | ready/failed/pending | local time | snapshot status |

When the notes PR made the source commits differ, report both `RELEASE_CONTENT_SHA`
and `DESKTOP_SHA`; do not present them as one shared release SHA. Name any
commits between them and why they did not expand the invocation-time content
cutoff.

Convert timestamps with the `Europe/Berlin` timezone and label the actual
abbreviation (`CET` or `CEST`) for that date. Include approval decisions,
exceptions, rollback targets, and links. Do not collapse `partial`, `failed`,
or `unverified` into green.
