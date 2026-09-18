# Sync recovery and Desktop Settings implementation handoff

Status: implementation-ready draft; no production changes authorized by this document.
Prepared: 2026-09-17. Code baseline: `origin/main` at `70810951d`.
Audience: Sol implementing the feature in reviewable PRs.

## 1. Outcome and scope

An owner can open Electron Desktop Settings > Sync & backup, enable a full Matrix Home mirror to a selected local folder, add individual local/Matrix folder pairs, and see accurate transfer, conflict, connection, and database-backup status. CLI and Electron control the same local service and persisted configuration. Sync continues after closing the Desktop window and after a normal user login/reboot. Expired or revoked credentials produce an actionable state rather than a crash loop.

Matrix Home means the owner's Matrix home, not the VPS filesystem root. Full-home sync includes eligible files throughout that home, subject to explicit security exclusions and resource limits. It does not copy a running Postgres database. Database backup is a separate recovery capability; current file sync is not historical file backup.

Deliver the full requested flow, including multiple folder pairs. A repaired CLI alone or a settings page with mocked status is not completion. Do not broaden this work into cross-owner folder sharing, a database replication engine, Finder File Provider, or arbitrary remote device administration.

The repository's older 066 documents are historical context. Several follow-up entries are obsolete. Inspect current code/tests before implementing; preserve working conflict, ignore, and reconciliation behavior rather than rebuilding from the old task list.

## 2. Assessment and corrections to the initial diagnosis

| Finding | Evidence / confidence | Required response |
| --- | --- | --- |
| Profile configuration split | `lib/profiles.ts` migrates legacy config into a profile; daemon startup and sync commands still use the global default loader | One explicit profile-aware configuration resolver; safe idempotent migration |
| Electron integration absent | Settings section registry, main-process handlers and IPC contract have no file-sync feature | Shared contracts, trusted local service adapter, and settings feature |
| Native menu app contract drift | Swift sends no protocol version/request ID and expects string errors; daemon requires versioned envelopes and object errors | Repair compatibility while introducing Electron integration; preserve existing installs |
| Production mirror defaults off | Gateway enables it only for `MATRIX_HOME_MIRROR=true`; VPS provisioning does not inject that setting | Capability and safe activation wiring after correctness gates, not unconditional early enablement |
| Backup scheduling can silently stop | An enabled systemd timer may be inactive; service success does not prove current scheduling | Reconcile timer state and expose last success, last attempt, next due and scheduler health |
| Storage observations disagree | Broker and direct R2 inspection returned different latest pointers | Resolve effective storage destination; do not yet assert wrong bucket/account as the cause |
| Insufficient mapping model | `syncPath` + `gatewayFolder` represent one pair; `folders`/`exclude` are not consumed by the running daemon | Versioned mapping collection with enforceable scope, direction and overlap rules |
| Misleading status | API returns `connectedPeers`, CLI reads `peers`; `pendingConflicts` is zero; daemon `syncing` means not paused | Contract tests and separate enabled, connected, active-transfer and conflict states |
| Unsafe VPS startup merge | `home-mirror.ts` pulls differing remote bytes over the local file, without a persisted common-base comparison | Shared reconciliation semantics and recoverable conflicts before mirror activation |
| Blob/manifest race | `presign.ts` gives PUT access to the live path object before `commit.ts` checks the manifest revision | Reproduce deterministically, then isolate uploads from committed bytes |
| Runtime namespace disagreement | Home mirror derives a slot-specific ID; sync routes use principal user ID; platform broker authorizes raw user prefixes | One scope derivation used across authorization, HTTP, WS, DB and R2 |
| Exclusion asymmetry | Local ignore defaults differ from VPS defaults, with incomplete credential exclusions | Shared policy applied to scan, upload, download and delete |

Missing manifests at a few checked keys do not prove no file data exists anywhere. Token expiry is observed state, not proof that login is the only fix. A successful broker HEAD proves object existence, not restorability. Keep these distinctions in implementation reports.

## 3. Product decisions

### Settings layout

Place **Sync & backup** in the Machine settings group and support direct navigation to it.

1. **This computer**: master enable toggle, selected Matrix computer/runtime, service/auth/connection state. Enabling starts a setup flow if no mapping exists; turning off pauses this device's transfers while keeping both copies.
2. **Synced folders**: default **Matrix Home** row plus additional mappings. Each row shows Matrix path, local path, direction, progress/state, last successful reconciliation, and an actions menu.
3. **Database backup**: scheduler state, latest verified uploaded backup, next scheduled run, last failed attempt, last restore-test date if known. Label unavailable/unknown values truthfully.
4. **Details**: recent bounded activity, excluded/skipped file counts, conflicts, safe diagnostics. Keep R2 bucket names, object keys, tokens and provider errors out of product copy.

Primary setup is: Enable sync -> choose local folder -> preview Matrix computer, scope and exclusions -> enable. Default local destination is `~/matrixos/<stable-runtime-label>` for a new install; preserve existing paths during migration. Default Matrix scope is `/` and default direction is **Two-way**. Explain that eligible file changes flow both ways. Never silently redirect an existing mapping when the user changes the selected Matrix computer.

**Add folder** offers “Folder on this computer” and “Folder on Matrix.” Either entry point ends at the same mapping form with both endpoints and direction visible. Starting locally suggests `projects/<folder-name>` as the remote destination and requires an explicit chosen/confirmed destination. Starting remotely suggests a new local directory. Neither entry point silently decides overwrite behavior.

Directions:

| Mode | Source of changes | Destination behavior |
| --- | --- | --- |
| Two-way | Both endpoints | Reconcile against last common base; preserve divergent edits as conflicts |
| To Matrix | Local endpoint | Never download into the source; differing independently changed Matrix files become conflicts |
| To this computer | Matrix endpoint | Never upload from the destination; local edits are preserved as conflicts, never silently overwritten |

Deletion propagation is a separate advanced setting, **off by default for new mappings**. Source deletion then retains the destination and reports a retained item, rather than resurrecting or repeatedly deleting it. When explicitly enabled, propagate only a confirmed deletion of a previously tracked file and only in the mapping's allowed direction. A missing/unmounted root, failed scan, empty response, expired credential or lost baseline is never evidence of deletion. Migrate existing mappings with deletion propagation paused until the user reviews the setting; show that migration change.

Removing a mapping stops it and forgets the association; it never deletes either folder. Path/direction/runtime edits pause, drain/cancel old operations, require a new preview and establish a new baseline without erasing old data. Add flow may create a missing child destination using validated parents; never create an unmounted volume root. Empty directories are not promised by the initial file-only protocol; disclose that limitation.

### Overlap rules

Reject equal or nested local roots across active mappings after realpath/case-normalization, including mappings in different profiles. Reject equal/nested remote prefixes in the same owner/runtime unless the parent mapping has an explicit subtree exclusion.

Support the important full-home-plus-project use case: adding local `~/Work/project-a` -> Matrix `projects/project-a` offers to exclude that subtree from the Matrix Home mapping. Save the exclusion and new mapping together in one versioned configuration write. Preview the handoff, preserve existing copies, and block activation if conflicts cannot be reconciled. Removing the child mapping does not silently re-include the subtree in its parent; offer that as a separate action with a preview.

### Surface and operating-system boundaries

Use shared schemas, state derivations, copy and web UI components for Web Canvas, Web Desktop and Electron Desktop. Electron alone can select and watch arbitrary local folders using a trusted native adapter. Browsers show the same runtime sync/backup health and an explicit “Open in Matrix Desktop to sync folders on this computer” action; they cannot claim a browser-local background watcher is active. Do not add an unauthenticated localhost control API.

Web Mobile and Native Mobile expose remote sync/backup health through their existing settings patterns, with the same recovery semantics. Arbitrary local directory background sync is outside this release because mobile/browser file-access and background-execution capabilities differ. Record these limitations in the required surface matrix and obtain normal PR review of the rationale.

macOS Electron and macOS/Linux CLI are the initial local-service targets. Audit packaged Electron platform support in the first phase; platforms without a tested service adapter must show an explicit capability state. Do not present an enabled toggle on Windows until its adapter is implemented and tested. A Windows service adapter is a separate follow-up if current supported releases require it.

## 4. Architecture and ownership

Keep the existing three-actor design: local sync service <-> authenticated gateway/R2 transport <-> VPS home mirror. R2 stores bytes; gateway services enforce identity, scope, file policy and publication. Database backup uses the existing VPS backup job and platform broker.

Introduce contracts under `packages/contracts/src/sync*.ts`, exported normally. They own Zod schemas and pure state derivations, not filesystem or Electron dependencies. Prefer a small focused `sync-core` module/package for path policy and reconciliation shared by gateway and local daemon; do not import the CLI composition root into the gateway. Read `ARCHITECTURE.md` / `DOMAIN.md` before selecting the package boundary.

Use **one local per-OS-user supervisor** with isolated sessions keyed by `(profile, ownerId, runtimeSlot)`, and multiple mappings per session. CLI and Electron attach to that supervisor. Preserve shell/port/MCP daemon functions and their existing IPC consumers; extract sync responsibilities without changing unrelated CLI behavior. The supervisor is the sole writer of mapping config and sync state. Concurrent commands use expected config revision checks.

Suggested decomposition from the existing 1,500+ line daemon and 1,000+ line home mirror:

- Profile/scope resolver and legacy migration.
- Mapping config repository and overlap planner.
- Per-scope session lifecycle and credential provider.
- Shared reconciliation planner and bounded transfer queue.
- Local filesystem apply/scan adapter and gateway home adapter.
- Status/event aggregator and IPC handlers.
- Service installation/lifecycle adapter.

Extract with characterization tests before adding behavior; keep new modules focused and generally below 500 LOC.

### Sources of truth

| State | Canonical owner |
| --- | --- |
| Signed-in identity and allowed runtime | Verified platform credentials + runtime routing authorization |
| Local mapping definitions | Versioned atomic files under the CLI config root, owned by the supervisor |
| Local common-base state / pending operations / conflicts | Per-scope, per-mapping atomic local files; derived caches are rebuildable without deleting user data |
| Published remote revision and entries | Gateway sync repository, with one defined publication protocol across Postgres and immutable R2 manifests |
| Blob bytes | Finalized immutable R2 objects referenced by an accepted revision |
| Backup attempts and verified success | Bounded VPS status metadata plus broker-verified backup objects/pointers |
| UI | Read-only snapshots + typed commands, never independently inferred readiness |

Local file configuration/cache is allowed; do not add an embedded database. Server persistence uses Postgres/Kysely. Keep DB pools owned by their creator and close them on gateway shutdown.

### Proposed local schema

```ts
type SyncMapping = {
  id: string;                    // stable UUID
  label: string;
  localRoot: string;             // selected canonical absolute path
  remotePrefix: string;          // normalized home-relative path; "" = Matrix Home
  direction: "two_way" | "to_matrix" | "to_local";
  enabled: boolean;
  propagateDeletes: boolean;
  excludes: string[];            // bounded user patterns; cannot override security exclusions
};
type SyncProfileConfig = {
  schemaVersion: 2;
  revision: number;
  profile: string;
  ownerId: string;
  runtimeSlot: string;
  deviceId: string;
  enabled: boolean;
  mappings: SyncMapping[];
};
```

Retain canonical profile platform/gateway settings in their existing profile source; avoid a competing endpoint store. Suggested paths are `profiles/<profile>/sync/<scope-id>/config.json` and `state/<mapping-id>.json`, with `<scope-id>` deterministically derived from validated owner/runtime identity. Global daemon socket/PID belong to the supervisor, not individual mappings. Keep total mappings bounded (initial cap 32 per OS user) and expose a specific safe limit error.

Migrate global and profile configs once under an exclusive migration guard. Prefer an existing valid profile destination; never `rename` over it. If both contain distinct valid mappings, preserve both sources and require scope/path disambiguation rather than choosing silently. Persist a bounded migration journal and rollback copy with original permissions. An old config's missing owner/runtime must be resolved with authenticated profile data before any transfer. Preserve `syncPath`, `gatewayFolder`, pause state, peer identity and known baseline/conflicts where trustworthy; otherwise bootstrap nondestructively. Never move files just to migrate configuration.

### Runtime scope and authorization

Create one server-side `SyncScope { ownerId, runtimeSlot }` resolver. Derive owner from the verified principal and runtime from trusted instance context/authorized runtime selection, then verify they agree. The client cannot choose an arbitrary owner prefix. Use it for HTTP routes, WS registration, mirror peer identity, R2 key construction, broker authorization and DB locks.

Preserve primary-runtime keys for compatibility where safe. Version non-primary namespace behavior and migrate explicitly. The current broker's raw-owner prefix check must be updated with the runtime resolver; simply changing the gateway's `getUserId` is insufficient. Never give one VPS access to another runtime by accepting an unverified slot header or arbitrary R2 key. Test owner A/owner B and primary/secondary isolation through the real routing middleware.

### Auth and independent background operation

Electron main reuses its authenticated session to authorize sync; no second browser login for an already signed-in owner. Tokens never enter renderer snapshots, command-line arguments, logs or synced folders. The daemon must remain authenticated when the Electron process exits.

The current optional `refreshToken` field does not establish a working refresh flow. Verify platform issuance/rotation/revocation first. If absent, implement a **sync-device grant** using the existing device-auth infrastructure: authenticated enrollment, runtime-scoped short-lived access tokens, rotating opaque refresh credentials stored hashed server-side, expiry/revocation and replay tests. Restrict sync-device credentials to sync/backup-status capabilities; they must not grant terminal execution or unrelated platform APIs. Existing owner credentials may still call those routes under existing policy.

Use the macOS credential store through a daemon-accessible secure adapter; preserve a restrictive 0600 credential-file fallback only for supported headless/Linux CLI environments according to existing policy. Do not ask the daemon to decrypt Electron `safeStorage` bytes with incompatible runtime assumptions. Prove the credential adapter in the packaged app, not only under dev Node. A sync credential remains scoped to its owner/runtime after UI runtime switches.

Refresh is single-flight per session, bounded and retried with jitter. Offline refresh leaves a recoverable offline state. Revocation/expiry pauses network work while preserving pending edits. Desktop sign-out revokes/clears that Desktop-enrolled sync grant and pauses affected mappings; an independently enrolled CLI grant is not silently erased. No automatic switching to another active profile or account on an auth failure.

### Publication and conflict safety

Before broad activation, reproduce the live-path upload race: writers A and B upload different bytes to the same path, only A's expected revision commits, and readers must still obtain A's hash. The current path-keyed PUT architecture cannot provide that invariant reliably.

Use staged uploads and immutable finalized object references. A client may upload only to its scoped staging object; it never receives PUT access to committed objects. Finalization validates size and SHA-256 and promotes to a unique immutable key. The accepted manifest references that key/hash. A stale/rejected commit must not change published bytes, and a still-valid staging URL cannot mutate a committed object. Keep staging/promotion idempotent and garbage-collect unreferenced objects after a grace period. Prefer a bounded server copy/conditional operation when proven against the real R2 API; otherwise use bounded streaming validation/promotion. Do not assume multipart ETags equal SHA-256. Capture the storage primitive spike before finalizing this contract.

Publish immutable manifest generations and advance a Postgres pointer with revision CAS inside the owner/runtime critical section. Stage objects/manifests before the short DB transaction; failed CAS leaves only reclaimable orphans. GET reads the accepted generation referenced by the DB. Missing referenced generations produce a degraded/error state, never a synthesized empty home. The legacy mutable manifest may be maintained as a compatibility export, not a competing authority. Recovery/backup must retain enough metadata to recover the accepted pointer; do not automatically promote the highest uncommitted object version after a crash.

Version this protocol and capability-negotiate it. Legacy clients must not keep issuing path-keyed writes into a migrated scope; return a safe upgrade-required state until updated. Preserve legacy data and validate imported blob hashes before migration. Delay destructive legacy cleanup until rollback and restore evidence exist.

Each local/mirror apply compares current local bytes, the last acknowledged common base, and incoming remote revision. Existing differing content with no base becomes a conflict. Preserve both versions for edit/edit and edit/delete; use conflict IDs and an explicit keep-local/keep-Matrix/keep-both resolution with revision preconditions. Never resolve conflicts by silently retrying a stale write against a newer manifest version. Reuse existing daemon reconciliation tests and extend the same semantics to the VPS mirror.

Writes use exclusive temporary files, verified hashes, atomic rename, and a final local-change check so an edit during download is preserved. Deletions and renames obey the same baseline preconditions. Treat rename as validated add + tombstone initially, not a heuristic that may delete unrelated files. A case-only or Unicode-normalization collision on the destination filesystem becomes a blocked item with useful copy.

### File policy and resource limits

Share defaults between daemon and mirror. Hard-exclude sync internals, credentials, private keys, `.env` secrets, auth stores, browser profiles, sockets, live database directories, and known credential files such as `.claude/.credentials.json`. Hard exclusions cannot be undone with `.syncignore`. User exclusions cover build/cache/log/generated files and intentional subtree separation. Show exclusions so “Matrix Home” is honest about coverage. Public certificates are not universally secrets; classify known private-key formats/paths instead of banning all document extensions blindly.

Policy applies at both client and server boundaries: scan, presign, commit, WS apply, startup pull, conflict handling and delete. Skip symlinks/special files in v1 and validate parents against symlink replacement and mount changes. Protect local home root, filesystem root, credential roots and the service's config tree from becoming mapping roots; chosen subdirectories and available removable volumes are allowed with identity checks. Do not preserve platform-specific modes/ownership with privileged operations. Test zero-byte files, which current presign validation rejects.

Initial defaults: 32 mappings/device; 50,000 live remote entries/scope and existing 32 MiB manifest cap; depth 64; queue 10,000 path intents with coalescing and a rescan-needed fallback; four concurrent transfers per device; at most 100 files per commit and 64 KiB command payload; 1 MiB bounded IPC response with pagination. Preserve lower deployed transfer capabilities and publish them accurately; target existing 1 GiB maximum with multipart/streaming rather than buffering it. Over-limit items are visible and excluded from “up to date,” not silently skipped.

APIs default to 10-second deadlines; transfer chunks/downloads use 30-second deadlines with bounded retries and a bounded multipart job deadline. Use exponential retry with jitter capped at 60 seconds. Persist pending intent before acknowledging a command, and record common-base advancement only after remote commit/local apply succeeds. Temporary files have explicit success cleanup plus hourly symlink-safe cleanup of stale files older than 24 hours, excluding active transfers. Cap event history at 200 entries/session, rotate logs (5 x 10 MiB), sweep stale peers, drain subscriptions/queues and clear timers on shutdown. Cap persistent conflict/history metadata too; reaching the cap blocks affected work without deleting unresolved user copies.

## 5. Contracts, status and security

Use one snapshot contract with separate dimensions instead of one overloaded `syncing` boolean:

- `service`: stopped / starting / running / unavailable.
- `auth`: signed_out / ready / refreshing / needs_sign_in.
- `connection`: connecting / online / offline, with `observedAt` and staleness.
- Per mapping: disabled / paused / scanning / syncing / idle / conflict / error / root_unavailable; counts for queued, active, failed, excluded and retained-deletion items; bytes transferred/planned; nullable `lastSuccessfulReconcileAt`.
- Remote mirror: supported / disabled / starting / healthy / degraded / unavailable, with last scan and failure information.
- Database backup: scheduler enabled/active, last attempt, last uploaded-and-verified success, next due, restore verification, coarse storage reachability and freshness.

“Up to date” requires a completed successful scan/reconciliation against a fresh accepted remote revision with no queue, active transfer, unresolved conflict, failed/blocked item or stale connection. A paused mapping never displays as up to date. Missing values are unknown, not zero or success. Distinguish upload verification from restore verification and device file-sync progress from VPS backup state.

Proposed API names below may be adapted to current route conventions; implement matching auth tests and update this table if names change. Reuse `/api/sync/status` with compatible versioned additions instead of creating a second source of truth. Local absolute paths belong only to local IPC, never remote telemetry/status.

| Boundary | Authentication / authorization | Contract |
| --- | --- | --- |
| `GET /api/sync/status` and capabilities | Existing owner principal or scoped sync access token, selected runtime verified | Versioned remote health and capabilities; bounded results |
| Existing sync manifest/presign/commit/multipart routes | Same owner/runtime scope; operation capability + file policy | Revised staged publication, idempotency and conflict schema; bodyLimit on every mutation |
| Existing sync WS path | Existing browser query-token allowlist or bearer-capable client; runtime scope verified before success | Validated bounded frames, sequence/revision recovery; TTL peer cleanup |
| `GET /api/sync/folders` | Owner/runtime read capability | Paginated validated relative directory browsing; no arbitrary server path |
| `POST /api/sync/folders` | Owner/runtime write capability | Create a validated missing destination; bodyLimit, idempotent conflict handling |
| `GET /api/sync/backup-status` | Owner/runtime read capability | Coarse backup metadata; no storage credentials or private object URLs |
| Proposed sync-device enrollment/refresh/revoke routes | Enrollment: authenticated owner/device; refresh: rotating grant; revoke: owner or enrolled device | Zod schemas, rate/body limits, hashed grant persistence and atomic rotation/revocation |
| Platform internal sync broker | Existing machine authentication + DB-resolved owner/runtime | Exact scoped staged/finalized/backup keys; never trust client owner headers |
| Electron `sync:*` IPC | Trusted window/sender validation, active owner and validated payload | Snapshot, choose folder, preview/save/remove/pause mapping, rescan, resolve conflict, safe diagnostics |
| Local daemon IPC | OS-user-only socket directory (0700), socket (0600), versioned requests, ownership checks | Same commands; request ID/version; revisions and bounded framing; no network listen socket |

Mapping mutations include expected configuration revision. Operation commands use IDs so disconnect/retry does not duplicate mappings or conflict resolution. Error codes are allowlisted, bounded and mapped to helpful copy; real provider/DB/path errors stay in private logs. Remote diagnostics do not expose local absolute paths. External URLs must come from trusted configured origins; any user-configurable endpoints require URL validation and applicable SSRF protections.

### Runtime wiring

1. Supervisor acquires its lock and loads/migrates config without filesystem transfer side effects.
2. Resolve profile/owner/runtime, acquire credentials, negotiate capabilities and verify scope.
3. Validate mapping roots and policy; initialize durable state and bounded queues.
4. Establish subscriptions with revision-gap recovery; scan both endpoints and reconcile before declaring readiness. Buffer/coalesce watcher changes that occur during scanning.
5. Transfer and publish; update durable baseline and then emit progress/status. Periodically rescan so missed watch/WS events recover.
6. Electron main validates the daemon identity/protocol, subscribes, and forwards sanitized state to the renderer. CLI uses the same commands and snapshot.
7. Gateway initializes scoped repositories, broker/storage adapter, publication service, mirror and status provider by dependency injection. Disabled/missing dependencies expose capability/unavailable states. Shutdown drains subscriptions before repositories/pools close.

## 6. Implementation slices and acceptance gates

Use sequential reviewable PRs, or Graphite for a dependency stack per `docs/dev/stacked-prs.md`. Do not put the entire feature into one PR. Each slice starts with failing behavioral/contract tests and includes an integration wiring test. These are logical slices; split further at 3,000 additions / 50 files.

### P0 — Revalidate and characterize; no activation

Read constitution, quality gates, architecture boundaries, existing 066 tests and this plan from a fresh manual worktree. Install dependencies at the root using the pinned pnpm/lockfile policy. Record current baseline and capability matrix.

Add deterministic reproductions for profile migration plus daemon restart; peers/status mismatch; malformed Swift IPC; simultaneous path uploads and a rejected commit; VPS startup with divergent local bytes; primary/secondary broker isolation; missing R2 manifest with a nonzero DB revision; zero-byte file sync. Tests for known bugs remain explicitly expected failures only while the corresponding fix is actively being built; do not merge a permanently red default suite.

Privately resolve R2 effective storage by comparing platform revision/environment configuration, endpoint jurisdiction/account, bucket, prefix and authenticated identity against the broker's actual target. Use sanitized storage fingerprints and HEAD/small pointer reads. Do not download customer database contents for a status check. Inspect actual timer enabled/active/next-trigger state and private journal evidence; do not infer why a timer stopped from its current state alone.

Gate: publish a private evidence summary identifying confirmed defects, unresolved operational questions, test commands and platform support. Public repo artifacts contain synthetic fixtures only. No auto-enable or storage repoint in this phase.

### P1 — Profile/config repair and protocol compatibility

Primary files: `packages/sync-client/src/lib/{config,profiles}.ts`, `cli/commands/{login,sync,status,doctor,peers}.ts`, `daemon/{index,types,ipc-handler,service}.ts`, native `SyncStatusModel.swift`, and their current unit/CLI tests.

Implement explicit profile resolution, safe migration, runtime binding, stable service health and coherent status field names. Preserve current single-mapping behavior until P4 migrates it. Fix Swift envelopes and object errors; make pause/settings actions await and surface failures. Do not silently uninstall the standalone app. Keep credentials and profile resolution independent of whichever profile a different CLI command selects later.

Gate: legacy-only, profile-only, both-files-present, permissions failure, stale socket/PID and process-restart tests pass. `matrix login` -> sync -> profile command -> restart still finds the same configuration. Auth expiry is reported as needs-sign-in, not gateway unreachable. Existing shell/port/MCP daemon tests stay green.

### P2 — Scope, auth and storage correctness

Primary files: `packages/contracts`, gateway `sync/{runtime-scope,r2-keys,presign,commit,manifest,db-impl,platform-r2-client,routes,types}.ts`, sync WS wiring, platform `internal-sync-routes.ts`, existing auth/device modules, local transfer/auth adapters, related Kysely migrations.

Split this phase into scope/contracts, sync-device auth, and staged-publication PRs. Implement scope isolation, working background credentials, immutable final blobs and accepted manifest pointers. Add capability negotiation and compatibility migration. All clients, including mirror, use the same commit/publish service. Verify single PUT and multipart against an isolated R2 fixture namespace before choosing storage primitives.

Gate: interrupted upload/commit, concurrent edits/delete+recreate, staging URL replay, hash mismatch, DB rollback after object upload, missing committed object, token rotation/revocation and runtime switch tests prove no corruption or cross-scope access. No transfer requires copying raw R2 credentials to Desktop or the VPS. Scope migration preserves old data and never merges runtimes.

### P3 — Shared reconciliation and safe VPS mirror

Primary files: extracted shared sync-core modules, `sync-client/src/daemon/{sync-engine,conflict-resolver,watcher,index}.ts`, `lib/syncignore.ts`, gateway `sync/home-mirror.ts`, associated tests.

Unify file policy, common-base comparisons, conflict persistence/resolution, watcher event suppression, startup/reconnect scan logic and safe deletion. Reuse and extend working local conflict routines. Add bounded batching, streaming, progress counters and backpressure. On a lost/corrupt cache bootstrap conservatively; no inferred mass deletion. Fail integrity mismatches without altering local content.

Gate: both daemon and VPS adapter run the same reconciliation scenario suite. First enable against two nonempty roots preserves both edits. Offline edits on both sides, root disappearance, disk full, permission loss, case collisions, symlink swaps and stale tombstones cannot erase or escape user data. Clean create/edit/delete round trips converge in the allowed direction with truthful status.

### P4 — Multiple folder mappings and CLI

Primary files: new mapping/session/config modules, daemon IPC, `cli/commands/sync.ts`, service lifecycle, conflict/status commands.

Implement the schema, migration, per-mapping state isolation, overlap planner, preview and atomic revisions. Keep one service across CLI and Electron. Suggested CLI UX: retain `matrix sync <path> --folder <prefix>` compatibility and add `matrix sync list`, `add`, `pause`, `resume`, `remove`, `status --json`, `conflicts` and `rescan`, with explicit profile/runtime/mapping IDs and direction options. Exact argument syntax must be contract-tested, documented and consistent with existing citty conventions.

Gate: full-home plus two custom mappings works concurrently; parent exclusion plus child creation is atomic; changing one mapping cannot redirect another's queued operations. Config survives restart; runtime/account switches preserve associations; removing mappings preserves all files. CLI JSON matches the shared schemas and reports partial failures honestly.

### P5 — Backup recovery, status and controlled activation

Primary files: `distro/customer-vps/{matrix-db-backup.sh,host-bin/matrix-db-backup.sh,matrixctl,host-bin/matrixctl}`, broker helper, backup units, cloud-init, golden activation/validation and host-update scripts; gateway status provider; platform storage configuration/broker; deployment tests. Check canonical/generated duplication before editing and keep duplicate entry points synchronized.

First resolve the effective-storage question from P0. If old/new stores intentionally coexist, identify the authoritative store and document recovery inventory privately. Any migration copies and verifies into the chosen target; do not delete or repoint live data based solely on this plan.

Backups use exclusive run locking, bounded dump/upload timeouts and disk checks. Record last attempt/failure separately from last success. Success requires a completed dump, uploaded object verification and verified pointer advancement. Prefer an immutable receipt with hash, size, scope and timestamp; do not infer integrity from an ETag. Scheduler enabled, active and next-due states are independent fields. Initial freshness rule for hourly backups: healthy within 2 hours, stale after 2 hours, critical after 24 hours; display unknown if no evidence is available. Alert transitions and recovery, not every poll.

Repair timer reconciliation in provisioning, golden activation and update paths. Respect an explicit operator pause/maintenance state rather than undoing it continuously. Hourly scheduling must not depend on the Desktop app or its master sync toggle. Keep existing backup retention until a reviewed retention policy is implemented; report actual retention and avoid automatic remote deletion in this work.

After P2/P3, wire the mirror capability/env into VPS provisioning and updates. Default new rollout activation remains gated. Owner opt-in to R2 file mirroring is distinct from pausing a laptop; expose this state in onboarding/status and persist the choice. Turning off this computer does not disable another device or database backups. Roll out to a disposable VPS first, then an explicitly reviewed production scope.

Gate: fresh provision, golden activation, in-place update and reboot all preserve intended timer/mirror settings. Stopped timer and storage/auth failures become visible. A synthetic database is restored into a disposable database and validated. A known synthetic file is created on the VPS, observed in accepted storage, downloaded locally, edited locally and returned to the VPS. No Docker deployment path for production customer runtimes.

### P6 — Electron lifecycle, secure local adapter and packaging

Primary files: `desktop/src/main/auth`, new `desktop/src/main/sync`, `desktop/src/main/ipc/handlers.ts`, preload, `desktop/src/shared/ipc-contract.ts`, desktop packaging/release assets and local daemon service code.

Bundle a versioned executable/helper with the packaged Desktop app; it must not depend on a repository checkout, globally installed CLI, tsx or the developer's PATH. Use the existing standalone CLI build where suitable. Install/manage the shared per-user service only after enablement. Avoid persisting App Translocation/dev worktree paths. CLI and Desktop negotiate protocol compatibility; neither replaces a newer incompatible helper silently. Upgrades pause/drain, replace atomically, restart and verify readiness, with rollback on failure.

Native directory dialogs return scoped validated selections; the main process enforces sender trust and allowable operations. Local socket ownership/version/identity is checked before sharing credentials. Both normal window close and explicit app quit leave an enabled independent sync service running; sign-out revokes its Desktop-enrolled grant. The UI must explain background operation and offer pause/disable clearly. Preserve unrelated CLI functionality and any independently enrolled CLI sessions.

Gate: clean-machine packaged install with no CLI, enablement, restart, reboot, Desktop quit, simultaneous CLI control, auth renewal, revoked credential, helper crash and app update all work. Tests must exercise the produced app artifact as well as mocked IPC. Repair and retain the standalone native app as a compatibility client during rollout; defer retirement until its user migration is documented.

### P7 — Settings UX and surface parity

Primary files: `packages/ui/src/sync` shared controller/components, `desktop/src/renderer/src/features/settings`, web `shell` settings entry points, mobile settings adapters as applicable, new tests adjacent to existing settings/IPC tests.

Implement the flows from section 3 with real snapshots/actions, shared state derivations and explicit platform capabilities. Consume shared brand primitives/theme tokens. Include loading, empty, disabled, offline, reconnecting, needs-sign-in, conflict, excluded/oversize, permission/disk errors and stale backup states. Do not optimistically clear rows/conflicts before commands succeed. Refresh safely after partial operation failures. Expose progress as determinate only when the total is known; announce material status changes accessibly without per-file announcement spam.

Gate: a new user can complete full-home setup and both Add folder entry points without opening Terminal. Capture real evidence in order: Web Canvas, Web Desktop, Electron Desktop, then applicable mobile surfaces. Show each platform limitation in UI rather than hiding the feature. Test keyboard navigation, focus return, Escape, small windows, dark/light themes, reduced motion, and errors from actual adapters.

### P8 — Release validation, documentation and handoff

Run focused suites, package typechecks, required pattern checks and applicable full repository gates. Build the production web shell for shared shell/platform changes, packaged Desktop for native changes, and the standalone CLI artifact. Follow current repository React audit and mobile gates. Install root dependencies after any manifest change to keep `pnpm-lock.yaml` current. No unpinned package downloads just to run a test.

Publish compatible platform/gateway changes before enabling new clients; stage scope/protocol migration per runtime. Produce separate CLI, Electron, platform and VPS host-bundle release evidence. A host bundle alone cannot update the platform auth/broker service or installed Desktop app. Test exact released versions, not just source dev. Keep the feature unavailable with actionable version copy on incompatible servers.

Update `specs/066-file-sync` contracts/follow-ups, `docs/dev/sync-testing.md`, CLI README and deployment/backup operator guidance, plus a **separate documentation PR in private `FinnaAI/matrix-os-site` under `content/docs/`**. Public docs explain full-home exclusions, directions/deletions, conflicts, background operation, browser/mobile limits, backup scope and restore expectations. Keep customer IDs, hostnames/IPs, bucket credentials and private incident commands out of public docs and PRs.

Each PR needs Conventional Commit title and invariants: source of truth, transaction/lock scope, orphan states, auth source and deferred scope. Review the current head; add `ready-for-ci` when Greptile gives it 5/5. Do not merge below that gate. Clean completed local worktrees only after merged-head, clean-tree and active-task/process checks. Do not merge, publish or deploy merely because this handoff describes those steps; follow the implementation task's actual authorization.

## 7. End-to-end acceptance matrix

| Scenario | Required evidence |
| --- | --- |
| Fresh packaged Electron install | Signed-in user enables full home; helper works without global CLI; both directions converge |
| Local-folder-first and Matrix-folder-first | Two distinct pairs configured through UI, visible identically in CLI |
| Full home plus project mapping | Atomic exclusion/child association; no duplicate writes or feedback loop |
| Direction enforcement | Source writes transfer, destination edits survive as conflicts, prohibited direction emits no write |
| Deletion | Defaults retain destination; explicit propagation affects only tracked unchanged destination files; offline root produces no tombstone |
| Reconnect and restart | Offline local/remote edits preserved; missed events recovered; queues survive process crash |
| Concurrent clients | Losing revision and staged upload cannot change committed bytes; delete/recreate races remain consistent |
| Runtime/account isolation | Two owners and two runtime slots never share manifest, bytes, peer events, cache or credential |
| Secrets and paths | Secret exclusions on both ends; symlink/mount/path traversal blocked; zero-byte file succeeds |
| Scale and failure | Large initial tree within caps, >100-file burst, near-limit/oversized file, throttling, disk full, permission failure, queue overflow; no false “up to date” |
| Background auth/lifecycle | Desktop quit/reboot/update; token refresh and revoke; no duplicate service or auth restart storm |
| Backup health | Enabled-but-stopped timer, failed upload, stale latest, missing object, mismatched storage fingerprint all surfaced |
| Backup recovery | Isolated fixture restore proves database rows/schema; file-sync UI never claims full-system backup |
| Packaging/release | Installed CLI, packaged Electron, platform and exact VPS bundle jointly pass a synthetic round trip |
| Surface parity | Shared remote states/copy and documented native capability limits, with real per-surface evidence |

For each failure injection, assert file hashes before/after, persisted revisions, pending intent, resulting UI/CLI state and emitted authorization scope. Do not settle for spies proving a function was called. Use isolated fixture directories, Postgres and a test object-store namespace; real R2 primitive tests use synthetic files only. A production database restore/download requires a separately authorized recovery operation.

## 8. Sol kickoff instructions

Implement this plan from a fresh manual worktree based on current origin/main. Revalidate the baseline because the investigation's original checkout was behind main. Read constitution/AGENTS and this document; begin at P0 and P1. Preserve unrelated user work. Track slice completion, tests, evidence and remaining gates in `tasks.md` or a focused checklist alongside this file.

Do not spend the first implementation pass polishing Settings before repairing scope/publication/reconciliation. Conversely, do not call the feature complete after backend repairs: P4 mappings, P6 packaged lifecycle and P7 usable UI are required. Keep production activation gated until the integrity tests and disposable-runtime evidence pass. If a platform primitive is uncertain, perform a bounded synthetic spike and record the result; never substitute assumptions for an end-to-end test.

Deferred follow-ups: cross-owner sharing (existing fail-closed behavior preserved), history/versioned file backup and whole-machine restore UI, Finder File Provider/on-demand placeholders, arbitrary mobile-folder watchers, remote control of another device's mappings, and automatic remote retention pruning. They are not prerequisites for the user flows defined here.
