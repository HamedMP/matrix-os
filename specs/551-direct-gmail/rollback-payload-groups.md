---
status: active
issue: ENG-355
---
# Preserve launcher access across pilot rollback

Ticket: https://linear.app/matrix-os/issue/ENG-355/prepare-gmail-oauth-verification-and-casa-evidence

A restricted pilot rollback exposed a host updater defect: initial launchers use root ownership, the Matrix group and mode0750. Sealing the update transaction recursively changed their saved group to root; restoring those bytes with `cp -a` then prevented the Matrix service account from executing them.

Keep the snapshot and all control files root-owned with no group/world writes. Preserve only the existing allowed group of a flat, already-root-owned bin payload, including root-only files. Root-owned directories must be sealed before bounded child traversal. Reject links, special files, unexpected ownership and writable privileged payloads; pin directory identities without following symlinks. Keep release metadata, service state and owner files unchanged.

The implementation remains inside the focused recovery library; the large sync-agent entrypoint receives no new behavior. A real Linux fixture must reproduce group loss before the fix, then verify restored execution, private payloads, control sealing, link/special-file rejection and traversal bounds. Run all tests/builds remotely. Add the regression to hosted CI, obtain current-head review, then qualify the new exact bundle through the disposable pilot's supported rollback/update path with synthetic owner-file canaries. Existing snapshots that already lost their group require separately recorded operator recovery; this change does not infer historical ownership.

The existing mandatory Protected Funded Host Root Contracts CI lane runs the fixture inside its disposable, network-disabled Linux container and rejects skipped cases. Ordinary unit tests require no elevated permissions. The separate site documentation deliverable remains the shared Gmail stack's public documentation PR.

No new network endpoint, persistence service, provider access, Google activation or production rollout is introduced. Integration/deployment owner review is recommended. A source-level fix is not live rollback qualification.
