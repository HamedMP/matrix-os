# Sync recovery release evidence

This file is the public-safe release checklist for
`recovery-and-desktop-plan.md`. It records source and synthetic evidence only;
it contains no customer identifiers, private hosts, credentials, bucket names,
or incident commands.

## Invariants for every stacked PR

- Source of truth: verified `{ownerId, runtimeSlot}` scope; versioned local
  mapping config; Postgres accepted-manifest metadata; immutable object bytes.
- Lock/concurrency scope: mapping file exclusive lock plus expected revision;
  owner/runtime Postgres advisory transaction plus accepted-pointer CAS.
- Acceptable orphans: unique staging objects and immutable blob/manifest
  generations may survive a failed publication and are never accepted state.
  The bounded collector removes old staging objects, interrupted staging
  multipart uploads, and unaccepted manifest generations after a seven-day
  grace period. Immutable blobs remain retained until an in-flight publication
  lease can prove deletion cannot race a paused commit.
- Auth source: verified interactive bearer for Settings; renewable,
  capability-restricted sync-device grant for the helper. Browser WebSocket
  query-token registration remains explicit.
- Deferred scope: cross-owner data plane, history/versioned file restore,
  Finder placeholders, arbitrary mobile watchers, remote control of another
  device's mappings, and automatic retention pruning.

## Surface matrix

| Capability | Web Canvas | Web Desktop | Electron Desktop | Web Mobile | Native Mobile |
| --- | --- | --- | --- | --- | --- |
| Remote file count, conflicts, last sync | shared read-only Settings | shared read-only Settings | local helper plus remote health | responsive shared read-only Settings | native read-only Settings |
| Database backup freshness/schedule/restore test | yes | yes | yes | yes | yes |
| Select arbitrary local folder | limitation shown | limitation shown | native directory picker | limitation shown | limitation shown |
| Full-home and additional mappings | view remote health only | view remote health only | create, preview, pause, resume, rescan, remove | view remote health only | view remote health only |
| Background helper reconnect | open Desktop handoff | open Desktop handoff | rotate device grant without changing mappings | open Desktop guidance | Desktop-required guidance |

Web Canvas and Web Desktop use the same Settings feature and state derivation;
their surrounding chrome differs. Electron Desktop is the native interaction
reference. Mobile deliberately omits local-directory mutation because browser
and mobile background/file-access capabilities cannot satisfy the same safety
contract.

Automated evidence covers loading, empty, offline/stopped, reconnect-required,
activity, conflict counts, backup health, folder selection, both add-folder
entry points, mutation failure preservation, bounded permission/disk/oversize
issues, Escape, and focus return. Responsive and reduced-motion rules are in
the shared stylesheet. Real screenshot/keyboard evidence must still be captured
in this order: Web Canvas, Web Desktop, Electron Desktop, Web Mobile, Native
Mobile.

## Local evidence

| Slice | Commit | Evidence |
| --- | --- | --- |
| Profile/config repair | `801d4fab9` | migration/restart and profile-binding tests |
| Protocol/immutable publication | `ef2a6440f`, `28a4b174d`, `495293503` | accepted generation, scope, zero-byte, staged-byte validation, same-path race fixtures |
| Reconciliation safety | `c6b884253`, `939e39a4d` | divergence, delete retention, bounded/coalesced intent fixtures |
| Multiple mappings | `afb2a8330`, `aa92ad73a`, `0a0403c06` | optimistic config and isolated mapping-session tests |
| Backup health | `42833ddc1` | real backup-script fixtures and bounded status contract tests |
| Renewable helper auth | `13f5ae19c` | enrollment/rotation/replay/revocation and daemon renewal tests |
| Packaged helper | `2232e507b` | deterministic manifest/digest, installer rollback, IPC and release-workflow tests |
| Settings parity | `a219c41f1` | shared Desktop/web/native-mobile state, accessibility, mutation preservation, and strict package types |
| CLI/handoff protocol | `801c691e0`, `8aee0aafd` | current terminal workspace API, publishable contract dependency, package-runner and standalone CLI tests |
| Recovery operations | `7e8ff2bb9`, `f87a55bf0` | public-safe rollout gates and bounded publication-orphan collection |
| Release portability | `9d60fb4d6`, `d6f3d9bd7` | executable shell lint, isolated staged dependency install, immutable object reuse checks, staged production-loader smoke |
| Explicit failures | `50de46d55` | zero mandatory pattern violations, typed catches, bounded cleanup logging, no credential/provider detail in logs |
| Helper portability | `62f1010c3` | reject Linux helpers with the wrong target architecture or a builder-specific ELF interpreter |

At `2026-09-17T07:32:06Z`, a custom-format dump containing an isolated schema
and two fixture rows was hashed, restored into a separately named disposable
PostgreSQL 16 database, and queried successfully (`2|alpha, beta`). The source
database, restore database, dump, and checksum file were then verified absent.
This records the synthetic restore-test time only; it does not mutate a live
backup receipt or claim a customer restore.

## Local validation snapshot

- Sync client: 52 files and 482 tests pass, including daemon IPC, renewable
  credentials, mappings, reconciliation, publication, and standalone runtime.
- Focused changed surfaces: 83 gateway sync tests, 9 shared/web Settings tests,
  and 32 Desktop helper/release-workflow tests pass. The applicable native
  mobile Settings/request suite has 12 passing tests from the Settings slice.
- Strict TypeScript passes for contracts, sync client, gateway, platform,
  Electron main/preload/renderer, and shell. Production shell and Electron
  renderer builds pass.
- The mandatory pattern scanner reports zero violations. Its five warning
  classes were reviewed: mutating routes have bounded body middleware;
  collections are schema-bounded, request-local, or capped; daemon IPC input
  is capped; filesystem paths use validated scope/root resolvers; owner/runtime
  identifiers are schema-validated before storage use.
- Whole-repository shell lint now executes through Next's parser. It still
  reports 52 errors and 86 warnings in pre-existing files; the changed Sync &
  backup section is lint-clean. One host-bundle test retains a pre-existing,
  environment-sensitive stderr expectation failure; the other 70 host-bundle
  tests pass.

## Exact local artifacts

- Host bundle `sync-recovery-local-50de46d55` embeds commit
  `50de46d55defc1334f218db62124f14b19d90e0d`, is 946,323,327 bytes, and has
  SHA-256 `3f3989733d918076892bda98b4e1e20a8592b8a7b4ec68f7e05f2a5b604e817c`.
  Its checksum passes, staged gateway production imports resolve, the bundled
  CLI reports 0.3.16, the incremental manifest lists 7,464 files, and all
  8,062 staged symlinks resolve within the bundle root.
- The unsigned Linux x64 AppImage is 265,790,972 bytes with SHA-256
  `5ba96fb3885694eb058a9c91fbd3dbaca48f30cf75f1554a453e91f64067e33d`.
  Its executable helper reports 0.3.16, has SHA-256
  `42415f9eb0a55aeaf35a72d5651b29c4bad14de5687b69cb8cc681c57ae4cb58`,
  matches its embedded manifest, and requests the target loader
  `/lib64/ld-linux-x86-64.so.2`. The helper was built with the official Bun
  1.3.14 Linux archive after verifying the release archive SHA-256
  `951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f`.
- The public npm registry still serves `@finnaai/matrix` 0.3.15 while source
  and the local artifacts are 0.3.16. Nothing was published by this task.

These are synthetic local artifacts only. They were not uploaded, registered,
promoted, deployed, or used to activate mirroring. The host-bundle build also
reported security advisories in pinned Symphony/Elixir HTTP dependencies,
including high-severity advisories. Updating that dependency set requires a
separate security review and is a release blocker, not silent scope for this
sync-recovery stack.

## Artifact gates

- Standalone CLI: build binaries; run package-runner validation and the exact
  produced executable's version/help/sync command smoke tests.
- Production shell: build with the canonical production command and required
  build-time public environment. No development fallback counts as evidence.
- Electron Desktop: build/package from a clean artifact; verify the embedded
  helper manifest, digest, executable bit, install/upgrade/rollback, quit,
  restart, and simultaneous CLI control. Signed/notarized macOS evidence must
  run on macOS; Linux cannot substitute for it.
- Platform/gateway: publish before clients, verify protocol-v3 capability
  response and sync-device broker routes, then test only a reviewed disposable
  runtime.
- VPS host bundle: verify exact version plus gateway/shell/sync-agent/backup
  timer health. A host bundle does not update the platform or installed Desktop.

## Rollout requiring approval

1. Restore GitHub/Graphite authentication; submit the stack with Conventional
   Commit PR titles and this invariant section.
2. Reach Greptile 5/5 and required CI on every PR. Do not merge from this task.
3. Run dedicated real-R2 primitive tests in a synthetic prefix, including
   interrupted multipart, missing accepted blob, orphan grace, and storage
   fingerprint checks.
4. Repeat the isolated restore against the exact release backup format and
   record the reviewed receipt's `restoreVerifiedAt`. Do not download or restore
   a production database without separate authorization.
5. Produce and test exact CLI, Electron, platform, gateway, and host-bundle
   versions. Publish/deploy only after separate authorization.
6. Enable mirroring only on a reviewed disposable runtime, observe bounded
   health, then request separate authorization for any wider activation.

Current blockers: Swift/signing tools are unavailable on this Linux host;
external storage and a reviewed release backup receipt are not currently
available; pinned
Symphony/Elixir dependencies report unresolved security advisories. GitHub
authentication was restored after the initial local work, but CI and Greptile
still must complete on submitted PRs. No release, deployment, production
mirroring, backup-job change, or customer-data operation is evidence-backed by
local source and synthetic tests alone.
