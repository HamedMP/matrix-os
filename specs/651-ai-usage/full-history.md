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

The manifest seals every captured original with SHA-256 and performs an independent read-back. The index additionally supports a Postgres dump/restore verification. A successful copy, verified original-byte backup, completed index, and restored index are separate states. A dated recovery snapshot is not a promise of ongoing Mac synchronization. Desktop pairing and continuous original-archive transfer must reuse the canonical chat-import transfer boundary before automatic backup can be called deployed.

## Runtime wiring and authorization

| Boundary                                 | Authentication                                                | Scope                                                             |
| ---------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| GET /api/ai-usage                        | Existing verified gateway principal                           | Exact configured runtime owner; no path/query overrides           |
| GET /api/files/blob (fixed usage export) | Existing authenticated owner-file API                         | Dated, content-free report; signed-in owner must match envelope   |
| Native recent scan                       | Trusted main-frame IPC + current signed-in runtime generation | Fixed OS-user roots; explicitly partial fallback                  |
| Historical collector                     | Gateway owner-database dependency; owner configuration file   | Standard roots and validated backup roots inside the owner's home |
| Recovery CLI                             | Operator-selected private config + owner Postgres credentials | No public listener, no third-party upload                         |
| Loopback preview                         | Local developer access only                                   | Fixed report path; never expose publicly                          |

`system/ai-usage-sources.json` is owner configuration, not app data. It may add recovered machines with validated relative paths; symlink escapes and missing configured roots fail visibly. It does not let an HTTP client select arbitrary folders. Gateway indexing runs in the background, coalesces collection and drains on shutdown. Read responses identify backfill progress and incomplete coverage.

Desktop prefers the live historical endpoint. On an older runtime with a missing endpoint or a valid recent-only report, it can read `exports/ai-usage/latest.json` through the existing owner-file API. The recovery CLI writes this envelope atomically with the verified Clerk owner ID. The desktop validates its schema and owner, honors cancellation and labels it “Matrix backup snapshot”; authentication, service failures and malformed live responses do not trigger fallback. The export carries the index timestamp and is a dated snapshot, not continuous synchronization.

## Verification and release

Tests exercise real source bytes, large files, compressed archives, live-tail resume, replacement, owner isolation, mirrored endpoints, native counter resets, Postgres transactions, authenticated reads and the shared dashboard. The isolated Matrix database is development infrastructure and does not replace the installed runtime's owner database.

Native stack: POC → historical backend/recovery → shared full-history Settings. All layers share ENG-440. Product/engineering review is recommended for recovery and estimate semantics. Reviewed staging screenshots/recordings, surface parity, Slack evidence, current-head Greptile/CI and a companion documentation PR in FinnaAI/matrix-os-site remain required before release. No production deployment is implied by local recovery or previews.
