# One-label PR previews

Tracking: [ENG-325](https://linear.app/matrix-os/issue/ENG-325/unify-exact-head-pr-previews-with-desktop-downloads-and-a-16-slot), under ENG-240. Design: [spec 633](../../specs/633-unified-pr-preview/spec.md).

## Request and review

After the reviewed controller is activated, add **`preview`** to an open,
same-repository PR. The scheduler builds the exact current PR head and keeps
one bot comment updated with:

- PR author, full source commit and build/deployment status;
- queue position, active previews, and waiting PRs with their authors;
- the Web Desktop preview URL after the deployed source is verified;
- matching Electron Desktop downloads for macOS arm64, macOS x64 and Linux
  when desktop-related files change;
- runtime and download expiry, errors, and links to the responsible jobs.

Up to **16 shared preview runtimes** can be reserved at once. Existing shared
preview machines count toward that limit; this does not create 16 extra
machines. Waiting PRs allocate no machine. Oldest PRs are admitted first.
The new label takes over `preview-vps`/`preview-bundle` on that PR; protected
collaboration previews retain their existing reviewed workflow.
Active comments refresh each pass; waiting comments rotate to bound GitHub API
usage, and label events prioritize the requested PR. A new commit invalidates the old
head's readiness and links: wait for the comment to report the new source.

All required CI, review, signing, notarization and the existing **15-minute
stability check** remain in place. Preview availability does not qualify a PR
for merge. Fork PRs cannot use this credentialed deployment path.

## Test Electron Desktop

Use the artifact for your operating system and architecture from the same
comment and commit as the runtime. GitHub artifact downloads require a signed-in
GitHub account and expire after **three days**. An unavailable, failed or expired
artifact is not a matching download; inspect its job status before proceeding.

These branch builds retain the regular Matrix OS app identity. Install them
deliberately: a separately installed, side-by-side Preview app is not part of
this change. Open the installed build, sign in, and use the existing computer
selector to select the PR preview computer. The web link is also available for
testing Web Desktop. A dedicated one-click native preview connection flow is
follow-up work. Existing Windows branch signing restrictions remain.

## Lifetime and cleanup

The shared runtime expires after **72 hours**, or the existing runtime reaper
deadline when adopting an older preview. Expiry removes `preview`; re-add the
label to request another run. Merging or closing the PR, or
removing `preview`, requests cancellation of its owned jobs and deletion of its
disposable runtime. The scheduler releases capacity only after deletion is
verified. An ambiguous cancellation or failed deletion holds the slot and
reports the problem rather than admitting an overlapping runtime. Cleanup is
asynchronous; the comment is the status source.

Private Previews are separate owner-scoped computers, with the existing default
of two per person. They do not become shared queue slots. Existing PR-close
cleanup of Private Previews remains in place.

## Scope and activation

This queue provides disposable runtime previews. A PR that changes the platform
control plane is explicitly marked as needing separate platform qualification:
the shared platform staging service does not provide concurrent isolated
platform previews for every PR.

The controller runs from reviewed Main code on its protected, tree-identical
execution ref. Do not activate it by pointing the controller variable at an
unqualified feature branch. After merge, qualify the genuine Main source,
deploy the platform status proof addition and set any explicit preview cap
override to 16, verify an exact-source runtime and matching desktop canary, and follow the
existing host-first controller-pin procedure. Until that activation is complete,
the label alone does not establish a working preview service. Enable
`MATRIX_PREVIEW_REVIEW_ENABLED=true` only after that canary. Existing manual
preview jobs drain before new queue admission.

The scheduler retains inactive reservation history for seven days and prunes
up to 100 old entries per pass. An incomplete inventory holds new admission
while known previews can still be cleaned up. Inspect the queue workflow and
reservation statuses if slots remain held after merge/expiry. Roll back by
disabling the feature flag; drain existing reservations through reviewed
cleanup before disabling the scheduler permanently.

This change adds GitHub orchestration and package links, with no new app UI.
Future agent-led acceptance tests and recordings can attach to the same source
evidence, but are not delivered by this change.
