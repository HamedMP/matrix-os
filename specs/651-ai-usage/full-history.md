# Full history and recovery — ENG-440

## Scope and truth

The recent-file POC is a partial local sample. The durable collector indexes all discovered records, including large JSONL files, Zstandard-compressed Codex archives, and legacy Codex JSON sessions. It has no aggregate file, byte or event cutoff. Memory and database writes are bounded per batch; checkpoints continue across interruptions. Exception limits (record size, archive expansion, directory depth, malformed input) produce explicit incomplete coverage.

Original archives remain in owner-controlled backup files. Canonical usage observations and checkpoints live in owner Postgres through Kysely. Settings consumes aggregated reports rather than sending the entire event history to each renderer. Reports provide all available history, calendar years, recent periods, models, cache counters, sessions and price-estimate coverage. Blank dates never establish that no AI was used.

## Accounting

- Claude responses use native message IDs, with monotonically increasing streaming counters retained once.
- Newer Codex records use native response IDs and actual per-request counters. Cumulative mirrors are excluded; native requests survive cumulative resets and copied parent history.
- Older Codex cumulative endpoints are deduplicated across source machines and reconstructed in counter order. Decreases and ambiguous corrections remain incomplete observations, not invented requests.
- Reasoning tokens are already part of output; cached input is a disjoint category. Unknown pricing, cache TTLs and unsupported surcharges remain unpriced. API list-price estimates are not bills or subscription spend.
- Historical Claude activity caches are identified separately and never added over transcript counters.
- Existing Claude account exports supply conversation/message activity and years. They do not contain token or cost counters; account text is excluded from the report.
- Other preserved agent histories remain explicitly outside token totals until their native accounting formats are qualified.

## Persistence and recovery

Each source is keyed by owner, machine and hashed source identity. A checkpoint stores decoded newline offset, parser state, source fingerprint, committed prefix, size, issues and completion state. Source replacement/truncation resets that source's observations transactionally. Changed same-size files are reindexed. Compressed replay skips to the saved decoded offset; original bytes are never unpacked into a second transcript tree.

A batch locks its source, verifies the entire expected JSONB checkpoint, upserts bounded observations and advances the checkpoint in one transaction. Source-specific observations preserve provenance; canonical reads deduplicate native identities without conflating independent sessions. A bounded database cursor computes aggregate reports. Pools belong to existing gateway startup/shutdown; the worker aborts and drains before pool destruction.

## Backup boundary

The recovery workflow copies only history folders and explicitly selected account exports to the owner's Matrix computer over SSH. Authentication files, browser profiles, and provider credential tables are excluded. Existing OpenCode databases may be read through a read-only consistent snapshot of chat tables; no new SQLite persistence is introduced.

The manifest seals every captured original with SHA-256 and performs an independent read-back. The index additionally supports a Postgres dump/restore verification. A successful copy, verified original-byte backup, completed index, and restored index are separate states. A dated recovery snapshot is not a promise of ongoing Mac synchronization. The explicitly paired desktop development preview now transfers allowlisted originals over existing SSH access, verifies them, refreshes the owner Postgres index and atomically publishes the owner-bound report. This is a configured preview, not a general released pairing flow; the device-authenticated transport remains follow-up scope.

## Runtime wiring and authorization

| Boundary                                 | Authentication                                                | Scope                                                             |
| ---------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| GET /api/ai-usage                        | Existing verified gateway principal                           | Exact configured runtime owner; only a validated `timeZone` query          |
| GET /api/files/blob (fixed usage export) | Existing authenticated owner-file API                         | Dated, content-free report; signed-in owner must match envelope   |
| Native recent scan                       | Trusted main-frame IPC + current signed-in runtime generation | Fixed OS-user roots; explicitly partial fallback                  |
| Historical collector                     | Gateway owner-database dependency; owner configuration file   | Standard roots and validated backup roots inside the owner's home |
| Recovery CLI                             | Operator-selected private config + owner Postgres credentials | No public listener, no third-party upload                         |
| Loopback preview                         | Local developer access only                                   | Fixed report path; never expose publicly                          |

`system/ai-usage-sources.json` is owner configuration, not app data. It may add recovered machines with validated relative paths; symlink escapes and missing configured roots fail visibly. It does not let an HTTP client select arbitrary folders. Gateway indexing runs in the background, coalesces collection and drains on shutdown. Read responses identify backfill progress and incomplete coverage.

Desktop prefers the live historical endpoint. On an older runtime with a missing endpoint or a valid recent-only report, it can read `exports/ai-usage/latest.json` through the existing owner-file API. The recovery CLI writes this envelope atomically with the verified Clerk owner ID. The desktop validates its schema and owner, honors cancellation and labels it “Matrix backup snapshot”; authentication, service failures and malformed live responses do not trigger fallback. The export carries the index timestamp and is a dated snapshot, not continuous synchronization.

## Refresh behavior

Settings reads usage when opened, then automatically checks again one hour after each completed check. The manual Refresh usage action runs immediately and resets that timer. Reads never overlap; closing the owner/runtime scope aborts the active read and clears its timer. A failed check retains the last successful graph, shows a safe error and retries next hour. Refreshing preserves agent/date filters. Last checked describes when the report was fetched, not when original archives were synchronized; dated backups remain snapshots.

## Verification and release

Tests exercise real source bytes, large files, compressed archives, live-tail resume, replacement, owner isolation, mirrored endpoints, native counter resets, Postgres transactions, authenticated reads and the shared dashboard. The isolated Matrix database is development infrastructure and does not replace the installed runtime's owner database.

Native stack: POC → historical backend/recovery → shared full-history Settings. All layers share ENG-440. Product/engineering review is recommended for recovery and estimate semantics. Reviewed staging screenshots/recordings, surface parity, Slack evidence, current-head Greptile/CI and a companion documentation PR in FinnaAI/matrix-os-site remain required before release. No production deployment is implied by local recovery or previews.

## Paired Mac live sync

The native main process owns a single coalesced operation and hourly timer, including when Settings is closed. A mode-0600 operator pairing file binds the verified signed-in owner, runtime slot and gateway origin to an existing SSH alias and validated remote paths. No SSH credentials enter the renderer or get copied. The remote collector checks the configured export owner before any transfer. Unknown/unpaired computers remain explicitly unpaired; changing auth/computer cancels the operation, drains its child before a new session starts, and invalidates cached success.

Startup/hourly sync copies changed fixed-root history with rsync, preserving replaced versions and excluding symlinks, special files, credential files, browser profiles and account databases. It never deletes source files or passes renderer paths/commands to a shell. Connect/read deadlines and process cancellation bound work; shutdown terminates the native child and drains it. Transfers first enter unique incoming folders, using immutable hard-link bases for unchanged files. A remote file lock covers publishing those incoming files, capturing Matrix history, backup verification and indexing. Concurrent desktops wait for that lock instead of changing verified originals. Failed incoming folders expire after 24 hours and admission is capped. Only backups that are byte-for-byte prefixes of the new originals are redundant; those scratch copies are removed after successful verification/indexing. Replacements become permanent recovered archives and are indexed too.

Manual Refresh forces this pipeline, then reads its freshly published owner-bound export. Ordinary opening/hourly reads coalesce with an existing job and reuse a successful sync younger than an hour; they never substitute an unrelated live index for the paired collector. Failed transfers leave the last good graph visible and retry; complete success is reported only after copy, checksum read-back, index and publication finish. Large recoveries may take several minutes. The native timer stops with the app, and does not install a system daemon.

The browser cannot read this Mac directly. It displays the report refreshed by a running paired desktop. The current operator preview uses the isolated Matrix recovery database; this does not deploy an unreviewed production gateway or release desktop binaries.

## Calendar and coverage semantics

The 90-day calendar uses fixed square cells. Ranges longer than a year use separate year rows and retain every recovered date. Horizontal overflow is confined to each calendar, including on mobile. “All recovered coding history” describes available coding counters, not lifetime AI usage. The visible scope line gives the actual token-record range and identifies earlier web activity without counters. Missing/deleted records and unqualified agent formats remain gaps; no counts are inferred from conversation text.

## Review hardening (10 November 2026)

- **Rollout:** the gateway collector starts only with `MATRIX_AI_USAGE_HISTORY=true`. Without it the route answers 404 to the verified owner, and clients use the owner-bound export exactly as on older computers. Released desktop builds do not start paired Mac sync; development builds and `MATRIX_DESKTOP_AI_USAGE_SYNC=1` do.
- **One resolution on every surface:** Web Canvas, Web Desktop and Electron Desktop call the same loader: live index first, export only on 404, never after an authentication, service or validation failure, and never without a matching signed-in owner. A failed Mac transfer shows Matrix history with a "sync failed" label instead of an empty panel.
- **Timezone:** the viewer's IANA zone is the only request input; it is checked against the runtime's zone list. The paired refresh uses the Mac's zone; the CLI defaults to UTC.
- **Codex accounting outside Postgres:** recent scans, selected files and the CLI subtract native counter ranges from cumulative counters with the same rule as the SQL reader, so a drifting mirror is not counted twice. Counters that cannot be located are dropped and counted as incomplete.
- **Report cost:** one report per timezone is built at a time, shared by simultaneous readers, reused for 60 seconds and discarded when indexing finishes. Only one build runs at a time across timezones, and waiting builds are capped. The report query has a 60-second statement timeout.
- **Coverage truth:** an absent standard agent folder is not a gap; a missing configured backup root and any unreadable file are. Events dated outside the report range, and timestamps that are not offset-qualified ISO 8601, count as incomplete records.
- **Backup seal:** a new manifest is written only if every previously sealed original still exists, byte-identical anywhere in the backup or as the leading bytes of the same file. Otherwise the run fails and the previous seal is kept.
- **Locking and cancellation:** `refresh.ts` takes `.refresh.lock` itself, so manual and desktop runs serialize. The desktop runs it with a forced terminal so cancelling or disconnecting stops the remote job.
- **Known limit:** the recovery config still has two owner fields (`owner` keys database rows, `desktopExport.ownerId` binds the export). The preview data uses different values, so unifying them needs a row re-key and is not done here.
