# Sync recovery implementation checklist

This checklist tracks the active recovery plan in
`recovery-and-desktop-plan.md`. The older `tasks.md` records the original 066
implementation and is retained as historical compatibility context.

## P0 — Revalidate and characterize

- [x] Re-read repository constitution, AGENTS guidance, recovery plan, and handoff.
- [x] Verify isolated worktree/branch and current `origin/main` baseline.
- [x] Install the workspace from the frozen lockfile with pinned pnpm 10.33.4.
- [x] Add deterministic profile migration/restart and Swift IPC reproductions.
- [x] Add publication race, scope isolation, missing manifest, and zero-byte reproductions.
- [ ] Add the startup mirror-divergence reproduction before changing reconciliation.
- [ ] Record sanitized local capability/operational evidence without customer identifiers.

## P1 — Profile/config and protocol repair

- [x] Add one profile-aware sync config resolver and safe, idempotent migration.
- [x] Bind daemon restarts to the configured profile instead of the mutable active CLI profile.
- [x] Make local status fields coherent and distinguish expired auth from connection state.
- [x] Repair the native Swift IPC envelope, typed errors, and awaited actions.
- [x] Pass legacy/profile/both-files, permissions, stale service state, and restart tests.

## P2 — Scope, auth, and immutable publication

- [x] Land shared scope/status contracts and owner/runtime isolation.
- [ ] Add scoped renewable background sync-device credentials.
- [x] Stage uploads, finalize immutable blobs, and CAS accepted manifest generations.
- [x] Prove concurrent same-path, staging replay, hash mismatch, metadata-CAS rollback,
  missing accepted manifest, and runtime isolation cases with synthetic fixtures.
- [ ] Prove interrupted multipart, missing committed blob, credential rotation/revocation,
  and an isolated real-R2 primitive fixture; add grace-period orphan collection.

## P3 — Shared reconciliation and VPS mirror safety

- [ ] Extract shared file policy and reconciliation semantics.
- [ ] Preserve divergent edits/deletes and block unsafe bootstrap deletion.
- [ ] Add bounded queues/transfers/events/temp cleanup and common scenario tests.
- [ ] Keep production mirror activation gated.

## P4 — Multiple mappings and CLI

- [ ] Add versioned mapping/session schema, migration, overlap planner, and revisions.
- [ ] Add list/add/pause/resume/remove/status/conflicts/rescan CLI contracts.
- [ ] Prove full-home plus custom mappings and restart/runtime isolation.

## P5 — Backup status and controlled activation

- [ ] Resolve effective storage privately with sanitized fingerprints.
- [ ] Harden backup locking/timeouts/receipts and scheduler reconciliation.
- [ ] Expose truthful backup health and verify a synthetic disposable restore.
- [ ] Prepare, but do not perform, scoped mirror/backup rollout.

## P6 — Electron helper lifecycle and packaging

- [ ] Bundle a versioned helper independent of global CLI/source checkout.
- [ ] Add trusted typed Electron IPC and secure credential handoff.
- [ ] Verify packaged enable/restart/quit/update/rollback behavior.

## P7 — Settings UX and surface parity

- [ ] Add shared Sync & backup components and real controller contracts.
- [ ] Wire Web Canvas, Web Desktop, Electron Desktop, and applicable mobile health views.
- [ ] Verify loading/offline/conflict/error/accessibility/theme/small-window states.

## P8 — Release evidence and documentation

- [ ] Run focused, type, pattern, package, shell, desktop, and applicable mobile gates.
- [ ] Update contracts, sync testing, CLI, deployment, backup, and public documentation.
- [ ] Publish reviewable Graphite stack after GitHub authentication is restored.
- [ ] Reach Greptile 5/5 and label-gated CI without merging or deploying.
