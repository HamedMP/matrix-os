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
| Settings parity | `a219c41f1` | 478 sync-client, 133 shared/Desktop/web, and 12 native-mobile focused tests; strict package types |

At `2026-09-17T07:32:06Z`, a custom-format dump containing an isolated schema
and two fixture rows was hashed, restored into a separately named disposable
PostgreSQL 16 database, and queried successfully (`2|alpha, beta`). The source
database, restore database, dump, and checksum file were then verified absent.
This records the synthetic restore-test time only; it does not mutate a live
backup receipt or claim a customer restore.

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

Current blockers: GitHub credentials are not authenticated in this environment;
Swift/signing tools are unavailable on this Linux host; external storage and a
reviewed release backup receipt are not currently available. No release,
deployment, production mirroring, backup-job change, or customer-data operation
is evidence-backed by local source and synthetic tests alone.
