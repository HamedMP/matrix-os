# Electron startup and account isolation checkpoint

Tracking: [ENG-418](https://linear.app/matrix-os/issue/ENG-418), native
[stack](https://github.com/HamedMP/matrix-os/stack/3026). This layer follows
#3058 and implements T018–T020 plus the startup part of T025. The downloadable
launcher, visible role and full three-process acceptance remain subsequent work.

## Faults and boundaries

Source issues a five-minute, domain-separated signed descriptor only after the
existing authenticated manifest/readiness path succeeds. Public verification
provides a coarse current/not-current answer, no credential/session/grant. It
checks two real database snapshots around bounded current membership observations.
Real Postgres cases reject source, runtime-slot and authority-epoch drift while
the persisted pair still says ready; stop and revoked membership invalidate it.
Bad signatures and oversized streamed bodies fail before membership reads.

Electron verifies the signature through the fixed first-party Source, its embedded
source commit and actual OS/architecture before selecting any profile, singleton
lock or credential. Profiles have private, symlink-rejecting role directories and
an exclusive marker; unmarked existing directories cannot be adopted. They reuse
UI preferences across epoch rotations while AuthService drops stale credentials.

Real AuthService red assertions caught accepted wrong cached/new actors, slots,
source bindings and fallback to primary. The fix pins both device-login and
runtime exchange to the candidate API and expected non-primary slot. A real
LocalStore roundtrip/restart preserves the binding. Normal login tests remain.
The browser callback is polling-only for these apps; verified mode disables OTA
and runtime protocol claims. The actual electron-builder config-loader test
caught inherited protocols surviving `protocols: []`; its deep merge requires
`protocols: null`. Ordinary release configuration stays unchanged.

## Executed checks

- Desktop core cohort: **102 tests / 8 suites passed**; real production helpers,
  synthetic Source HTTP/provider observations, temporary owned profiles.
- Packaging/workflow/profile cohort after the config fix: **29 / 3 passed**.
- AuthService/persistence cohort: **14 / 1 passed**; overlaps the core cohort.
- Source route/proof/retained route qualification: **32 / 3 passed** against the
  task-owned Postgres16 database. Local fsync/synchronous_commit are disabled;
  this proves logical transactions/authorization, not power-loss durability.
- Desktop main TypeScript project passed. Further project/build results are
  recorded below when complete; full repository qualification remains T037.
- Actual Electron41.10.7 under Xvfb: a 200ms ESM top-level await completed and
  selected both session paths before `app.isReady()`, then reached ready and
  exited0. The initial spike incorrectly awaited `whenReady()` at module top
  level and deadlocked; only the corrected `.then` spike is qualified. This is
  SDK timing evidence, not a full two-app test or live visual evidence.
- First production Electron build transformed main/preload successfully, then
  the renderer was killed with exit137 under shared-host memory pressure.
  A bounded one-worker retry is recorded separately. No build success is implied.

## Review and surface limits

Electron Desktop is affected; actual screenshots/recording, native macOS,
normal+owner+member process journey and protected pair acceptance remain open.
Web Desktop has no UI change in this layer; canonical launch routes support the
Electron client. Web Canvas/Web Mobile/Native Mobile have no client changes.
Architectural surface exclusions need reviewer agreement. No customer changes,
paid activation, grant mutations, deployment or Slack post occurred.
Recommend collaboration/platform and Electron/auth owner review. This checkpoint
is a draft, not a live-qualified or merge-ready feature.
